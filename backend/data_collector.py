"""
Background data collector.

Every COLLECTION_INTERVAL_MINUTES minutes it:
  1. Reads the list of monitored stops from the DB and polls each one
     (full snapshot + ground-truth tracking).
  2. Additionally polls a small ROTATING batch of stops from the full
     Singapore directory (snapshot only, no tracking) so the model sees
     data from every stop over time without hammering the LTA API.
  3. Saves each reported bus as a BusArrivalRecord.
  4. Updates BusTracking rows to derive ground-truth delay:
       • A bus is identified by (stop, service, rounded_estimated_arrival).
       • On first sighting  → open a tracking row.
       • On subsequent sights → update last_seen / last_estimate.
       • When it disappears  → close the row and write delay_seconds
         (last_estimate − first_estimate).  Also back-fills all matching
         BusArrivalRecord rows with this delay so the ML model can use them.

Passive collection
------------------
`persist_arrival_payload` is also called (as a FastAPI background task) for
every user-facing /api/arrivals request, so every visitor query contributes
training snapshots at zero extra LTA API cost.

Ground-truth derivation
-----------------------
Because the LTA API only gives estimated arrival times (not actual),
we approximate actual arrival as the last estimate before the bus vanishes.
  delay_seconds = last_estimate − first_estimate
Positive → bus ran progressively later (late).
Negative → bus kept moving up its schedule (early).

A tracking row only produces a label if the bus was sighted at least twice
and the closing poll happened soon after the last sighting — otherwise the
row is closed unlabeled (prevents garbage 0-second labels from stops that
are polled sporadically, e.g. rotation stops or one-off user queries).

All time-of-day features (hour_of_day, day_of_week, is_peak, is_weekend)
are stored in Singapore time (SGT, UTC+8) — matching what the model and the
charts assume. Raw timestamps remain UTC.
"""

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy.orm import Session

from config import (
    COLLECTION_INTERVAL_MINUTES,
    LTA_API_KEY,
    LTA_ARRIVAL_ENDPOINT,
    MODEL_RETRAIN_INTERVAL_HOURS,
    ROTATION_BATCH_SIZE,
)
from database import BusArrivalRecord, BusStop, BusTracking, MonitoredStop, SessionLocal
from ml_model import model as global_model

logger = logging.getLogger(__name__)

# Singapore Standard Time (UTC+8)
_SGT = timezone(timedelta(hours=8))

# Close a tracking row WITH a label only if the closing poll came within this
# window of the last sighting (i.e. the stop was being polled continuously).
_TRACK_CLOSE_WINDOW_MIN = 15

# Data hygiene: unlabeled snapshots older than this are pruned daily.
_PRUNE_UNLABELED_DAYS = 60
_PRUNE_TRACKING_DAYS = 90

# Rotation cursor (module-level; resets on restart, which is fine)
_rotation_cursor = 0


def _is_service_hours() -> bool:
    """
    Singapore bus services run roughly 05:15–00:30 SGT.
    Dead zone: 00:30–05:15 (30–315 minutes past midnight SGT).
    """
    now_sgt = datetime.now(_SGT)
    total_min = now_sgt.hour * 60 + now_sgt.minute
    return not (30 <= total_min < 315)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _round_dt(dt: datetime, minutes: int = 1) -> datetime:
    """Round a datetime to the nearest N minutes (used as a bus tracking key)."""
    discard = timedelta(minutes=minutes)
    return dt - (dt - datetime.min.replace(tzinfo=dt.tzinfo)) % discard


