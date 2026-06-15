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
import itertools
import logging
import math
import time as _time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import case, func, or_, text
from sqlalchemy.orm import Session

from auth_routes import require_admin
from config import LTA_API_KEY, LTA_ARRIVAL_ENDPOINT, LTA_BASE_URL, DATABASE_URL
from data_collector import persist_arrival_payload
from database import BusArrivalRecord, BusRoute, BusStop, BusTracking, Feedback, MonitoredStop, User, get_db
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


def _sgt_iso(dt: datetime | None) -> str | None:
    """UTC-naive datetime -> Singapore-time (UTC+8) ISO string."""
    return (dt + timedelta(hours=8)).isoformat() if dt else None


def _resolve_plan_time(depart_at: str | None) -> tuple[datetime, datetime, bool, str | None]:
    """Resolve the planning clock.

    `depart_at` is an SGT wall-clock string 'YYYY-MM-DDTHH:MM' (from an
    <input type="datetime-local">). When it is more than a few minutes in the
    future, plan for that time so operating-hours and schedule estimates reflect
    the future trip; otherwise fall back to the real current time.
    Returns (now_utc, sgt, is_future, planned_for_sgt_iso).
    """
    actual_now = datetime.utcnow()
    actual_sgt = actual_now + timedelta(hours=8)
    if depart_at:
        try:
            planned_sgt = datetime.fromisoformat(depart_at)
            if planned_sgt.tzinfo is not None:
                planned_sgt = planned_sgt.replace(tzinfo=None)
            if planned_sgt > actual_sgt + timedelta(minutes=3):
                return planned_sgt - timedelta(hours=8), planned_sgt, True, planned_sgt.isoformat()
        except (ValueError, TypeError):
            pass
    return actual_now, actual_sgt, False, None


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

    # Per-service reliability from 30 days of collected ground truth at this stop.
    # "On time" = actual arrival within 2 minutes of the LTA estimate.
    reliability: dict[str, dict] = {}
    try:
        rel_rows = (
            db.query(
                BusArrivalRecord.bus_service,
                func.avg(BusArrivalRecord.delay_seconds).label("avg_delay"),
                func.count().label("n"),
                func.avg(
                    case((func.abs(BusArrivalRecord.delay_seconds) <= 120, 1.0), else_=0.0)
                ).label("on_time"),
            )
            .filter(
                BusArrivalRecord.bus_stop_code == stop_code,
                BusArrivalRecord.delay_seconds.isnot(None),
                BusArrivalRecord.collection_time >= now - timedelta(days=30),
            )
            .group_by(BusArrivalRecord.bus_service)
            .all()
        )
        for r in rel_rows:
            if r.n >= 20:  # need enough samples to be meaningful
                reliability[r.bus_service] = {
                    "avg_delay_sec": round(r.avg_delay, 1),
                    "on_time_pct":   round(r.on_time * 100),
                    "samples":       r.n,
                }
    except Exception:
        pass  # stats are a bonus; never break arrivals over them

    result_services = []
    for svc in services:
        service_no = svc.get("ServiceNo", "")
        buses = []
        for slot_idx, slot_key in enumerate(["NextBus", "NextBus2", "NextBus3"], start=1):
            bus = svc.get(slot_key) or {}
            estimated = _parse_lta_dt(bus.get("EstimatedArrival"))
            # Skip empty slots and the LTA "1900-01-01" no-bus sentinel.
            if estimated is None or estimated < now - timedelta(seconds=90):
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
                "api_arrival_sgt":    _sgt_iso(estimated),
                "api_wait_min":       _fmt_minutes(estimated),
                "ai_arrival":         ai_arrival.isoformat(),
                "ai_arrival_sgt":     _sgt_iso(ai_arrival),
                "ai_wait_min":        _fmt_minutes(ai_arrival),
                "ai_adjustment_sec":  round(adjustment_sec),
            })

        if buses:
            result_services.append({
                "service_no":  service_no,
                "operator":    svc.get("Operator", ""),
                "reliability": reliability.get(service_no),
                "buses":       buses,
            })

    stop_row = db.query(BusStop).filter_by(bus_stop_code=stop_code).first()
    return {
        "bus_stop_code":  stop_code,
        "fetched_at":     now.isoformat(),
        "fetched_at_sgt": _sgt_iso(now),
        "latitude":       stop_row.latitude  if stop_row else None,
        "longitude":      stop_row.longitude if stop_row else None,
        "services":       result_services,
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
            func.avg(
                case((func.abs(BusArrivalRecord.delay_seconds) <= 60, 1.0), else_=0.0)
            ).label("on_time"),
            func.max(BusArrivalRecord.delay_seconds).label("max_delay"),
            func.min(BusArrivalRecord.delay_seconds).label("min_delay"),
        )
        .group_by(BusArrivalRecord.bus_service)
        .order_by(func.avg(BusArrivalRecord.delay_seconds).desc())
        .limit(15)
        .all()
    )
    by_service = [
        {
            "service":       r.bus_service,
            "avg_delay_sec": round(r.avg_delay, 1),
            "max_delay_sec": round(r.max_delay, 1),
            "min_delay_sec": round(r.min_delay, 1),
            "on_time_pct":   round(r.on_time * 100),
            "count":         r.count,
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

    # ── AI vs LTA accuracy ──────────────────────────────────────────────
    # Retroactively apply the current model to historical records and compare
    # against the raw LTA estimate.  Uses the same threshold (±60 s) for both.
    accuracy = None
    try:
        labeled_rows = (
            base_q
            .with_entities(
                BusArrivalRecord.bus_service,
                BusArrivalRecord.bus_stop_code,
                BusArrivalRecord.hour_of_day,
                BusArrivalRecord.day_of_week,
                BusArrivalRecord.bus_load,
                BusArrivalRecord.bus_type,
                BusArrivalRecord.delay_seconds,
            )
            .limit(2000)
            .all()
        )
        if len(labeled_rows) >= 50:
            lta_ok = ai_ok = 0
            for row in labeled_rows:
                d = row.delay_seconds
                ai_adj = global_model.predict(
                    hour=row.hour_of_day,
                    day_of_week=row.day_of_week,
                    bus_load=row.bus_load or "SEA",
                    bus_type=row.bus_type or "SD",
                    service_no=row.bus_service,
                    stop_code=row.bus_stop_code,
                )
                if abs(d) <= 60:
                    lta_ok += 1
                if abs(d - ai_adj) <= 60:
                    ai_ok += 1
            n = len(labeled_rows)
            accuracy = {
                "samples":       n,
                "lta_pct":       round(lta_ok / n * 100),
                "ai_pct":        round(ai_ok  / n * 100),
                "delta_pct":     round((ai_ok - lta_ok) / n * 100),
            }
    except Exception:
        pass  # accuracy is a bonus, never break stats over it

    return {
        "bus_stop_code":  stop_code,
        "total_records":  total_rows,
        "by_service":     by_service,
        "by_hour":        by_hour_full,
        "trend":          trend,
        "accuracy":       accuracy,
    }


# ── ML model ──────────────────────────────────────────────────────────

@router.get("/model/status")
def model_status() -> dict:
    return global_model.status()


@router.post("/model/retrain")
async def retrain_model(admin: User = Depends(require_admin)) -> dict:
    """Trigger an immediate model retrain from DB data. Admin only."""
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
    limit: int = Query(10, le=60),
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
                "latitude":      s.latitude,
                "longitude":     s.longitude,
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
async def sync_stops(admin: User = Depends(require_admin)) -> dict:
    """Fetch the full bus stop directory from LTA and upsert into the DB. Admin only."""
    return await _sync_stops_impl()


async def _sync_stops_impl() -> dict:
    """Internal implementation — also called at startup without auth."""
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
def add_monitored(stop_code: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    existing = db.query(MonitoredStop).filter_by(bus_stop_code=stop_code).first()
    if existing:
        existing.is_active = True
    else:
        db.add(MonitoredStop(bus_stop_code=stop_code))
    db.commit()
    return {"status": "added", "bus_stop_code": stop_code}


@router.delete("/monitor/{stop_code}")
def remove_monitored(stop_code: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
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
async def sync_routes(admin: User = Depends(require_admin)) -> dict:
    """Sync the full LTA bus route graph (all services × all stops) into the DB. Admin only."""
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
    depart_at: str | None = Query(None, description="Plan for a future SGT time 'YYYY-MM-DDTHH:MM'"),
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
            "lat":  s.latitude  if s else None,
            "lng":  s.longitude if s else None,
        }

    from_info = stop_info(from_code)
    to_info   = stop_info(to_code)

    raw_options = _route_graph.find_journeys(from_code, to_code, db)
    if not raw_options:
        return {
            "from": from_info, "to": to_info, "options": [],
            "message": "No direct or 1-transfer route found. Try nearby stops.",
        }

    now, sgt, is_future, planned_for = _resolve_plan_time(depart_at)

    # Fetch live arrivals for all unique boarding stops (concurrent)
    unique_boards = {leg["from_stop"] for opt in raw_options[:3] for leg in opt["legs"]}

    async def _fetch(code: str) -> tuple[str, dict | None]:
        try:
            return code, await _call_lta(code)
        except Exception:
            return code, None

    # Live arrivals only exist for "now"; skip the fetch for future trips.
    if is_future:
        arrivals_cache: dict[str, dict | None] = {}
    else:
        fetched = await asyncio.gather(*[_fetch(c) for c in unique_boards])
        arrivals_cache = dict(fetched)

    def enrich_leg(leg: dict, earliest_board: datetime | None = None) -> dict:
        svc      = leg["service"]
        board    = leg["from_stop"]
        alight   = leg["to_stop"]
        sc       = leg["stops_count"]
        est_ride = max(2, sc * 2)  # ~2 min per stop

        wait_min         = None
        lta_arrival      = None
        lta_arrival_sgt  = None
        ai_arrival_str   = None
        ai_arrival_sgt   = None
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
                # Parse all real near-future arrivals; the LTA API returns a
                # "1900-01-01T00:00:00+08:00" sentinel when no bus is scheduled,
                # so a raw truthiness check would wrongly count it as a bus.
                ests: list[tuple] = []
                for slot_key in ["NextBus", "NextBus2", "NextBus3"]:
                    b = sv.get(slot_key) or {}
                    est = _parse_lta_dt(b.get("EstimatedArrival"))
                    if est and est > now - timedelta(seconds=90):
                        ests.append((est, b))
                buses_available = len(ests)

                # First catchable bus at or after board_ref (90s grace period);
                # if none is catchable, fall back to the earliest real bus so the
                # last-bus time is still shown rather than left blank.
                chosen_bus, chosen_est = None, None
                for est, b in ests:
                    if est >= board_ref - timedelta(seconds=90):
                        chosen_bus, chosen_est = b, est
                        break
                if chosen_est is None and ests:
                    chosen_est, chosen_bus = ests[0]

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

                    lta_arrival     = chosen_est.isoformat()
                    lta_arrival_sgt = _sgt_iso(chosen_est)
                    ai_arrival_str  = (chosen_est + timedelta(seconds=adj)).isoformat()
                    ai_arrival_sgt  = _sgt_iso(chosen_est + timedelta(seconds=adj))

                is_last_bus = buses_available <= 1
                break

        # service_operating: only mark False during known off-hours (1–5 am)
        # when the API confirmed no buses at that specific board stop.
        # Outside those hours, "no buses in LTA window" does NOT mean the
        # service isn't running — the board stop may differ from the user's
        # current stop, or the next bus may simply be outside the API's
        # prediction window. Showing the route with wait_min=None is better
        # than hiding a genuinely running service.
        api_responded = lta_data is not None
        if not is_future and (1 <= sgt.hour < 5) and api_responded and buses_available == 0:
            service_operating = False
        else:
            service_operating = True

        brd = db.query(BusStop).filter_by(bus_stop_code=board).first()
        alt = db.query(BusStop).filter_by(bus_stop_code=alight).first()

        # Waypoints: all intermediate bus stops along the route so the map
        # draws the actual path rather than a straight line.
        waypoints: list[dict] = []
        try:
            board_seq = db.query(BusRoute.stop_sequence).filter_by(
                service_no=svc, direction=leg["direction"], bus_stop_code=board
            ).scalar()
            alight_seq = db.query(BusRoute.stop_sequence).filter_by(
                service_no=svc, direction=leg["direction"], bus_stop_code=alight
            ).scalar()
            if board_seq is not None and alight_seq is not None:
                lo, hi = min(board_seq, alight_seq), max(board_seq, alight_seq)
                wp_rows = (
                    db.query(BusStop.latitude, BusStop.longitude)
                    .join(BusRoute, BusRoute.bus_stop_code == BusStop.bus_stop_code)
                    .filter(
                        BusRoute.service_no == svc,
                        BusRoute.direction == leg["direction"],
                        BusRoute.stop_sequence.between(lo, hi),
                    )
                    .order_by(BusRoute.stop_sequence)
                    .all()
                )
                waypoints = [
                    {"lat": r.latitude, "lng": r.longitude}
                    for r in wp_rows if r.latitude and r.longitude
                ]
        except Exception:
            pass

        return {
            "service_no":        svc,
            "direction":         leg["direction"],
            "board_stop":        {"code": board,  "name": brd.description if brd else board,  "road": brd.road_name if brd else "",
                                  "lat": brd.latitude  if brd else None, "lng": brd.longitude if brd else None},
            "alight_stop":       {"code": alight, "name": alt.description if alt else alight, "road": alt.road_name if alt else "",
                                  "lat": alt.latitude  if alt else None, "lng": alt.longitude if alt else None},
            "stops_count":       sc,
            "est_ride_min":      est_ride,
            "wait_min":          wait_min,
            "lta_arrival":       lta_arrival,
            "lta_arrival_sgt":   lta_arrival_sgt,
            "ai_arrival":        ai_arrival_str,
            "ai_arrival_sgt":    ai_arrival_sgt,
            "ai_adj_sec":        ai_adj_sec,
            "buses_available":   buses_available,
            "is_last_bus_soon":  is_last_bus,
            "is_transfer_wait":  is_transfer_wait,
            "service_operating": service_operating,
            "waypoints":         waypoints,
        }

    options = []
    unavailable: list[dict] = []
    for raw in raw_options[:5]:
        legs = []
        cumulative_mins = 0
        for i, raw_leg in enumerate(raw["legs"]):
            earliest = None if i == 0 else now + timedelta(minutes=cumulative_mins + 2)
            leg = enrich_leg(raw_leg, earliest)
            legs.append(leg)
            cumulative_mins += (leg.get("wait_min") or 5) + leg["est_ride_min"]
        dead_legs = [l for l in legs if not l.get("service_operating", True)]
        if dead_legs:
            # Collect as unavailable so the frontend can explain the gap
            services = " + ".join(l["service_no"] for l in dead_legs)
            unavailable.append({
                "transfers": raw["transfers"],
                "legs": legs,
                "unavailable_reason": f"Bus {services} not running right now",
            })
            continue
        total_min = sum(
            (l.get("wait_min") or 5) + l["est_ride_min"] for l in legs
        ) + raw["transfers"] * 3
        options.append({
            "transfers":           raw["transfers"],
            "total_est_min":       total_min,
            "has_last_bus_warning": any(l["is_last_bus_soon"] for l in legs),
            "legs":                legs,
        })

    # Drop redundant transfers: if a one-bus option already uses service X, then a
    # transfer option whose first bus is also X is pointless (you'd just stay on X).
    direct_services = {
        o["legs"][0]["service_no"] for o in options if len(o["legs"]) == 1
    }
    pruned = [
        o for o in options
        if len(o["legs"]) == 1 or o["legs"][0]["service_no"] not in direct_services
    ]
    if pruned:
        options = pruned

    return {"from": from_info, "to": to_info, "options": options, "unavailable": unavailable[:3],
            "is_future": is_future, "planned_for": planned_for}


# ── Multimodal journey planner ───────────────────────────────────────────────

@router.get("/journey/multimodal")
async def plan_multimodal(
    from_lat:  float = Query(..., ge=-90,   le=90),
    from_lng:  float = Query(..., ge=-180,  le=180),
    to_lat:    float = Query(..., ge=-90,   le=90),
    to_lng:    float = Query(..., ge=-180,  le=180),
    from_name: str   = Query("Origin"),
    to_name:   str   = Query("Destination"),
    depart_at: str | None = Query(None, description="Plan for a future SGT time 'YYYY-MM-DDTHH:MM'"),
    db: Session = Depends(get_db),
) -> dict:
    """
    Plan a journey between two coordinates using bus and/or MRT.

    Bus options try multiple origin/destination stops within walking distance
    so the best alighting stop is chosen, not just the nearest to the pin.
    If the nearest MRT station is >600 m away, a bus feeder leg is inserted.
    Walk speed assumed 80 m/min.
    """
    import math as _math
    from mrt_data import nearest_station, find_mrt_path, mrt_wait_min, STATIONS

    WALK_MPS         = 80.0   # m/min
    MRT_FEEDER_THRESHOLD = 600  # m — beyond this, try a bus to the station

    def _hav(lat1, lng1, lat2, lng2) -> float:
        r = 6371000.0
        p1, p2 = _math.radians(lat1), _math.radians(lat2)
        dp = _math.radians(lat2 - lat1)
        dl = _math.radians(lng2 - lng1)
        a = _math.sin(dp / 2) ** 2 + _math.cos(p1) * _math.cos(p2) * _math.sin(dl / 2) ** 2
        return 2 * r * _math.asin(_math.sqrt(a))

    def _stops_within(lat, lng, max_m: float, limit: int = 10) -> list[tuple]:
        """Return [(BusStop, dist_m)] sorted by distance, within max_m metres."""
        box = max(0.006, max_m / 80000)
        cands = db.query(BusStop).filter(
            BusStop.latitude.isnot(None),
            BusStop.latitude.between(lat - box, lat + box),
            BusStop.longitude.between(lng - box, lng + box),
        ).all()
        scored = sorted(
            [(s, _hav(lat, lng, s.latitude, s.longitude)) for s in cands],
            key=lambda x: x[1],
        )
        return [(s, d) for s, d in scored if d <= max_m][:limit]

    def _walk_leg(from_n: str, to_n: str, dist_m: float,
                  from_lat=None, from_lng=None, to_lat=None, to_lng=None) -> dict:
        return {
            "type": "walk",
            "from_name":  from_n,
            "to_name":    to_n,
            "distance_m": round(dist_m),
            "walk_min":   max(1, round(dist_m / WALK_MPS)),
            "from_lat": from_lat, "from_lng": from_lng,
            "to_lat":   to_lat,   "to_lng":   to_lng,
        }

    now, sgt, is_future, planned_for = _resolve_plan_time(depart_at)
    route_count = db.query(func.count(BusRoute.id)).scalar() or 0

    # ── Phase 1: collect raw route plans ─────────────────────
    # Bus: try top-4 origin stops × all dest stops within 900 m
    origin_stops = _stops_within(from_lat, from_lng, 500, 4)
    dest_stops   = _stops_within(to_lat,   to_lng,   900, 10)

    MAX_DEST_WALK_M = 1200  # Don't suggest a route whose final walk exceeds this

    raw_bus_plans: list[tuple] = []  # (raw_opt, o_stop, o_dist, d_stop, d_dist)
    seen_keys: set[tuple] = set()
    if route_count and origin_stops and dest_stops:
        for (o_stop, o_dist), (d_stop, d_dist) in itertools.product(origin_stops, dest_stops):
            if len(raw_bus_plans) >= 6:
                break
            for raw in _route_graph.find_journeys(o_stop.bus_stop_code, d_stop.bus_stop_code, db)[:2]:
                key = tuple(f"{l['service']}-{l['direction']}" for l in raw["legs"])
                if key not in seen_keys:
                    seen_keys.add(key)
                    raw_bus_plans.append((raw, o_stop, o_dist, d_stop, d_dist))

    # MRT: find nearest station; if walk too far, find bus feeder to station
    origin_mrt = nearest_station(from_lat, from_lng, max_m=2000)
    dest_mrt   = nearest_station(to_lat,   to_lng,   max_m=2000)
    # (feeder_raw, o_stop, o_walk_m, mrt_adj_stop, mrt_adj_walk_m)
    mrt_feeder: tuple | None = None
    # Destination-side feeder: (feeder_raw, mrt_adj_stop, mrt_adj_walk_m, d_stop, d_walk_m)
    dest_feeder: tuple | None = None

    if origin_mrt and route_count:
        o_code, o_dist_mrt = origin_mrt
        if o_dist_mrt > MRT_FEEDER_THRESHOLD and origin_stops:
            mrt_lat = STATIONS[o_code]["lat"]
            mrt_lng = STATIONS[o_code]["lng"]
            mrt_adj = _stops_within(mrt_lat, mrt_lng, 350, 6)
            for (o_stop, o_walk) in origin_stops:
                for (mrt_stop, mrt_walk) in mrt_adj:
                    feeders = _route_graph.find_journeys(
                        o_stop.bus_stop_code, mrt_stop.bus_stop_code, db
                    )
                    direct = [f for f in feeders if f["transfers"] == 0]
                    if direct:
                        mrt_feeder = (direct[0], o_stop, o_walk, mrt_stop, mrt_walk)
                        break
                if mrt_feeder:
                    break

    if dest_mrt and route_count:
        d_code, d_dist_mrt = dest_mrt
        if d_dist_mrt > MRT_FEEDER_THRESHOLD and dest_stops:
            mrt_lat = STATIONS[d_code]["lat"]
            mrt_lng = STATIONS[d_code]["lng"]
            mrt_adj = _stops_within(mrt_lat, mrt_lng, 350, 6)
            # Board a bus near the destination MRT, ride to a stop near the destination.
            for (mrt_stop, mrt_walk) in mrt_adj:
                for (d_stop, d_walk) in dest_stops:
                    feeders = _route_graph.find_journeys(
                        mrt_stop.bus_stop_code, d_stop.bus_stop_code, db
                    )
                    direct = [f for f in feeders if f["transfers"] == 0]
                    if direct:
                        dest_feeder = (direct[0], mrt_stop, mrt_walk, d_stop, d_walk)
                        break
                if dest_feeder:
                    break

    # ── Phase 2: fetch LTA arrivals for all boarding stops ───
    unique_boards: set[str] = set()
    for raw, *_ in raw_bus_plans[:3]:
        for leg in raw["legs"]:
            unique_boards.add(leg["from_stop"])
    if mrt_feeder:
        for leg in mrt_feeder[0]["legs"]:
            unique_boards.add(leg["from_stop"])
    if dest_feeder:
        for leg in dest_feeder[0]["legs"]:
            unique_boards.add(leg["from_stop"])

    async def _fetch(c):
        try: return c, await _call_lta(c)
        except: return c, None

    # Live arrivals only exist for "now" — for a future trip there is nothing to
    # fetch, so leg waits degrade to schedule-based estimates (wait_min = None).
    arr_cache: dict[str, dict | None] = {} if is_future else dict(
        await asyncio.gather(*[_fetch(c) for c in unique_boards])
    )

    # ── enrich_bus_leg (uses arr_cache closure) ───────────────
    def enrich_bus_leg(raw_leg: dict, earliest_board=None) -> dict:
        svc    = raw_leg["service"]
        board  = raw_leg["from_stop"]
        alight = raw_leg["to_stop"]
        sc     = raw_leg["stops_count"]
        board_ref = earliest_board or now
        wait_min = None; lta_arr = None; ai_arr_s = None
        lta_arr_sgt = None; ai_arr_sgt = None
        ai_adj = 0; buses_avail = 0; last_bus = False
        next_wait_min = None

        lta_data = arr_cache.get(board)
        if lta_data:
            for sv in lta_data.get("Services", []):
                if sv.get("ServiceNo") != svc: continue
                # Parse all real near-future arrivals; ignore the LTA
                # "1900-01-01T00:00:00+08:00" no-bus sentinel.
                ests: list[tuple] = []
                for sk in ["NextBus", "NextBus2", "NextBus3"]:
                    b = sv.get(sk) or {}
                    e = _parse_lta_dt(b.get("EstimatedArrival"))
                    if e and e > now - timedelta(seconds=90):
                        ests.append((e, b))
                buses_avail = len(ests)
                chosen_b, chosen_e = None, None
                for e, b in ests:
                    if e >= board_ref - timedelta(seconds=90):
                        chosen_b, chosen_e = b, e; break
                if chosen_e is None and ests:
                    chosen_e, chosen_b = ests[0]
                if chosen_e:
                    ws = (chosen_e - board_ref).total_seconds()
                    wait_min = max(0, int(ws / 60))
                    adj = global_model.predict(
                        hour=sgt.hour, day_of_week=sgt.weekday(),
                        bus_load=chosen_b.get("Load", "SEA"),
                        bus_type=chosen_b.get("Type", "SD"),
                        service_no=svc, stop_code=board,
                    )
                    if ws <= 120: adj *= 0.25
                    elif ws <= 300: adj *= 0.6
                    if ws > 0: adj = max(-0.5 * ws, adj)
                    ai_adj = round(adj)
                    lta_arr     = chosen_e.isoformat()
                    lta_arr_sgt = _sgt_iso(chosen_e)
                    ai_arr_s    = (chosen_e + timedelta(seconds=adj)).isoformat()
                    ai_arr_sgt  = _sgt_iso(chosen_e + timedelta(seconds=adj))
                    # The bus after the chosen one — used for "if you miss it" info
                    later = [e for e, _ in ests if e > chosen_e]
                    if later:
                        next_wait_min = max(0, int((later[0] - board_ref).total_seconds() / 60))
                last_bus = buses_avail <= 1; break

        api_responded = lta_data is not None
        if not is_future and (1 <= sgt.hour < 5) and api_responded and buses_avail == 0:
            service_operating = False
        else:
            service_operating = True

        brd = db.query(BusStop).filter_by(bus_stop_code=board).first()
        alt = db.query(BusStop).filter_by(bus_stop_code=alight).first()

        waypoints: list[dict] = []
        try:
            board_seq = db.query(BusRoute.stop_sequence).filter_by(
                service_no=svc, direction=raw_leg["direction"], bus_stop_code=board
            ).scalar()
            alight_seq = db.query(BusRoute.stop_sequence).filter_by(
                service_no=svc, direction=raw_leg["direction"], bus_stop_code=alight
            ).scalar()
            if board_seq is not None and alight_seq is not None:
                lo, hi = min(board_seq, alight_seq), max(board_seq, alight_seq)
                wp_rows = (
                    db.query(BusStop.latitude, BusStop.longitude)
                    .join(BusRoute, BusRoute.bus_stop_code == BusStop.bus_stop_code)
                    .filter(
                        BusRoute.service_no == svc,
                        BusRoute.direction == raw_leg["direction"],
                        BusRoute.stop_sequence.between(lo, hi),
                    )
                    .order_by(BusRoute.stop_sequence)
                    .all()
                )
                waypoints = [
                    {"lat": r.latitude, "lng": r.longitude}
                    for r in wp_rows if r.latitude and r.longitude
                ]
        except Exception:
            pass

        return {
            "type": "bus",
            "service_no": svc, "direction": raw_leg["direction"],
            "board_stop":  {"code": board,  "name": brd.description if brd else board,
                            "lat": brd.latitude  if brd else None, "lng": brd.longitude if brd else None},
            "alight_stop": {"code": alight, "name": alt.description if alt else alight,
                            "lat": alt.latitude  if alt else None, "lng": alt.longitude if alt else None},
            "stops_count": sc, "est_ride_min": max(2, sc * 2),
            "wait_min": wait_min, "lta_arrival": lta_arr,
            "lta_arrival_sgt": lta_arr_sgt,
            "ai_arrival": ai_arr_s, "ai_arrival_sgt": ai_arr_sgt,
            "ai_adj_sec": ai_adj,
            "buses_available": buses_avail, "is_last_bus_soon": last_bus,
            "next_wait_min": next_wait_min,
            "is_transfer_wait": earliest_board is not None,
            "service_operating": service_operating,
            "waypoints": waypoints,
        }

    def _catch_verdict(legs: list[dict]) -> dict | None:
        """'Should I run?' — compare the walk to the first stop against the live
        bus wait. Only meaningful when the option starts with walk → bus."""
        if len(legs) < 2 or legs[0].get("type") != "walk" or legs[1].get("type") != "bus":
            return None
        first_bus = legs[1]
        if first_bus.get("wait_min") is None:
            return None
        margin = first_bus["wait_min"] - legs[0]["walk_min"]
        if margin >= 2:
            status = "make"
        elif margin >= 0:
            status = "tight"
        else:
            status = "miss"
        return {
            "status": status,
            "margin_min": margin,
            "walk_min": legs[0]["walk_min"],
            "service_no": first_bus["service_no"],
            "next_wait_min": first_bus.get("next_wait_min"),
        }

    # ── Phase 3: build options ────────────────────────────────
    options: list[dict] = []
    unavailable: list[dict] = []

    # Bus options (up to 3)
    for raw, o_stop, o_dist, d_stop, d_dist in raw_bus_plans[:4]:
        walk_in  = _walk_leg(from_name, o_stop.description or o_stop.bus_stop_code, o_dist,
                              from_lat=from_lat, from_lng=from_lng,
                              to_lat=o_stop.latitude, to_lng=o_stop.longitude)
        walk_out = _walk_leg(d_stop.description or d_stop.bus_stop_code, to_name, d_dist,
                              from_lat=d_stop.latitude, from_lng=d_stop.longitude,
                              to_lat=to_lat, to_lng=to_lng)
        legs: list[dict] = [walk_in]
        cum = walk_in["walk_min"]
        for i, rl in enumerate(raw["legs"]):
            earliest = None if i == 0 else now + timedelta(minutes=cum + 2)
            bl = enrich_bus_leg(rl, earliest)
            legs.append(bl)
            cum += (bl.get("wait_min") or 5) + bl["est_ride_min"]
        legs.append(walk_out)
        dead_legs = [l for l in legs if l.get("type") == "bus" and not l.get("service_operating", True)]
        if dead_legs:
            services = " + ".join(l["service_no"] for l in dead_legs)
            unavailable.append({
                "mode": "bus",
                "transfers": raw["transfers"],
                "legs": legs,
                "unavailable_reason": f"Bus {services} not running right now",
            })
            continue
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
            "train_alert": False,
            "catch": _catch_verdict(legs),
            "legs": legs,
        })

    # MRT option (with bus feeder if applicable)
    # Skip entirely during the hours MRT is definitely not running (1am–5am SGT)
    mrt_running = not (1 <= sgt.hour <= 4)
    if origin_mrt and dest_mrt and not mrt_running:
        unavailable.append({
            "mode": "mrt",
            "transfers": 0,
            "legs": [],
            "unavailable_reason": "MRT not running (resumes ~5:30am)",
        })
    if origin_mrt and dest_mrt and mrt_running:
        o_code, o_dist_mrt = origin_mrt
        d_code, d_dist_mrt = dest_mrt
        mrt_legs = find_mrt_path(o_code, d_code)

        if mrt_legs is not None:
            enriched_mrt: list[dict] = []
            for i, ml in enumerate(mrt_legs):
                wait = mrt_wait_min(ml["line"], sgt.hour, sgt.weekday()) if i == 0 else 3
                enriched_mrt.append({**ml, "wait_min": wait})

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
                pass

            lines_used = {l["line"] for l in enriched_mrt}

            # ── Origin side: bus feeder → MRT, or a direct walk to the station ──
            in_legs: list[dict] = []
            in_xfers = 0
            if mrt_feeder:
                f_raw, f_o, f_o_walk, f_board, f_board_walk = mrt_feeder
                walk_in_f = _walk_leg(from_name, f_o.description or f_o.bus_stop_code, f_o_walk)
                walk_xfr  = _walk_leg(
                    f_board.description or f_board.bus_stop_code,
                    f"{STATIONS[o_code]['name']} MRT", f_board_walk,
                )
                feeder_legs: list[dict] = []
                cum = walk_in_f["walk_min"]
                for i, rl in enumerate(f_raw["legs"]):
                    earliest = None if i == 0 else now + timedelta(minutes=cum + 2)
                    bl = enrich_bus_leg(rl, earliest)
                    feeder_legs.append(bl)
                    cum += (bl.get("wait_min") or 5) + bl["est_ride_min"]
                first_feeder = feeder_legs[0] if feeder_legs else None
                if first_feeder is None or first_feeder.get("service_operating", True):
                    in_legs = [walk_in_f] + feeder_legs + [walk_xfr]
                    in_xfers = len(feeder_legs)
            if not in_legs:
                in_legs = [_walk_leg(from_name, f"{STATIONS[o_code]['name']} MRT", o_dist_mrt,
                                     from_lat=from_lat, from_lng=from_lng,
                                     to_lat=STATIONS[o_code]["lat"], to_lng=STATIONS[o_code]["lng"])]

            # ── Destination side: MRT → bus feeder → destination, or a walk ──
            out_legs: list[dict] = []
            out_xfers = 0
            out_walk_m = d_dist_mrt
            if dest_feeder:
                g_raw, g_board, g_board_walk, g_d, g_d_walk = dest_feeder
                walk_xfr2 = _walk_leg(
                    f"{STATIONS[d_code]['name']} MRT",
                    g_board.description or g_board.bus_stop_code, g_board_walk,
                )
                dfeeder_legs: list[dict] = []
                for i, rl in enumerate(g_raw["legs"]):
                    # Board ~ a few minutes after alighting the MRT; live timing is
                    # approximate here, so just nudge the first leg forward a little.
                    earliest = now + timedelta(minutes=8 + i * 5)
                    bl = enrich_bus_leg(rl, earliest)
                    dfeeder_legs.append(bl)
                first_dfeeder = dfeeder_legs[0] if dfeeder_legs else None
                if first_dfeeder is None or first_dfeeder.get("service_operating", True):
                    walk_out2 = _walk_leg(g_d.description or g_d.bus_stop_code, to_name, g_d_walk)
                    out_legs = [walk_xfr2] + dfeeder_legs + [walk_out2]
                    out_xfers = len(dfeeder_legs)
                    out_walk_m = max(g_board_walk, g_d_walk)
            if not out_legs:
                out_legs = [_walk_leg(f"{STATIONS[d_code]['name']} MRT", to_name, d_dist_mrt,
                                      from_lat=STATIONS[d_code]["lat"], from_lng=STATIONS[d_code]["lng"],
                                      to_lat=to_lat, to_lng=to_lng)]

            all_legs = in_legs + enriched_mrt + out_legs
            total = (
                sum((l.get("wait_min") or 0) + (l.get("walk_min") or l.get("est_ride_min") or 0)
                    for l in all_legs)
            )
            xfers = in_xfers + out_xfers + max(0, len(enriched_mrt) - 1)

            # Only mark unavailable if even WITH a feeder the final walk is too long
            # (i.e. no destination bus could get us close enough).
            if out_walk_m > MAX_DEST_WALK_M:
                unavailable.append({
                    "mode": "mrt",
                    "transfers": xfers,
                    "legs": all_legs,
                    "unavailable_reason": (
                        f"Nearest MRT ({STATIONS[d_code]['name']}) is "
                        f"{round(d_dist_mrt / 100) * 100:.0f} m from destination — "
                        "try a bus instead"
                    ),
                })
            else:
                options.append({
                    "mode": "mrt",
                    "transfers": xfers,
                    "total_est_min": total,
                    "has_last_bus_warning": any(
                        l.get("is_last_bus_soon") for l in all_legs if l.get("type") == "bus"
                    ),
                    "train_alert": bool(train_alerts & lines_used),
                    "catch": _catch_verdict(all_legs),
                    "legs": all_legs,
                })

    # ── Phase 4: prune redundant / poor options ──────────────
    def _bus_legs(opt):
        return [l for l in opt["legs"] if l.get("type") == "bus"]

    def _max_walk(opt):
        return max((l["distance_m"] for l in opt["legs"] if l.get("type") == "walk"),
                   default=0)

    # Services that get there on a single bus (no transfer).
    direct_services = {
        _bus_legs(o)[0]["service_no"]
        for o in options
        if o["mode"] == "bus" and len(_bus_legs(o)) == 1
    }

    def _is_redundant_transfer(opt):
        bl = _bus_legs(opt)
        # A transfer whose first bus already reaches the destination on its own
        # (e.g. ride 860 then change to 167, when 860 itself goes there).
        return len(bl) >= 2 and bl[0]["service_no"] in direct_services

    pruned = [o for o in options if not _is_redundant_transfer(o)]
    if pruned:
        options = pruned

    # Drop options that need an excessively long single walk when a shorter
    # alternative exists (e.g. a bus route ending in a long walk when another
    # option drops you much closer).
    short_walk = [o for o in options if _max_walk(o) <= MAX_DEST_WALK_M]
    if short_walk:
        options = short_walk

    options.sort(key=lambda o: o["total_est_min"])

    return {
        "from": {"name": from_name, "lat": from_lat, "lng": from_lng},
        "to":   {"name": to_name,   "lat": to_lat,   "lng": to_lng},
        "options": options[:3],
        "unavailable": unavailable[:3],
        "is_future": is_future,
        "planned_for": planned_for,
    }


# ── Data overview ────────────────────────────────────────────────────────

@router.get("/data")
def get_data_overview(admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
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

    # Records collected since midnight SGT (UTC+8)
    _SGT = timezone(timedelta(hours=8))
    today_sgt_start = datetime.now(_SGT).replace(hour=0, minute=0, second=0, microsecond=0)
    today_utc_start = today_sgt_start.astimezone(timezone.utc).replace(tzinfo=None)
    records_today = db.query(func.count(BusArrivalRecord.id)).filter(
        BusArrivalRecord.collection_time >= today_utc_start
    ).scalar() or 0

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

    # ── Leaderboards (last 30 days, min 20 observations) ─────────────────
    thirty_days_ago = datetime.utcnow() - timedelta(days=30)

    top_buses_q = (
        db.query(
            BusArrivalRecord.bus_service,
            func.avg(BusArrivalRecord.delay_seconds).label("avg_delay"),
            func.count(BusArrivalRecord.id).label("n"),
        )
        .filter(
            BusArrivalRecord.delay_seconds.isnot(None),
            BusArrivalRecord.collection_time >= thirty_days_ago,
        )
        .group_by(BusArrivalRecord.bus_service)
        .having(func.count(BusArrivalRecord.id) >= 20)
        .order_by(func.avg(BusArrivalRecord.delay_seconds).desc())
        .limit(10)
        .all()
    )
    top_buses = [
        {"service": r.bus_service, "avg_delay_sec": round(r.avg_delay, 1), "n": r.n}
        for r in top_buses_q
    ]

    top_stops_q = (
        db.query(
            BusArrivalRecord.bus_stop_code,
            func.avg(BusArrivalRecord.delay_seconds).label("avg_delay"),
            func.count(BusArrivalRecord.id).label("n"),
        )
        .filter(
            BusArrivalRecord.delay_seconds.isnot(None),
            BusArrivalRecord.collection_time >= thirty_days_ago,
        )
        .group_by(BusArrivalRecord.bus_stop_code)
        .having(func.count(BusArrivalRecord.id) >= 20)
        .order_by(func.avg(BusArrivalRecord.delay_seconds).desc())
        .limit(10)
        .all()
    )
    # Enrich with stop names
    stop_codes = [r.bus_stop_code for r in top_stops_q]
    stop_name_map = {
        s.bus_stop_code: s.description
        for s in db.query(BusStop).filter(BusStop.bus_stop_code.in_(stop_codes)).all()
    }
    top_stops = [
        {
            "stop_code": r.bus_stop_code,
            "stop_name": stop_name_map.get(r.bus_stop_code, r.bus_stop_code),
            "avg_delay_sec": round(r.avg_delay, 1),
            "n": r.n,
        }
        for r in top_stops_q
    ]

    return {
        "database": {
            "type":           db_type,
            "arrival_records": arrival_count,
            "labeled_records": labeled_count,
            "tracking_rows":   tracking_count,
            "bus_stops":       stops_count,
            "records_today":   records_today,
        },
        "model":       global_model.status(),
        "monitored_stops": monitored,
        "leaderboard": {
            "top_buses": top_buses,
            "top_stops": top_stops,
        },
        "recent_records":  recent,
        "recent_tracking": tracking,
    }


# ── Checkpoint traffic ────────────────────────────────────────────────────────

_CHECKPOINTS = {
    "woodlands": {
        "lat": 1.4476, "lng": 103.7679,
        "name": "Woodlands Causeway",
        "cam_radius_km":   5.0,
        "speed_radius_km": 3.0,
        "speed_roads":     ["woodlands", "bke", "kje"],
    },
    "tuas": {
        "lat": 1.3440, "lng": 103.6366,
        "name": "Tuas Second Link",
        "cam_radius_km":   6.0,
        "speed_radius_km": 4.0,
        "speed_roads":     ["tuas", "aye", "second link"],
    },
}
_cp_cache: dict | None = None
_cp_cache_ts: float = 0.0
_CP_CACHE_SEC = 120


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    dφ = math.radians(lat2 - lat1)
    dλ = math.radians(lng2 - lng1)
    a = math.sin(dφ / 2) ** 2 + math.cos(φ1) * math.cos(φ2) * math.sin(dλ / 2) ** 2
    return R * 2 * math.asin(min(1.0, math.sqrt(a)))


@router.get("/checkpoint/traffic")
async def checkpoint_traffic() -> dict:
    """Live LTA camera feeds + approach-road congestion for both checkpoints."""
    global _cp_cache, _cp_cache_ts
    now_ts = _time.time()
    if _cp_cache and (now_ts - _cp_cache_ts) < _CP_CACHE_SEC:
        return _cp_cache

    hdrs = {"AccountKey": LTA_API_KEY}
    async with httpx.AsyncClient(timeout=10) as client:
        imgs_r, spd_r = await asyncio.gather(
            client.get(f"{LTA_BASE_URL}/Traffic-Images",    headers=hdrs),
            client.get(f"{LTA_BASE_URL}/TrafficSpeedBands", headers=hdrs),
            return_exceptions=True,
        )

    cameras_raw = (
        imgs_r.json().get("value", [])
        if not isinstance(imgs_r, Exception) and imgs_r.status_code == 200
        else []
    )
    speed_raw = (
        spd_r.json().get("value", [])
        if not isinstance(spd_r, Exception) and spd_r.status_code == 200
        else []
    )

    out: dict = {}
    for key, cp in _CHECKPOINTS.items():
        # Closest cameras within cam_radius_km
        cam_entries: list[tuple[float, dict]] = []
        for c in cameras_raw:
            d = _haversine_km(cp["lat"], cp["lng"], c["Latitude"], c["Longitude"])
            if d <= cp["cam_radius_km"]:
                cam_entries.append((d, c))
        cam_entries.sort(key=lambda x: x[0])
        cameras = [{"id": c["CameraID"], "url": c["ImageLink"]} for _, c in cam_entries[:4]]

        # Speed bands on relevant roads within speed_radius_km
        road_kws = cp["speed_roads"]
        nearby_bands: list[dict] = []
        for b in speed_raw:
            road = b.get("RoadName", "").lower()
            if not any(k in road for k in road_kws):
                continue
            try:
                slat, slng = float(b["StartLat"]), float(b["StartLon"])
                elat, elng = float(b["EndLat"]),   float(b["EndLon"])
            except (KeyError, ValueError):
                continue
            if (
                _haversine_km(cp["lat"], cp["lng"], slat, slng) <= cp["speed_radius_km"] or
                _haversine_km(cp["lat"], cp["lng"], elat, elng) <= cp["speed_radius_km"]
            ):
                nearby_bands.append(b)

        congestion: str | None = None
        speed_range: dict | None = None
        if nearby_bands:
            avg_band = sum(int(b.get("SpeedBand", 4)) for b in nearby_bands) / len(nearby_bands)
            if avg_band >= 5:
                congestion = "light"
            elif avg_band >= 3:
                congestion = "moderate"
            else:
                congestion = "heavy"
            try:
                speeds = [int(b.get("MinimumSpeed", 0)) for b in nearby_bands if b.get("MinimumSpeed")]
                speed_range = {"min": min(speeds), "max": max(speeds)} if speeds else None
            except (ValueError, TypeError):
                pass

        out[key] = {
            "name":       cp["name"],
            "cameras":    cameras,
            "congestion": congestion,
            "speed_range": speed_range,
        }

    out["fetched_at"] = datetime.utcnow().isoformat()
    _cp_cache = out
    _cp_cache_ts = now_ts
    return out


# ── Feedback ──────────────────────────────────────────────────────────────────

@router.post("/feedback")
def submit_feedback(
    rating:  int | None = Query(None, ge=1, le=5),
    message: str | None = Query(None, max_length=2000),
    context: str | None = Query(None, max_length=50),
    db: Session = Depends(get_db),
) -> dict:
    """Accept anonymous feedback from app users. No auth required."""
    if not rating and not message:
        raise HTTPException(status_code=422, detail="Provide at least a rating or a message.")
    row = Feedback(rating=rating, message=message, context=context)
    db.add(row)
    db.commit()
    return {"ok": True}


@router.get("/feedback")
def list_feedback(
    limit: int = Query(100, ge=1, le=500),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Return recent feedback entries. Admin only."""
    rows = (
        db.query(Feedback)
        .order_by(Feedback.submitted_at.desc())
        .limit(limit)
        .all()
    )
    return {
        "count": len(rows),
        "items": [
            {
                "id":           r.id,
                "rating":       r.rating,
                "message":      r.message,
                "context":      r.context,
                "submitted_at": r.submitted_at.isoformat(),
            }
            for r in rows
        ],
    }
