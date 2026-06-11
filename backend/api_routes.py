"""
FastAPI router.

Endpoints
---------
GET  /api/arrivals/{stop_code}       Real-time arrivals + AI predictions
GET  /api/stats/{stop_code}          Delay stats for charts (by service, hour, day)
GET  /api/stops/search               Search bus stops by code or name
GET  /api/stops/nearby               Bus stops nearest to a lat/lng coordinate
GET  /api/stops/{stop_code}          Get single bus stop info
POST /api/stops/sync                 Re-sync bus stop directory from LTA
POST /api/routes/sync                Sync full bus route graph from LTA
GET  /api/journey/plan               Plan A→B journey with live timings
GET  /api/model/status               ML model metadata
POST /api/model/retrain              Trigger an immediate model retrain
POST /api/monitor/{stop_code}        Add a stop to the background collector
DELETE /api/monitor/{stop_code}      Remove a stop from the background collector
GET  /api/monitor                    List all monitored stops
GET  /api/data                       Database overview for the Data tab
"""

import asyncio
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from config import LTA_API_KEY, LTA_ARRIVAL_ENDPOINT, LTA_BASE_URL, DATABASE_URL
from data_collector import persist_arrival_payload
from database import BusArrivalRecord, BusRoute, BusStop, BusTracking, MonitoredStop, get_db
from ml_model import model as global_model

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/health")
def health_check():
    return {"status": "ok"}


# ── Internal helpers ─────────────────────────────────────────────

def _parse_lta_dt(iso_str: str | None) -> datetime | None:
    if not iso_str:
        return None
    try:
        return datetime.fromisoformat(iso_str).astimezone(timezone.utc).replace(tzinfo=None)
    except Exception:
        return None