def _parse_dt(iso_str: str | None) -> datetime | None:
    if not iso_str:
        return None
    try:
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
    """Call the LTA Bus Arrival API and return the parsed JSON."""
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
                          active_keys: set[datetime], now: datetime) -> None:
    """
    Close tracking rows whose arrival_key is NOT in the current API response.
    A missing entry means the bus arrived (or the service ended).

    Quality guard: only write a delay label if the bus was sighted at least
    twice AND the closing poll came shortly after the last sighting. A row
    seen once (or revisited hours later) closes WITHOUT a label.
    """
    open_rows = (
        db.query(BusTracking)
        .filter_by(bus_stop_code=stop_code, bus_service=service_no, is_closed=False)
        .all()
    )
    for row in open_rows:
        if row.arrival_key in active_keys:
            continue
        row.is_closed = True

        sighted_twice = row.last_seen and row.last_seen > row.first_seen
        fresh_close = (
            row.last_seen
            and (now - row.last_seen) <= timedelta(minutes=_TRACK_CLOSE_WINDOW_MIN)
        )
        if not (sighted_twice and fresh_close):
            continue  # closed, unlabeled

        delay = (row.last_estimate - row.first_estimate).total_seconds()
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


# ── Snapshot persistence (shared by collector + passive user queries) ─────────

def persist_arrival_payload(
    stop_code: str,
    services: list[dict],
    now: datetime,
    track: bool = True,
) -> int:
    """
    Persist one LTA arrival payload as BusArrivalRecord rows and (optionally)
    update ground-truth tracking. Creates and closes its own DB session, so it
    is safe to run as a FastAPI background task or from the collector loop.

    track=False is used for rotation-scan stops, which are sampled too
    sparsely for the disappearance method to produce valid labels.
    """
    if not services:
        return 0

    sgt = now + timedelta(hours=8)
    is_wkend = sgt.weekday() >= 5

    db = SessionLocal()
    saved = 0
    try:
        active_keys_by_service: dict[str, set[datetime]] = {}

        for svc in services:
            service_no = svc.get("ServiceNo", "")
            active_keys_by_service.setdefault(service_no, set())

            for slot_idx, slot_key in enumerate(["NextBus", "NextBus2", "NextBus3"], start=1):
                bus = svc.get(slot_key) or {}
                estimated = _parse_dt(bus.get("EstimatedArrival"))
                if estimated is None:
                    continue

                db.add(BusArrivalRecord(
                    bus_stop_code     = stop_code,
                    bus_service       = service_no,
                    collection_time   = now,
                    estimated_arrival = estimated,
                    wait_seconds      = (estimated - now).total_seconds(),
                    hour_of_day       = sgt.hour,
                    day_of_week       = sgt.weekday(),
                    is_peak           = _is_peak(sgt.hour, is_wkend),
                    is_weekend        = is_wkend,
                    bus_load          = bus.get("Load"),
                    bus_type          = bus.get("Type"),
                    slot              = slot_idx,
                ))
                saved += 1

                # Only track the next bus (slot 1) to derive clean ground truth
                if track and slot_idx == 1:
                    _upsert_tracking(db, stop_code, service_no, now, estimated)
                    active_keys_by_service[service_no].add(_round_dt(estimated))

        if track:
            for service_no, active_keys in active_keys_by_service.items():
                _close_stale_tracking(db, stop_code, service_no, active_keys, now)

        db.commit()
    except Exception as exc:
        logger.error("DB error persisting stop %s: %s", stop_code, exc)
        db.rollback()
        saved = 0
    finally:
        db.close()

    return saved


# ── Per-stop collection ───────────────────────────────────────────────────────

async def collect_stop(
    client: httpx.AsyncClient, stop_code: str, now: datetime, track: bool = True
) -> int:
    """Fetch arrivals for one stop and persist. Returns rows saved."""
    data = await fetch_arrivals(client, stop_code)
    return persist_arrival_payload(stop_code, data.get("Services", []), now, track=track)


# ── Rotation scan ─────────────────────────────────────────────────────────────

