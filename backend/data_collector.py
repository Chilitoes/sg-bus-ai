"""
Background data collector.

Every COLLECTION_INTERVAL_MINUTES minutes it:
  1. Reads the list of monitored stops from the DB.
  2. Calls the LTA Bus Arrival API for each stop.
  3. Saves each reported bus as a BusArrivalRecord.
  4. Updates BusTracking rows to derive ground-truth delay:
       • A bus is identified by (stop, service, rounded_estimated_arrival).
       • On first sighting  → open a tracking row.
       • On subsequent sights → update last_seen / last_estimate.
       • When it disappears  → close the row and write delay_seconds
         (last_estimate − first_estimate).  Also back-fills all matching
         BusArrivalRecord rows with this delay so the ML model can use them.

Ground-truth derivation
-----------------------
Because the LTA API only gives estimated arrival times (not actual),
we approximate actual arrival as the last estimate before the bus vanishes.
  delay_seconds = last_estimate − first_estimate
Positive → bus ran progressively later (late).
Negative → bus kept moving up its schedule (early).

This is the standard technique when only ETA data is available.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy.orm import Session

from config import (
    COLLECTION_INTERVAL_MINUTES,
    LTA_API_KEY,
    LTA_ARRIVAL_ENDPOINT,
    MODEL_RETRAIN_INTERVAL_HOURS,
)
from database import BusArrivalRecord, BusTracking, MonitoredStop, SessionLocal
from ml_model import model as global_model

logger = logging.getLogger(__name__)

# Singapore Standard Time (UTC+8)
_SGT = timezone(timedelta(hours=8))


def _is_service_hours() -> bool:
    """
    Singapore bus services run roughly 05:30–00:30 SGT.
    Skip data collection between 01:00 and 05:00 SGT when no buses run.
    """
    hour = datetime.now(_SGT).hour
    return not (1 <= hour < 5)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _round_dt(dt: datetime, minutes: int = 1) -> datetime:
    """Round a datetime to the nearest N minutes (used as a bus tracking key)."""
    discard = timedelta(minutes=minutes)
    return dt - (dt - datetime.min.replace(tzinfo=dt.tzinfo)) % discard


def _parse_dt(iso_str: str | None) -> datetime | None:
    if not iso_str:
        return None
    try:
        # LTA returns "+08:00" offset; Python's fromisoformat handles this ≥ 3.11
        # For older Pythons we strip the offset and treat as UTC+8
        dt = datetime.fromisoformat(iso_str)
        # Normalise to UTC for DB storage
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    except Exception:
        return None


def _is_peak(hour: int, is_weekend: bool) -> bool:
    if is_weekend:
        return False
    return (7 <= hour < 9) or (17 <= hour < 19)


# ── LTA API call ──────────────────────────────────────────────────────────────

async def fetch_arrivals(client: httpx.AsyncClient, stop_code: str) -> dict:
    """Call the LTA Bus Arrival v2 API and return the parsed JSON."""
    headers = {"AccountKey": LTA_API_KEY}
    params  = {"BusStopCode": stop_code}
    try:
        resp = await client.get(LTA_ARRIVAL_ENDPOINT, headers=headers, params=params, timeout=10)
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        logger.warning("LTA API error for stop %s: %s", stop_code, exc)
        return {}


# ── Tracking logic ────────────────────────────────────────────────────────────

def _upsert_tracking(
    db: Session,
    stop_code: str,
    service_no: str,
    now: datetime,
    estimated: datetime,
) -> None:
    """Open or update a BusTracking row for this bus."""
    key = _round_dt(estimated)
    row = (
        db.query(BusTracking)
        .filter_by(bus_stop_code=stop_code, bus_service=service_no, arrival_key=key)
        .first()
    )
    if row is None:
        db.add(BusTracking(
            bus_stop_code  = stop_code,
            bus_service    = service_no,
            arrival_key    = key,
            first_seen     = now,
            first_estimate = estimated,
            last_seen      = now,
            last_estimate  = estimated,
            is_closed      = False,
        ))
    else:
        row.last_seen     = now
        row.last_estimate = estimated


def _close_stale_tracking(db: Session, stop_code: str, service_no: str,
                           active_keys: set[datetime]) -> None:
    """
    Close tracking rows whose arrival_key is NOT in the current API response.
    A missing entry means the bus arrived (or the service ended).
    """
    open_rows = (
        db.query(BusTracking)
        .filter_by(bus_stop_code=stop_code, bus_service=service_no, is_closed=False)
        .all()
    )
    for row in open_rows:
        if row.arrival_key not in active_keys:
            delay = (row.last_estimate - row.first_estimate).total_seconds()
            row.is_closed     = True
            row.delay_seconds = delay

            # Back-fill matching BusArrivalRecord rows (same stop/service/key)
            window_start = row.arrival_key - timedelta(minutes=2)
            window_end   = row.arrival_key + timedelta(minutes=2)
            (
                db.query(BusArrivalRecord)
                .filter(
                    BusArrivalRecord.bus_stop_code == stop_code,
                    BusArrivalRecord.bus_service   == service_no,
                    BusArrivalRecord.estimated_arrival.between(window_start, window_end),
                    BusArrivalRecord.delay_seconds.is_(None),
                )
                .update({"delay_seconds": delay}, synchronize_session=False)
            )
            logger.debug("Closed tracking %s/%s  delay=%.0fs", stop_code, service_no, delay)


# ── Per-stop collection ───────────────────────────────────────────────────────

async def collect_stop(client: httpx.AsyncClient, stop_code: str, now: datetime) -> int:
    """
    Fetch arrivals for one stop, persist records, update tracking.
    Returns the number of bus records saved.
    """
    data = await fetch_arrivals(client, stop_code)
    services = data.get("Services", [])
    if not services:
        return 0

    db = SessionLocal()
    saved = 0
    try:
        active_keys_by_service: dict[str, set[datetime]] = {}

        for svc in services:
            service_no = svc.get("ServiceNo", "")
            active_keys_by_service.setdefault(service_no, set())

            for slot_idx, slot_key in enumerate(["NextBus", "NextBus2", "NextBus3"], start=1):
                bus = svc.get(slot_key, {})
                if not bus:
                    continue
                estimated = _parse_dt(bus.get("EstimatedArrival"))
                if estimated is None:
                    continue

                wait_sec = (estimated - now).total_seconds()
                is_wkend = now.weekday() >= 5

                db.add(BusArrivalRecord(
                    bus_stop_code     = stop_code,
                    bus_service       = service_no,
                    collection_time   = now,
                    estimated_arrival = estimated,
                    wait_seconds      = wait_sec,
                    hour_of_day       = now.hour,
                    day_of_week       = now.weekday(),
                    is_peak           = _is_peak(now.hour, is_wkend),
                    is_weekend        = is_wkend,
                    bus_load          = bus.get("Load"),
                    bus_type          = bus.get("Type"),
                    slot              = slot_idx,
                ))
                saved += 1

                # Only track the next bus (slot 1) to derive clean ground truth
                if slot_idx == 1:
                    _upsert_tracking(db, stop_code, service_no, now, estimated)
                    active_keys_by_service[service_no].add(_round_dt(estimated))

        # Close tracking rows for buses that are no longer in the response
        for service_no, active_keys in active_keys_by_service.items():
            _close_stale_tracking(db, stop_code, service_no, active_keys)

        db.commit()
    except Exception as exc:
        logger.error("DB error collecting stop %s: %s", stop_code, exc)
        db.rollback()
    finally:
        db.close()

    return saved


# ── Main loop ─────────────────────────────────────────────────────────────────

async def start_data_collection() -> None:
    """
    Infinite async loop.  Runs every COLLECTION_INTERVAL_MINUTES minutes.
    Also triggers model retraining every MODEL_RETRAIN_INTERVAL_HOURS hours.
    """
    interval_sec  = COLLECTION_INTERVAL_MINUTES * 60
    retrain_every = MODEL_RETRAIN_INTERVAL_HOURS * 3600
    last_retrain  = 0.0

    logger.info(
        "Data collector started  interval=%dm  retrain every %dh",
        COLLECTION_INTERVAL_MINUTES, MODEL_RETRAIN_INTERVAL_HOURS,
    )

    async with httpx.AsyncClient() as client:
        while True:
            if not _is_service_hours():
                sgt_hour = datetime.now(_SGT).hour
                logger.info("Outside service hours (SGT %02d:xx) — skipping collection", sgt_hour)
                await asyncio.sleep(interval_sec)
                continue

            now = datetime.now(timezone.utc).replace(tzinfo=None)
            db = SessionLocal()
            try:
                stops = (
                    db.query(MonitoredStop)
                    .filter_by(is_active=True)
                    .all()
                )
                stop_codes = [s.bus_stop_code for s in stops]
            finally:
                db.close()

            if not stop_codes:
                logger.debug("No monitored stops — skipping collection cycle")
            else:
                tasks   = [collect_stop(client, code, now) for code in stop_codes]
                results = await asyncio.gather(*tasks, return_exceptions=True)
                total   = sum(r for r in results if isinstance(r, int))
                logger.info("Collected %d records from %d stops", total, len(stop_codes))

            # Periodic model retraining
            import time
            elapsed = time.monotonic() - last_retrain
            if elapsed >= retrain_every:
                last_retrain = time.monotonic()  # always advance so failures don't cause infinite retries
                logger.info("Triggering scheduled model retrain")
                try:
                    global_model.retrain_from_db()
                except Exception as exc:
                    logger.exception("Model retrain failed: %s", exc)

            await asyncio.sleep(interval_sec)