def _fmt_minutes(dt: datetime | None) -> str | None:
    """Return human-readable wait string, e.g. 'Arr', '3 min', '12 min'."""
    if dt is None:
        return None
    now   = datetime.utcnow()
    secs  = (dt - now).total_seconds()
    if secs < 60:
        return "Arr"
    mins = int(secs // 60)
    return f"{mins} min"


async def _call_lta(stop_code: str) -> dict:
    headers = {"AccountKey": LTA_API_KEY}
    params  = {"BusStopCode": stop_code}
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(LTA_ARRIVAL_ENDPOINT, headers=headers, params=params)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 401:
                raise HTTPException(status_code=401,
                                    detail="Invalid LTA API key. Set LTA_API_KEY in .env")
            raise HTTPException(status_code=502, detail=f"LTA API error: {exc}")
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Could not reach LTA API: {exc}")


# ── Arrivals ──────────────────────────────────────────────────────

@router.get("/arrivals/{stop_code}")
async def get_arrivals(
    stop_code: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> dict:
    """
    Fetch real-time arrivals from LTA and augment each bus slot with an
    AI-adjusted prediction.

    Response shape
    --------------
    {
      "bus_stop_code": "83139",
      "fetched_at": "2024-01-15T10:30:00",
      "services": [
        {
          "service_no": "15",
          "operator": "GAS",
          "buses": [
            {
              "slot": 1,
              "load": "SEA",
              "type": "SD",
              "feature": "WAB",
              "api_arrival": "2024-01-15T10:33:45",
              "api_wait_min": "3 min",
              "ai_arrival":  "2024-01-15T10:34:30",
              "ai_wait_min": "4 min",
              "ai_adjustment_sec": 45,
              "monitored": true
            },
            ...
          ]
        }
      ]
    }
    """
    data     = await _call_lta(stop_code)
    services = data.get("Services", [])
    now      = datetime.utcnow()
    sgt      = now + timedelta(hours=8)  # model features use Singapore time

    # Passive collection: every visitor query doubles as a training snapshot,
    # at zero extra LTA API cost. Runs after the response is sent.
    background_tasks.add_task(persist_arrival_payload, stop_code, services, now)

    result_services = []
    for svc in services:
        service_no = svc.get("ServiceNo", "")
        buses = []
        for slot_idx, slot_key in enumerate(["NextBus", "NextBus2", "NextBus3"], start=1):
            bus = svc.get(slot_key) or {}
            estimated = _parse_lta_dt(bus.get("EstimatedArrival"))
            if estimated is None:
                continue

            load     = bus.get("Load", "SEA")
            bus_type = bus.get("Type", "SD")

            # AI prediction
            adjustment_sec = global_model.predict(
                hour        = sgt.hour,
                day_of_week = sgt.weekday(),
                bus_load    = load,
                bus_type    = bus_type,
                service_no  = service_no,
                stop_code   = stop_code,
            )

            # Confidence-aware scaling: the closer the bus, the more accurate
            # the LTA GPS estimate, so shrink the model's correction.
            wait_sec = (estimated - now).total_seconds()
            if wait_sec <= 120:
                adjustment_sec *= 0.25
            elif wait_sec <= 300:
                adjustment_sec *= 0.6
            # A bus can't have already arrived: an early-correction can never
            # remove more than half the remaining wait.
            if wait_sec > 0:
                adjustment_sec = max(-0.5 * wait_sec, adjustment_sec)
            else:
                adjustment_sec = 0.0

            ai_arrival = estimated + timedelta(seconds=adjustment_sec)

            buses.append({
                "slot":               slot_idx,
                "load":               load,
                "type":               bus_type,
                "feature":            bus.get("Feature"),
                "monitored":          bool(bus.get("Monitored", 0)),
                "api_arrival":        estimated.isoformat(),
                "api_wait_min":       _fmt_minutes(estimated),
                "ai_arrival":         ai_arrival.isoformat(),
                "ai_wait_min":        _fmt_minutes(ai_arrival),
                "ai_adjustment_sec":  round(adjustment_sec),
            })

        if buses:
            result_services.append({
                "service_no": service_no,
                "operator":   svc.get("Operator", ""),
                "buses":      buses,
            })

    return {
        "bus_stop_code": stop_code,
        "fetched_at":    now.isoformat(),
        "services":      result_services,
    }


# ── Statistics ────────────────────────────────────────────────

@router.get("/stats/{stop_code}")
def get_stats(stop_code: str, db: Session = Depends(get_db)) -> dict:
    """
    Return aggregated delay statistics for a bus stop, suitable for Chart.js.

    Covers the last 30 days of collected data.
    """
    cutoff = datetime.utcnow() - timedelta(days=30)
    base_q = (
        db.query(BusArrivalRecord)
        .filter(
            BusArrivalRecord.bus_stop_code == stop_code,
            BusArrivalRecord.delay_seconds.isnot(None),
            BusArrivalRecord.collection_time >= cutoff,
        )
    )

    total_rows = base_q.count()

    # ── By service ──────────────────────────────────────────────────────
    by_service_q = (
        base_q
        .with_entities(
            BusArrivalRecord.bus_service,
            func.avg(BusArrivalRecord.delay_seconds).label("avg_delay"),
            func.count().label("count"),
        )
        .group_by(BusArrivalRecord.bus_service)
        .order_by(func.avg(BusArrivalRecord.delay_seconds).desc())
        .limit(15)
        .all()
    )
    by_service = [
        {
            "service": r.bus_service,
            "avg_delay_sec": round(r.avg_delay, 1),
            "count": r.count,
        }
        for r in by_service_q
    ]

    # ── By hour ─────────────────────────────────────────────────────────
    by_hour_q = (
        base_q
        .with_entities(
            BusArrivalRecord.hour_of_day,
            func.avg(BusArrivalRecord.delay_seconds).label("avg_delay"),
        )
        .group_by(BusArrivalRecord.hour_of_day)
        .order_by(BusArrivalRecord.hour_of_day)
        .all()
    )
    by_hour = {str(r.hour_of_day): round(r.avg_delay, 1) for r in by_hour_q}
    # Fill missing hours with None
    by_hour_full = [by_hour.get(str(h)) for h in range(24)]

    # ── Trend (daily average over last 14 days) ──────────────────────────────
    trend_q = (
        base_q
        .filter(BusArrivalRecord.collection_time >= datetime.utcnow() - timedelta(days=14))
        .with_entities(
            func.date(BusArrivalRecord.collection_time).label("day"),
            func.avg(BusArrivalRecord.delay_seconds).label("avg_delay"),
        )
        .group_by(func.date(BusArrivalRecord.collection_time))
        .order_by(func.date(BusArrivalRecord.collection_time))
        .all()
    )
    trend = [{"date": str(r.day), "avg_delay_sec": round(r.avg_delay, 1)} for r in trend_q]

    return {
        "bus_stop_code":  stop_code,
        "total_records":  total_rows,
        "by_service":     by_service,
        "by_hour":        by_hour_full,
        "trend":          trend,
    }


# ── ML model ──────────────────────────────────────────────────────────

@router.get("/model/status")
def model_status() -> dict:
    return global_model.status()


@router.post("/model/retrain")
async def retrain_model() -> dict:
    """Trigger an immediate model retrain from DB data."""
    try:
        global_model.retrain_from_db()
        return {"status": "ok", **global_model.status()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── Bus stop directory ────────────────────────────────────────────────

@router.get("/stops/search")
def search_stops(
    q: str = Query(..., min_length=1, description="Stop code or partial name/road"),
    limit: int = Query(10, le=30),
    db: Session = Depends(get_db),
) -> dict:
    """
    Search bus stops by code prefix OR partial description/road name.
    Returns up to `limit` results ordered by relevance (exact code match first).
    """
    q = q.strip()
    results = (
        db.query(BusStop)
        .filter(
            or_(
                BusStop.bus_stop_code.ilike(f"{q}%"),
                BusStop.description.ilike(f"%{q}%"),
                BusStop.road_name.ilike(f"%{q}%"),
            )
        )
        .order_by(
            # Exact code matches first
            (BusStop.bus_stop_code == q).desc(),
            BusStop.bus_stop_code,
        )
        .limit(limit)
        .all()
    )
    return {
        "query": q,
        "results": [
            {
                "bus_stop_code": s.bus_stop_code,
                "description":   s.description,
                "road_name":     s.road_name,
                "latitude":      s.latitude,
                "longitude":     s.longitude,
            }
            for s in results
        ],
    }


@router.get("/stops/nearby")
def nearby_stops(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    limit: int = Query(10, le=20),
    db: Session = Depends(get_db),
) -> dict:
    """Bus stops nearest to a coordinate, with distance in metres."""
    import math as _math

    # Coarse bounding box (~2.2 km) first, exact haversine after.
    box = 0.02
    candidates = (
        db.query(BusStop)
        .filter(
            BusStop.latitude.isnot(None),
            BusStop.latitude.between(lat - box, lat + box),
            BusStop.longitude.between(lng - box, lng + box),
        )
        .all()
    )

    def haversine_m(lat1, lng1, lat2, lng2):
        r = 6371000.0
        p1, p2 = _math.radians(lat1), _math.radians(lat2)
        dp = _math.radians(lat2 - lat1)
        dl = _math.radians(lng2 - lng1)
        a = _math.sin(dp / 2) ** 2 + _math.cos(p1) * _math.cos(p2) * _math.sin(dl / 2) ** 2
        return 2 * r * _math.asin(_math.sqrt(a))

    ranked = sorted(
        (
            (haversine_m(lat, lng, s.latitude, s.longitude), s)
            for s in candidates
        ),
        key=lambda t: t[0],
    )[:limit]

    return {
        "results": [
            {
                "bus_stop_code": s.bus_stop_code,
                "description":   s.description,
                "road_name":     s.road_name,
                "distance_m":    round(dist),
            }
            for dist, s in ranked
        ],
    }


@router.get("/stops/{stop_code}")
def get_stop(stop_code: str, db: Session = Depends(get_db)) -> dict:
    stop = db.query(BusStop).filter_by(bus_stop_code=stop_code).first()
    if not stop:
        return {"bus_stop_code": stop_code, "description": None, "road_name": None}
    return {
        "bus_stop_code": stop.bus_stop_code,
        "description":   stop.description,
        "road_name":     stop.road_name,
        "latitude":      stop.latitude,
        "longitude":     stop.longitude,
    }


@router.post("/stops/sync")
async def sync_stops() -> dict:
    """Fetch the full bus stop directory from LTA and upsert into the DB."""
    headers = {"AccountKey": LTA_API_KEY}
    url     = f"{LTA_BASE_URL}/BusStops"
    total   = 0
    skip    = 0

    async with httpx.AsyncClient(timeout=30) as client:
        db = get_db().__next__()  # raw session for bulk upsert
        try:
            while True:
                resp = await client.get(url, headers=headers, params={"$skip": skip})
                resp.raise_for_status()
                stops = resp.json().get("value", [])
                if not stops:
                    break
                for s in stops:
                    code = s.get("BusStopCode", "")
                    if not code:
                        continue
                    existing = db.query(BusStop).filter_by(bus_stop_code=code).first()
                    if existing:
                        existing.description = s.get("Description")
                        existing.road_name   = s.get("RoadName")
                        existing.latitude    = s.get("Latitude")
                        existing.longitude   = s.get("Longitude")
                        existing.synced_at   = datetime.utcnow()
                    else:
                        db.add(BusStop(
                            bus_stop_code = code,
                            description   = s.get("Description"),
                            road_name     = s.get("RoadName"),
                            latitude      = s.get("Latitude"),
                            longitude     = s.get("Longitude"),
                        ))
                    total += 1
                db.commit()
                skip += 500
                if len(stops) < 500:
                    break
        finally:
            db.close()

    return {"status": "ok", "stops_synced": total}


# ── Monitored stops ──────────────────────────────────────────────────

@router.get("/monitor")
def list_monitored(db: Session = Depends(get_db)) -> dict:
    stops = db.query(MonitoredStop).filter_by(is_active=True).all()
    return {"stops": [s.bus_stop_code for s in stops]}


@router.post("/monitor/{stop_code}")
def add_monitored(stop_code: str, db: Session = Depends(get_db)) -> dict:
    existing = db.query(MonitoredStop).filter_by(bus_stop_code=stop_code).first()
    if existing:
        existing.is_active = True
    else:
        db.add(MonitoredStop(bus_stop_code=stop_code))
    db.commit()
    return {"status": "added", "bus_stop_code": stop_code}


@router.delete("/monitor/{stop_code}")
def remove_monitored(stop_code: str, db: Session = Depends(get_db)) -> dict:
    row = db.query(MonitoredStop).filter_by(bus_stop_code=stop_code).first()
    if row:
        row.is_active = False
        db.commit()
    return {"status": "removed", "bus_stop_code": stop_code}


# ── Route graph & journey planner ────────────────────────────────────────

class _RouteGraph:
    """In-memory graph of the Singapore bus network, lazily loaded from DB."""

    MAX_STOPS = 50  # max stops per leg when searching

    def __init__(self):
        self._loaded = False
        self._service_stops: dict[tuple, list[tuple]] = {}  # (svc,dir) -> [(seq,code,dist)]
        self._stop_routes: dict[str, list[tuple]] = {}      # code -> [(svc,dir,seq)]

    def load(self, db: Session) -> None:
        svc_stops: dict[tuple, list] = defaultdict(list)
        stop_routes: dict[str, list] = defaultdict(list)
        rows = (
            db.query(BusRoute)
            .order_by(BusRoute.service_no, BusRoute.direction, BusRoute.stop_sequence)
            .all()
        )
        for r in rows:
            key = (r.service_no, r.direction)
            svc_stops[key].append((r.stop_sequence, r.bus_stop_code, r.distance_km))
            stop_routes[r.bus_stop_code].append((r.service_no, r.direction, r.stop_sequence))
        self._service_stops = dict(svc_stops)
        self._stop_routes = dict(stop_routes)
        self._loaded = True

    def invalidate(self):
        self._loaded = False

    def find_journeys(self, from_stop: str, to_stop: str, db: Session) -> list[dict]:
        if not self._loaded:
            self.load(db)
        if not self._service_stops:
            return []

        N = self.MAX_STOPS
        options: list[dict] = []

        # ── Direct (no transfer) ─────────────────────────────────
        for svc, dir_, from_seq in self._stop_routes.get(from_stop, []):
            for seq, code, _ in self._service_stops.get((svc, dir_), []):
                if seq <= from_seq:
                    continue
                sc = seq - from_seq
                if sc > N:
                    break
                if code == to_stop:
                    options.append({
                        "legs": [{"service": svc, "direction": dir_,
                                  "from_stop": from_stop, "to_stop": to_stop,
                                  "stops_count": sc}],
                        "transfers": 0, "total_stops": sc,
                    })

        # ── 1-transfer ───────────────────────────────────────────
        # Stops reachable from from_stop on a single leg
        reachable: dict[str, tuple] = {}
        for svc1, dir1, from_seq1 in self._stop_routes.get(from_stop, []):
            for seq, code, _ in self._service_stops.get((svc1, dir1), []):
                if seq <= from_seq1:
                    continue
                sc1 = seq - from_seq1
                if sc1 > N:
                    break
                if code not in reachable or reachable[code][2] > sc1:
                    reachable[code] = (svc1, dir1, sc1)

        # Stops that can reach to_stop on a single leg
        can_reach: dict[str, tuple] = {}
        for svc2, dir2, to_seq2 in self._stop_routes.get(to_stop, []):
            for seq, code, _ in reversed(self._service_stops.get((svc2, dir2), [])):
                if seq >= to_seq2:
                    continue
                sc2 = to_seq2 - seq
                if sc2 > N:
                    break
                if code not in can_reach or can_reach[code][2] > sc2:
                    can_reach[code] = (svc2, dir2, sc2)

        for xfer in set(reachable) & set(can_reach) - {from_stop, to_stop}:
            svc1, dir1, sc1 = reachable[xfer]
            svc2, dir2, sc2 = can_reach[xfer]
            if svc1 == svc2 and dir1 == dir2:
                continue  # same service — no real transfer
            total = sc1 + sc2
            options.append({
                "legs": [
                    {"service": svc1, "direction": dir1,
                     "from_stop": from_stop, "to_stop": xfer, "stops_count": sc1},
                    {"service": svc2, "direction": dir2,
                     "from_stop": xfer, "to_stop": to_stop, "stops_count": sc2},
                ],
                "transfers": 1, "total_stops": total,
            })

        options.sort(key=lambda o: (o["transfers"], o["total_stops"]))

        # Deduplicate by (service chain)
        seen: set[tuple] = set()
        deduped: list[dict] = []
        for opt in options:
            key = tuple(
                f"{l['service']}-{l['direction']}-{l['from_stop']}-{l['to_stop']}"
                for l in opt["legs"]
            )
            if key not in seen:
                seen.add(key)
                deduped.append(opt)

        return deduped[:5]


_route_graph = _RouteGraph()


@router.post("/routes/sync")
async def sync_routes() -> dict:
    """Sync the full LTA bus route graph (all services × all stops) into the DB."""
    headers = {"AccountKey": LTA_API_KEY}
    url = f"{LTA_BASE_URL}/BusRoutes"
    total = 0
    skip = 0

    async with httpx.AsyncClient(timeout=30) as client:
        db_raw = get_db().__next__()
        try:
            while True:
                resp = await client.get(url, headers=headers, params={"$skip": skip})
                resp.raise_for_status()
                rows = resp.json().get("value", [])
                if not rows:
                    break
                for r in rows:
                    svc = r.get("ServiceNo", "")
                    direction = r.get("Direction", 1)
                    seq = r.get("StopSequence", 0)
                    code = r.get("BusStopCode", "")
                    if not svc or not code:
                        continue
                    existing = db_raw.query(BusRoute).filter_by(
                        service_no=svc, direction=direction, stop_sequence=seq,
                    ).first()
                    if existing:
                        existing.bus_stop_code = code
                        existing.distance_km = r.get("Distance")
                        existing.synced_at = datetime.utcnow()
                    else:
                        db_raw.add(BusRoute(
                            service_no=svc, direction=direction,
                            stop_sequence=seq, bus_stop_code=code,
                            distance_km=r.get("Distance"),
                        ))
                    total += 1
                db_raw.commit()
                skip += 500
                if len(rows) < 500:
                    break
        finally:
            db_raw.close()

    _route_graph.invalidate()
    return {"status": "ok", "routes_synced": total}


@router.get("/journey/plan")
async def plan_journey(
    from_code: str = Query(..., description="Origin bus stop code"),
    to_code: str = Query(..., description="Destination bus stop code"),
    db: Session = Depends(get_db),
) -> dict:
    """
    Plan a journey between two bus stops.

    Returns up to 3 route options with live LTA arrival times and AI adjustments.
    Each option shows legs (bus rides), wait times, estimated ride times, and
    a last-bus warning when a service is running its final departure.
    """
    if from_code == to_code:
        raise HTTPException(status_code=400, detail="Origin and destination must be different stops.")

    route_count = db.query(func.count(BusRoute.id)).scalar() or 0
    if not route_count:
        raise HTTPException(
            status_code=503,
            detail="Route data not synced yet. Call POST /api/routes/sync first.",
        )

    def stop_info(code: str) -> dict:
        s = db.query(BusStop).filter_by(bus_stop_code=code).first()
        return {
            "code": code,
            "name": s.description if s else code,
            "road": s.road_name if s else "",
        }

    from_info = stop_info(from_code)
    to_info   = stop_info(to_code)

    raw_options = _route_graph.find_journeys(from_code, to_code, db)
    if not raw_options:
        return {
            "from": from_info, "to": to_info, "options": [],
            "message": "No direct or 1-transfer route found. Try nearby stops.",
        }

    now = datetime.utcnow()
    sgt = now + timedelta(hours=8)

    # Fetch live arrivals for all unique boarding stops (concurrent)
    unique_boards = {leg["from_stop"] for opt in raw_options[:3] for leg in opt["legs"]}

    async def _fetch(code: str) -> tuple[str, dict | None]:
        try:
            return code, await _call_lta(code)
        except Exception:
            return code, None

    fetched = await asyncio.gather(*[_fetch(c) for c in unique_boards])
    arrivals_cache: dict[str, dict | None] = dict(fetched)

    def enrich_leg(leg: dict, earliest_board: datetime | None = None) -> dict:
        svc      = leg["service"]
        board    = leg["from_stop"]
        alight   = leg["to_stop"]
        sc       = leg["stops_count"]
        est_ride = max(2, sc * 2)  # ~2 min per stop

        wait_min         = None
        lta_arrival      = None
        ai_arrival_str   = None
        ai_adj_sec       = 0
        buses_available  = 0
        is_last_bus      = False
        is_transfer_wait = earliest_board is not None

        board_ref = earliest_board or now

        lta_data = arrivals_cache.get(board)
        if lta_data:
            for sv in lta_data.get("Services", []):
                if sv.get("ServiceNo") != svc:
                    continue
                for slot_key in ["NextBus", "NextBus2", "NextBus3"]:
                    b = sv.get(slot_key) or {}
                    if b.get("EstimatedArrival"):
                        buses_available += 1

                # Find first catchable bus at or after board_ref (90s grace period)
                chosen_bus, chosen_est = None, None
                for slot_key in ["NextBus", "NextBus2", "NextBus3"]:
                    b = sv.get(slot_key) or {}
                    est = _parse_lta_dt(b.get("EstimatedArrival"))
                    if est and est >= board_ref - timedelta(seconds=90):
                        chosen_bus, chosen_est = b, est
                        break

                if chosen_est:
                    wait_sec = (chosen_est - board_ref).total_seconds()
                    wait_min = max(0, int(wait_sec / 60))

                    adj = global_model.predict(
                        hour=sgt.hour, day_of_week=sgt.weekday(),
                        bus_load=chosen_bus.get("Load", "SEA"),
                        bus_type=chosen_bus.get("Type", "SD"),
                        service_no=svc, stop_code=board,
                    )
                    if wait_sec <= 120:
                        adj *= 0.25
                    elif wait_sec <= 300:
                        adj *= 0.6
                    if wait_sec > 0:
                        adj = max(-0.5 * wait_sec, adj)
                    ai_adj_sec = round(adj)

                    lta_arrival    = chosen_est.isoformat()
                    ai_arrival_str = (chosen_est + timedelta(seconds=adj)).isoformat()

                is_last_bus = buses_available <= 1
                break

        brd = db.query(BusStop).filter_by(bus_stop_code=board).first()
        alt = db.query(BusStop).filter_by(bus_stop_code=alight).first()

        return {
            "service_no":        svc,
            "direction":         leg["direction"],
            "board_stop":        {"code": board,  "name": brd.description if brd else board,  "road": brd.road_name if brd else ""},
            "alight_stop":       {"code": alight, "name": alt.description if alt else alight, "road": alt.road_name if alt else ""},
            "stops_count":       sc,
            "est_ride_min":      est_ride,
            "wait_min":          wait_min,
            "lta_arrival":       lta_arrival,
            "ai_arrival":        ai_arrival_str,
            "ai_adj_sec":        ai_adj_sec,
            "buses_available":   buses_available,
            "is_last_bus_soon":  is_last_bus,
            "is_transfer_wait":  is_transfer_wait,
        }

    options = []
    for raw in raw_options[:3]:
        legs = []
        cumulative_mins = 0
        for i, raw_leg in enumerate(raw["legs"]):
            earliest = None if i == 0 else now + timedelta(minutes=cumulative_mins + 2)
            leg = enrich_leg(raw_leg, earliest)
            legs.append(leg)
            cumulative_mins += (leg.get("wait_min") or 5) + leg["est_ride_min"]
        total_min = sum(
            (l.get("wait_min") or 5) + l["est_ride_min"] for l in legs
        ) + raw["transfers"] * 3
        options.append({
            "transfers":           raw["transfers"],
            "total_est_min":       total_min,
            "has_last_bus_warning": any(l["is_last_bus_soon"] for l in legs),
            "legs":                legs,
        })

    return {"from": from_info, "to": to_info, "options": options}


# ── Multimodal journey planner ───────────────────────────────────────────────

@router.get("/journey/multimodal")
async def plan_multimodal(
    from_lat:  float = Query(..., ge=-90,   le=90),
    from_lng:  float = Query(..., ge=-180,  le=180),
    to_lat:    float = Query(..., ge=-90,   le=90),
    to_lng:    float = Query(..., ge=-180,  le=180),
    from_name: str   = Query("Origin"),
    to_name:   str   = Query("Destination"),
    db: Session = Depends(get_db),
) -> dict:
    """
    Plan a journey between two coordinates using bus and/or MRT.

    Finds up to 3 options:
      • Bus-only   – nearest stops each end, existing BFS
      • MRT route  – walk to nearest station, ride, walk to destination
    Walk speed assumed 80 m/min.
    """
    import math as _math
    from mrt_data import nearest_station, find_mrt_path, mrt_wait_min, LINE_DISPLAY, STATIONS

    WALK_MPS = 80.0  # metres per minute

    def _haversine(lat1, lng1, lat2, lng2) -> float:
        r = 6371000.0
        p1, p2 = _math.radians(lat1), _math.radians(lat2)
        dp = _math.radians(lat2 - lat1)
        dl = _math.radians(lng2 - lng1)
        a = _math.sin(dp / 2) ** 2 + _math.cos(p1) * _math.cos(p2) * _math.sin(dl / 2) ** 2
        return 2 * r * _math.asin(_math.sqrt(a))

    def _nearest_bus_stop(lat, lng):
        box = 0.02
        candidates = (
            db.query(BusStop)
            .filter(
                BusStop.latitude.isnot(None),
                BusStop.latitude.between(lat - box, lat + box),
                BusStop.longitude.between(lng - box, lng + box),
            ).all()
        )
        if not candidates:
            return None, float("inf")
        best = min(candidates, key=lambda s: _haversine(lat, lng, s.latitude, s.longitude))
        return best, _haversine(lat, lng, best.latitude, best.longitude)

    def _walk_leg(from_n, to_n, dist_m):
        return {
            "type": "walk",
            "from_name": from_n,
            "to_name":   to_n,
            "distance_m": round(dist_m),
            "walk_min":   max(1, round(dist_m / WALK_MPS)),
        }

    now = datetime.utcnow()
    sgt = now + timedelta(hours=8)

    options: list[dict] = []

    # ── Option A: Bus-only ────────────────────────────────────
    origin_stop,  origin_dist  = _nearest_bus_stop(from_lat, from_lng)
    dest_stop,    dest_dist    = _nearest_bus_stop(to_lat,   to_lng)

    if origin_stop and dest_stop and origin_dist < 1500 and dest_dist < 1500:
        route_count = db.query(func.count(BusRoute.id)).scalar() or 0
        if route_count:
            raw_opts = _route_graph.find_journeys(
                origin_stop.bus_stop_code, dest_stop.bus_stop_code, db
            )
            unique_boards = {
                leg["from_stop"]
                for opt in raw_opts[:2]
                for leg in opt["legs"]
            }

            async def _fetch2(c):
                try: return c, await _call_lta(c)
                except: return c, None

            fetched2 = await asyncio.gather(*[_fetch2(c) for c in unique_boards])
            arr2: dict[str, dict | None] = dict(fetched2)

            def enrich_bus_leg(raw_leg, earliest_board=None):
                svc    = raw_leg["service"]
                board  = raw_leg["from_stop"]
                alight = raw_leg["to_stop"]
                sc     = raw_leg["stops_count"]
                est_ride = max(2, sc * 2)
                board_ref  = earliest_board or now
                wait_min   = None; lta_arr = None; ai_arr_s = None
                ai_adj     = 0;    buses_avail = 0; last_bus = False

                lta_data = arr2.get(board)
                if lta_data:
                    for sv in lta_data.get("Services", []):
                        if sv.get("ServiceNo") != svc: continue
                        for sk in ["NextBus","NextBus2","NextBus3"]:
                            if (sv.get(sk) or {}).get("EstimatedArrival"): buses_avail += 1
                        chosen_b, chosen_e = None, None
                        for sk in ["NextBus","NextBus2","NextBus3"]:
                            b = sv.get(sk) or {}
                            e = _parse_lta_dt(b.get("EstimatedArrival"))
                            if e and e >= board_ref - timedelta(seconds=90):
                                chosen_b, chosen_e = b, e; break
                        if chosen_e:
                            ws = (chosen_e - board_ref).total_seconds()
                            wait_min = max(0, int(ws / 60))
                            adj = global_model.predict(
                                hour=sgt.hour, day_of_week=sgt.weekday(),
                                bus_load=chosen_b.get("Load","SEA"),
                                bus_type=chosen_b.get("Type","SD"),
                                service_no=svc, stop_code=board,
                            )
                            if ws <= 120: adj *= 0.25
                            elif ws <= 300: adj *= 0.6
                            if ws > 0: adj = max(-0.5 * ws, adj)
                            ai_adj = round(adj)
                            lta_arr   = chosen_e.isoformat()
                            ai_arr_s  = (chosen_e + timedelta(seconds=adj)).isoformat()
                        last_bus = buses_avail <= 1; break

                brd = db.query(BusStop).filter_by(bus_stop_code=board).first()
                alt = db.query(BusStop).filter_by(bus_stop_code=alight).first()
                return {
                    "type": "bus",
                    "service_no": svc, "direction": raw_leg["direction"],
                    "board_stop":  {"code": board,  "name": brd.description if brd else board},
                    "alight_stop": {"code": alight, "name": alt.description if alt else alight},
                    "stops_count": sc, "est_ride_min": est_ride,
                    "wait_min": wait_min, "lta_arrival": lta_arr,
                    "ai_arrival": ai_arr_s, "ai_adj_sec": ai_adj,
                    "buses_available": buses_avail, "is_last_bus_soon": last_bus,
                    "is_transfer_wait": earliest_board is not None,
                }

            for raw in raw_opts[:2]:
                walk_in  = _walk_leg(from_name, origin_stop.description or origin_stop.bus_stop_code, origin_dist)
                walk_out = _walk_leg(dest_stop.description or dest_stop.bus_stop_code, to_name, dest_dist)
                legs: list[dict] = [walk_in]
                cum = walk_in["walk_min"]
                for i, rl in enumerate(raw["legs"]):
                    earliest = None if i == 0 else now + timedelta(minutes=cum + 2)
                    bl = enrich_bus_leg(rl, earliest)
                    legs.append(bl)
                    cum += (bl.get("wait_min") or 5) + bl["est_ride_min"]
                legs.append(walk_out)
                total = (
                    walk_in["walk_min"]
                    + sum((l.get("wait_min") or 5) + l["est_ride_min"] for l in legs if l["type"] == "bus")
                    + walk_out["walk_min"]
                    + raw["transfers"] * 3
                )
                options.append({
                    "mode": "bus",
                    "transfers": raw["transfers"],
                    "total_est_min": total,
                    "has_last_bus_warning": any(l.get("is_last_bus_soon") for l in legs if l["type"] == "bus"),
                    "legs": legs,
                })

    # ── Option B: MRT route ───────────────────────────────────
    origin_mrt  = nearest_station(from_lat, from_lng, max_m=2000)
    dest_mrt    = nearest_station(to_lat,   to_lng,   max_m=2000)

    if origin_mrt and dest_mrt:
        o_code, o_dist = origin_mrt
        d_code, d_dist = dest_mrt
        mrt_legs = find_mrt_path(o_code, d_code)

        if mrt_legs is not None:
            o_stn = STATIONS[o_code]
            d_stn = STATIONS[d_code]
            walk_in  = _walk_leg(from_name, f"{o_stn['name']} MRT", o_dist)
            walk_out = _walk_leg(f"{d_stn['name']} MRT", to_name, d_dist)

            # Add wait to first MRT leg
            enriched_mrt: list[dict] = []
            for i, ml in enumerate(mrt_legs):
                wait = mrt_wait_min(ml["line"], sgt.hour, sgt.weekday()) if i == 0 else 3
                enriched_mrt.append({**ml, "wait_min": wait})

            check_alerts = True
            train_alerts: set[str] = set()
            try:
                async with httpx.AsyncClient(timeout=5) as hc:
                    r = await hc.get(
                        f"{LTA_BASE_URL}/TrainServiceAlerts",
                        headers={"AccountKey": LTA_API_KEY},
                    )
                    if r.status_code == 200:
                        for msg in r.json().get("value", {}).get("AffectedSegments", []):
                            train_alerts.add(msg.get("Line", ""))
            except Exception:
                check_alerts = False

            all_legs = [walk_in] + enriched_mrt + [walk_out]
            mrt_total = (
                walk_in["walk_min"]
                + sum(l["wait_min"] + l["est_ride_min"] for l in enriched_mrt)
                + walk_out["walk_min"]
            )
            lines_used = {l["line"] for l in enriched_mrt}
            options.append({
                "mode": "mrt",
                "transfers": max(0, len(enriched_mrt) - 1),
                "total_est_min": mrt_total,
                "has_last_bus_warning": False,
                "train_alert": bool(train_alerts & lines_used),
                "legs": all_legs,
            })

    options.sort(key=lambda o: o["total_est_min"])

    return {
        "from": {"name": from_name, "lat": from_lat, "lng": from_lng},
        "to":   {"name": to_name,   "lat": to_lat,   "lng": to_lng},
        "options": options[:3],
    }


# ── Data overview ────────────────────────────────────────────────────────

@router.get("/data")
def get_data_overview(db: Session = Depends(get_db)) -> dict:
    """
    Returns a full database overview for the Data tab:
    - DB type (PostgreSQL or SQLite)
    - Row counts per table
    - Recent 20 arrival records
    - Closed tracking rows with computed delays
    - Monitored stops
    - ML model status
    """
    db_type = "PostgreSQL" if DATABASE_URL.startswith("postgresql") else "SQLite"

    # Table counts
    arrival_count  = db.query(func.count(BusArrivalRecord.id)).scalar() or 0
    tracking_count = db.query(func.count(BusTracking.id)).scalar() or 0
    stops_count    = db.query(func.count(BusStop.bus_stop_code)).scalar() or 0
    labeled_count  = db.query(func.count(BusArrivalRecord.id)).filter(
        BusArrivalRecord.delay_seconds.isnot(None)).scalar() or 0

    # Recent 20 arrival records with a known delay (arrived early or late)
    recent_rows = (
        db.query(BusArrivalRecord)
        .filter(BusArrivalRecord.delay_seconds.isnot(None))
        .order_by(BusArrivalRecord.collection_time.desc())
        .limit(20)
        .all()
    )
    recent = [
        {
            "id":               r.id,
            "bus_stop_code":    r.bus_stop_code,
            "bus_service":      r.bus_service,
            "collection_time":  r.collection_time.isoformat() if r.collection_time else None,
            "wait_seconds":     round(r.wait_seconds, 0) if r.wait_seconds else None,
            "delay_seconds":    round(r.delay_seconds, 1) if r.delay_seconds is not None else None,
            "hour_of_day":      r.hour_of_day,
            "day_of_week":      r.day_of_week,
            "bus_load":         r.bus_load,
            "bus_type":         r.bus_type,
            "is_peak":          r.is_peak,
        }
        for r in recent_rows
    ]

    # Recent closed tracking rows (ground-truth delays)
    closed_rows = (
        db.query(BusTracking)
        .filter_by(is_closed=True)
        .order_by(BusTracking.last_seen.desc())
        .limit(10)
        .all()
    )
    tracking = [
        {
            "bus_stop_code": t.bus_stop_code,
            "bus_service":   t.bus_service,
            "first_seen":    t.first_seen.isoformat() if t.first_seen else None,
            "delay_seconds": round(t.delay_seconds, 1) if t.delay_seconds is not None else None,
        }
        for t in closed_rows
    ]

    # Monitored stops
    monitored = [
        s.bus_stop_code
        for s in db.query(MonitoredStop).filter_by(is_active=True).all()
    ]

    return {
        "database": {
            "type":           db_type,
            "arrival_records": arrival_count,
            "labeled_records": labeled_count,
            "tracking_rows":   tracking_count,
            "bus_stops":       stops_count,
        },
        "model":       global_model.status(),
        "monitored_stops": monitored,
        "recent_records":  recent,
        "recent_tracking": tracking,
    }