def _rotation_batch(db: Session, exclude: set[str]) -> list[str]:
    """
    Return the next ROTATION_BATCH_SIZE stop codes from the full directory,
    advancing a module-level cursor so successive cycles sweep all of
    Singapore's ~5,000 stops over the course of the day.
    """
    global _rotation_cursor
    if ROTATION_BATCH_SIZE <= 0:
        return []
    codes = [
        c for (c,) in db.query(BusStop.bus_stop_code).order_by(BusStop.bus_stop_code).all()
        if c not in exclude
    ]
    if not codes:
        return []
    start = _rotation_cursor % len(codes)
    batch = (codes[start:] + codes[:start])[:ROTATION_BATCH_SIZE]
    _rotation_cursor = (start + ROTATION_BATCH_SIZE) % len(codes)
    return batch


# ── Data hygiene ──────────────────────────────────────────────────────────────

def _prune_old_data() -> None:
    """Drop unlabeled snapshots and stale tracking rows so the SQLite file
    doesn't grow without bound (rotation + passive collection add volume)."""
    db = SessionLocal()
    try:
        cutoff_records  = datetime.utcnow() - timedelta(days=_PRUNE_UNLABELED_DAYS)
        cutoff_tracking = datetime.utcnow() - timedelta(days=_PRUNE_TRACKING_DAYS)
        n1 = (
            db.query(BusArrivalRecord)
            .filter(
                BusArrivalRecord.delay_seconds.is_(None),
                BusArrivalRecord.collection_time < cutoff_records,
            )
            .delete(synchronize_session=False)
        )
        n2 = (
            db.query(BusTracking)
            .filter(BusTracking.is_closed.is_(True), BusTracking.first_seen < cutoff_tracking)
            .delete(synchronize_session=False)
        )
        db.commit()
        if n1 or n2:
            logger.info("Pruned %d unlabeled records, %d old tracking rows", n1, n2)
    except Exception as exc:
        logger.error("Prune failed: %s", exc)
        db.rollback()
    finally:
        db.close()


# ── Main loop ─────────────────────────────────────────────────────────────────

async def start_data_collection() -> None:
    """
    Infinite async loop.  Runs every COLLECTION_INTERVAL_MINUTES minutes.
    Also triggers model retraining every MODEL_RETRAIN_INTERVAL_HOURS hours
    and a daily data prune.
    """
    interval_sec  = COLLECTION_INTERVAL_MINUTES * 60
    retrain_every = MODEL_RETRAIN_INTERVAL_HOURS * 3600
    last_retrain  = 0.0
    last_prune    = 0.0

    logger.info(
        "Data collector started  interval=%dm  rotation_batch=%d  retrain every %sh",
        COLLECTION_INTERVAL_MINUTES, ROTATION_BATCH_SIZE, MODEL_RETRAIN_INTERVAL_HOURS,
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
                monitored = [
                    s.bus_stop_code
                    for s in db.query(MonitoredStop).filter_by(is_active=True).all()
                ]
                rotation = _rotation_batch(db, exclude=set(monitored))
            finally:
                db.close()

            tasks = (
                [collect_stop(client, code, now, track=True) for code in monitored]
                + [collect_stop(client, code, now, track=False) for code in rotation]
            )
            if tasks:
                results = await asyncio.gather(*tasks, return_exceptions=True)
                total   = sum(r for r in results if isinstance(r, int))
                logger.info(
                    "Collected %d records  (%d monitored + %d rotation stops)",
                    total, len(monitored), len(rotation),
                )

            # Periodic model retraining
            elapsed = time.monotonic() - last_retrain
            if elapsed >= retrain_every:
                last_retrain = time.monotonic()  # always advance so failures don't cause infinite retries
                logger.info("Triggering scheduled model retrain")
                try:
                    global_model.retrain_from_db()
                except Exception as exc:
                    logger.exception("Model retrain failed: %s", exc)

            # Daily prune
            if time.monotonic() - last_prune >= 24 * 3600:
                last_prune = time.monotonic()
                _prune_old_data()

            await asyncio.sleep(interval_sec)
