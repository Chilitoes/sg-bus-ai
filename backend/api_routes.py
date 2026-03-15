"""
FastAPI router.

Endpoints
---------
GET  /api/arrivals/{stop_code}       Real-time arrivals + AI predictions
GET  /api/stats/{stop_code}          Delay stats for charts (by service, hour, day)
GET  /api/stops/search               Search bus stops by code or name
GET  /api/stops/{stop_code}          Get single bus stop info
POST /api/stops/sync                 Re-sync bus stop directory from LTA
GET  /api/model/status               ML model metadata
POST /api/model/retrain              Trigger an immediate model retrain
POST /api/monitor/{stop_code}        Add a stop to the background collector
DELETE /api/monitor/{stop_code}      Remove a stop from the background collector
GET  /api/monitor                    List all monitored stops
GET  /api/data                       Database overview for the Data tab
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from config import LTA_API_KEY, LTA_ARRIVAL_ENDPOINT, LTA_BASE_URL, DATABASE_URL
from database import BusArrivalRecord, BusStop, BusTracking, MonitoredStop, get_db
from ml_model import model as global_model

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Internal helpers ──────────────────────────────────────────────────────────

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


# ── Arrivals ──────────────────────────────────────────────────────────────────

@router.get("/arrivals/{stop_code}")
async def get_arrivals(stop_code: str, db: Session = Depends(get_db)) -> dict:
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
                hour        = now.hour,
                day_of_week = now.weekday(),
                bus_load    = load,
                bus_type    = bus_type,
                service_no  = service_no,
                stop_code   = stop_code,
            )
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


# ── Statistics ────────────────────────────────────────────────────────────────

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

    # ── By service ────────────────────────────────────────────────────────────
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

    # ── By hour ───────────────────────────────────────────────────────────────
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

    # ── Trend (daily average over last 14 days) ───────────────────────────────
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


# ── ML model ──────────────────────────────────────────────────────────────────

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


# ── Bus stop directory ────────────────────────────────────────────────────────

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


# ── Monitored stops ───────────────────────────────────────────────────────────

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


# ── Data overview ─────────────────────────────────────────────────────────────

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
