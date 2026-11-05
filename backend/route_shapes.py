"""
Road-following shapes for bus routes, so the app's live 3D buses drive along
the streets instead of cutting straight lines through blocks between stops.

LTA publishes each service's stops in order (BusRoutes) but not the road
geometry between them. We derive it once per service direction by asking
OSRM (OpenStreetMap routing, the public demo server) for a driving route
through the stops, then store it in the DB for good — bus routes rarely
change, and a re-sync of BusRoutes doesn't invalidate shapes (stop codes are
stable; a stale shape only means a slightly wrong path).

GET /api/routes/{service_no}/shape
  200 {"service_no", "directions": [{"direction", "coords": [[lat, lng], …],
                                      "stop_index": [i, …]}]}
      stop_index[k] = index in coords of the k-th stop of that direction.
  202 {"pending": true}   first request: computing in the background; the
                          app keeps its straight-line path and asks again.

Being polite to the free OSRM server: one request at a time, ≥ 1.1 s apart,
computed only for services people actually open, and cached forever.

Legs where OSRM's road distance is far longer than the straight line (it
snapped a stop to the wrong carriageway and looped, or the bus uses a
bus-only road the car profile can't take) fall back to a straight segment.
"""

import asyncio
import json
import logging
import math
import time

import httpx
from fastapi import APIRouter, HTTPException, Path
from fastapi.responses import JSONResponse

from database import BusRoute, BusStop, RouteShape, SessionLocal

logger = logging.getLogger(__name__)
router = APIRouter()

OSRM = "https://router.project-osrm.org/route/v1/driving/"
CHUNK = 40              # waypoints per OSRM request (consecutive chunks share one stop)
SNAP_M = 100            # max distance from a stop to the road it's snapped to
MIN_GAP = 1.1           # seconds between OSRM requests

_client = httpx.AsyncClient(timeout=25, headers={"User-Agent": "sg-bus-ai (alstonshi.com/bus)"})
_queue: "asyncio.Queue[str]" = asyncio.Queue()
_pending: set[str] = set()
_failed: dict[str, float] = {}     # service → time of last failure (retry after 10 min)
_worker: asyncio.Task | None = None
_last_call = 0.0


def _dist(a, b) -> float:
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6_371_000 * 2 * math.asin(min(1.0, math.sqrt(h)))


def _stops_for(service_no: str) -> dict[int, list[tuple[str, float, float]]]:
    db = SessionLocal()
    try:
        rows = (db.query(BusRoute.direction, BusRoute.stop_sequence, BusRoute.bus_stop_code, BusStop.latitude, BusStop.longitude)
                .outerjoin(BusStop, BusStop.bus_stop_code == BusRoute.bus_stop_code)
                .filter(BusRoute.service_no == service_no)
                .order_by(BusRoute.direction, BusRoute.stop_sequence).all())
    finally:
        db.close()
    out: dict[int, list] = {}
    for d, _, code, lat, lng in rows:
        if lat and lng:
            out.setdefault(d, []).append((code, lat, lng))
    return out


async def _osrm(points: list[tuple[float, float]]) -> list[dict] | None:
    """Per-leg geometry for a chain of (lat, lng) waypoints, or None."""
    global _last_call
    wait = MIN_GAP - (time.monotonic() - _last_call)
    if wait > 0:
        await asyncio.sleep(wait)
    _last_call = time.monotonic()
    coords = ";".join(f"{lng:.6f},{lat:.6f}" for lat, lng in points)
    params = {"overview": "false", "steps": "true", "geometries": "geojson",
              "continue_straight": "true", "radiuses": ";".join([str(SNAP_M)] * len(points))}
    try:
        r = await _client.get(OSRM + coords, params=params)
        d = r.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("OSRM request failed: %s", exc)
        return None
    if d.get("code") != "Ok" or not d.get("routes"):
        logger.info("OSRM: %s %s", d.get("code"), d.get("message", ""))
        return None
    legs = []
    for leg in d["routes"][0]["legs"]:
        pts = []
        for st in leg.get("steps", []):
            for lng, lat in st["geometry"]["coordinates"]:
                if not pts or (pts[-1][0], pts[-1][1]) != (lat, lng):
                    pts.append([round(lat, 6), round(lng, 6)])
        legs.append({"distance": leg.get("distance", 0), "pts": pts})
    return legs


async def _build_direction(stops: list[tuple[str, float, float]]) -> tuple[list, list, int]:
    pts_ll = [(lat, lng) for _, lat, lng in stops]
    legs: list[dict | None] = []
    k = 0
    while k < len(pts_ll) - 1:
        chunk = pts_ll[k:k + CHUNK]
        res = await _osrm(chunk)
        legs.extend(res if res and len(res) == len(chunk) - 1 else [None] * (len(chunk) - 1))
        k += len(chunk) - 1
    coords: list[list[float]] = []
    stop_index: list[int] = []
    straight = 0
    for j in range(len(pts_ll) - 1):
        a, b = pts_ll[j], pts_ll[j + 1]
        direct = _dist(a, b)
        leg = legs[j]
        if leg is None or len(leg["pts"]) < 2 or leg["distance"] > max(3 * direct, direct + 700):
            seg = [[a[0], a[1]], [b[0], b[1]]]       # detour or no route: straight line
            straight += 1
        else:
            seg = leg["pts"]
        if coords and coords[-1] == seg[0]:
            seg = seg[1:]
        stop_index.append(len(coords))
        coords.extend(seg)
    stop_index.append(len(coords) - 1)
    return coords, stop_index, straight


async def _compute(service_no: str) -> None:
    by_dir = _stops_for(service_no)
    if not by_dir:
        raise ValueError("no stops")
    results = {}
    for d, stops in by_dir.items():
        if len(stops) >= 2:
            results[d] = await _build_direction(stops)
    if not results:
        raise ValueError("too few stops")
    if all(st == len(by_dir[d]) - 1 for d, (_, _, st) in results.items()):
        raise RuntimeError("OSRM gave nothing usable")   # don't cache an all-straight shape
    db = SessionLocal()
    try:
        db.query(RouteShape).filter_by(service_no=service_no).delete()
        for d, (coords, idx, straight) in results.items():
            db.add(RouteShape(service_no=service_no, direction=d, coords=json.dumps(coords, separators=(",", ":")),
                              stop_index=json.dumps(idx), straight_legs=straight))
        db.commit()
    finally:
        db.close()
    logger.info("Route shape for %s: %s", service_no,
                ", ".join(f"dir {d} {len(c)} pts ({s} straight legs)" for d, (c, _, s) in results.items()))


async def _run() -> None:
    while True:
        svc = await _queue.get()
        try:
            await _compute(svc)
            _failed.pop(svc, None)
        except Exception as exc:  # noqa: BLE001
            _failed[svc] = time.monotonic()
            logger.warning("Route shape for %s failed: %s", svc, exc)
        finally:
            _pending.discard(svc)


def _enqueue(svc: str) -> None:
    global _worker
    if svc in _pending or time.monotonic() - _failed.get(svc, -1e9) < 600:
        return
    _pending.add(svc)
    _queue.put_nowait(svc)
    if _worker is None or _worker.done():
        _worker = asyncio.get_event_loop().create_task(_run())


@router.get("/routes/{service_no}/shape")
async def route_shape(service_no: str = Path(..., max_length=8, pattern=r"^[0-9A-Za-z]{1,8}$")):
    svc = service_no.upper()
    db = SessionLocal()
    try:
        rows = db.query(RouteShape).filter_by(service_no=svc).order_by(RouteShape.direction).all()
    finally:
        db.close()
    if rows:
        return {"service_no": svc, "directions": [
            {"direction": r.direction, "coords": json.loads(r.coords), "stop_index": json.loads(r.stop_index)} for r in rows]}
    if not _stops_for(svc):
        raise HTTPException(status_code=404, detail="Unknown service")
    _enqueue(svc)
    return JSONResponse(status_code=202, content={"pending": True})
