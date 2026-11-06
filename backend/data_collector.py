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

# Re-linking a bus across polls: its estimate may move this much between
# sightings, and sightings may be at most _LINK_GAP apart. The same gap is
# required for a disappearance to count as an arrival (continuous polling).
_LINK_TOL = timedelta(seconds=240)
_LINK_GAP = timedelta(seconds=max(330, COLLECTION_INTERVAL_MINUTES * 60 + 30))
# How far before slot-1 tracking began to look for the bus's slot 2-3 sightings.
_EARLIER_SLOTS_LOOKBACK = timedelta(minutes=30)
# A bus counts as due (so its disappearance as an arrival) once its last
# estimate is within this of the closing poll.
_DUE_GRACE = timedelta(seconds=60)

# Fast tracking: monitored stops with a tracked bus due within this window
# are re-polled every FAST_POLL_SEC, so arrivals are pinned to about a minute
# instead of the 5-minute collection interval.
FAST_POLL_SEC = 60
_FAST_WINDOW = timedelta(minutes=5)

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
) -> datetime:
    """Open or update a BusTracking row for this bus; return its arrival_key.

    The same bus is re-found by tolerance, not by its exact estimate minute:
    the open row whose last estimate is within _LINK_TOL of this one, seen
    within _LINK_GAP, and not already due (a bus whose estimate passed a
    minute ago has arrived; the new slot-1 bus is the one behind it). Exact
    minute keys mistook every estimate move of ~30 s or more for an arrival.
    """
    candidates = (
        db.query(BusTracking)
        .filter_by(bus_stop_code=stop_code, bus_service=service_no, is_closed=False)
        .all()
    )
    best = None
    for row in candidates:
        if row.last_seen is None or now - row.last_seen > _LINK_GAP:
            continue
        if row.last_estimate < now - _DUE_GRACE:
            continue
        diff = abs((row.last_estimate - estimated).total_seconds())
        if diff <= _LINK_TOL.total_seconds() and (best is None or diff < best[0]):
            best = (diff, row)
    if best is not None:
        row = best[1]
        row.last_seen     = now
        row.last_estimate = estimated
        return row.arrival_key

    # arrival_key is unique per (stop, service) and only identifies the row
    # now, so step past any earlier bus that rounded to the same minute.
    key = _round_dt(estimated)
    while (
        db.query(BusTracking.id)
        .filter_by(bus_stop_code=stop_code, bus_service=service_no, arrival_key=key)
        .first()
    ):
        key += timedelta(seconds=1)
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
    db.flush()
    return key


def _close_stale_tracking(db: Session, stop_code: str, service_no: str,
                          active_keys: set[datetime], now: datetime) -> None:
    """
    Close tracking rows that were NOT re-found in the current API response.

    Quality guard: only write a delay label if the bus was sighted at least
    twice, the closing poll came soon after the last sighting, AND the bus
    was actually due by now. A bus that vanished while still minutes away
    was dropped from the feed or re-planned, not arrived — closed unlabeled.
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
        fresh_close = row.last_seen and (now - row.last_seen) <= _LINK_GAP
        was_due = row.last_estimate <= now + _DUE_GRACE
        if not (sighted_twice and fresh_close and was_due):
            continue  # closed, unlabeled

        # The last estimate before the bus vanished is our best proxy for when
        # it actually arrived.
        actual = row.last_estimate
        # Lifetime drift, kept on the tracking row for reporting.
        delay = (actual - row.first_estimate).total_seconds()
        row.delay_seconds = delay

        # Label each snapshot of this bus with its OWN residual — how much
        # further that particular estimate still had to slip:
        #     residual_i = actual − estimated_arrival_i
        # Snapshots are found by time sighted plus the range its estimate
        # moved through, since the estimate can drift minutes over a journey.
        # The time window reaches back before first_seen to pick up the same
        # bus's earlier sightings in slots 2-3 (only slot 1 is tracked) — the
        # far-out readings, where LTA's error is largest.
        lo = min(row.first_estimate, row.last_estimate) - timedelta(minutes=2)
        hi = max(row.first_estimate, row.last_estimate) + timedelta(minutes=2)
        pending = (
            db.query(BusArrivalRecord)
            .filter(
                BusArrivalRecord.bus_stop_code == stop_code,
                BusArrivalRecord.bus_service   == service_no,
                BusArrivalRecord.estimated_arrival.between(lo, hi),
                BusArrivalRecord.collection_time.between(
                    row.first_seen - _EARLIER_SLOTS_LOOKBACK, row.last_seen),
                BusArrivalRecord.delay_seconds.is_(None),
            )
            .all()
        )
        for rec in pending:
            rec.delay_seconds = (actual - rec.estimated_arrival).total_seconds()
            rec.label_v = 2
        logger.debug("Closed tracking %s/%s  drift=%.0fs  labelled %d snapshot(s)",
                     stop_code, service_no, delay, len(pending))


# ── Snapshot persistence (shared by collector + passive user queries) ─────────

def persist_arrival_payload(
    stop_code: str,
    services: list[dict],
    now: datetime,
    track: bool = True,
    snapshots: bool = True,
) -> int:
    """
    Persist one LTA arrival payload as BusArrivalRecord rows and (optionally)
    update ground-truth tracking. snapshots=False only updates tracking (the
    fast arrival polls, which would otherwise multiply the table's growth). Creates and closes its own DB session, so it
    is safe to run as a FastAPI background task or from the collector loop.

    track=False is used for rotation-scan stops, which are sampled too
    sparsely for the disappearance method to produce valid labels.
    """
    # An empty payload still matters when tracking: it means every previously
    # sighted bus is gone (e.g. service ended for the night), which is exactly
    # when their tracking rows should close and produce labels.
    if not services and not track:
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

                if snapshots:
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
                    active_keys_by_service[service_no].add(
                        _upsert_tracking(db, stop_code, service_no, now, estimated))

        if track:
            # Close open rows for EVERY service with tracking at this stop,
            # not just services present in this payload. A service that
            # vanished from the response entirely (last bus of the night) is
            # precisely the case where ground truth should be written — only
            # iterating payload services would leave those rows open until
            # the labelling window expired.
            open_services = {
                s for (s,) in db.query(BusTracking.bus_service)
                .filter_by(bus_stop_code=stop_code, is_closed=False)
                .distinct()
            }
            for service_no in open_services:
                _close_stale_tracking(
                    db, stop_code, service_no,
                    active_keys_by_service.get(service_no, set()), now,
                )

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
    if "Services" not in data:
        # Failed fetch, not an empty stop: closing every tracked bus on an API
        # hiccup would label them all as arrived.
        return 0
    return persist_arrival_payload(stop_code, data["Services"], now, track=track)


async def start_fast_tracking() -> None:
    """Re-poll monitored stops every FAST_POLL_SEC while a tracked bus there is
    due within _FAST_WINDOW (tracking only, no snapshots). The 5-minute cycle
    alone can only place an arrival somewhere in a 5-minute gap."""
    async with httpx.AsyncClient() as client:
        while True:
            await asyncio.sleep(FAST_POLL_SEC)
            if not _is_service_hours():
                continue
            try:
                now = datetime.now(timezone.utc).replace(tzinfo=None)
                db = SessionLocal()
                try:
                    stops = [
                        code for (code,) in db.query(BusTracking.bus_stop_code)
                        .join(MonitoredStop, MonitoredStop.bus_stop_code == BusTracking.bus_stop_code)
                        .filter(
                            MonitoredStop.is_active.is_(True),
                            BusTracking.is_closed.is_(False),
                            BusTracking.last_seen >= now - _LINK_GAP,
                            BusTracking.last_estimate <= now + _FAST_WINDOW,
                        )
                        .distinct()
                    ]
                finally:
                    db.close()
                for code in stops:
                    data = await fetch_arrivals(client, code)
                    if "Services" in data:
                        persist_arrival_payload(code, data["Services"], now,
                                                track=True, snapshots=False)
            except Exception:
                logger.exception("Fast tracking cycle failed")


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
        # Open rows that never closed (one-off passive queries, discontinued
        # services, deactivated stops) would otherwise accumulate forever.
        n3 = (
            db.query(BusTracking)
            .filter(BusTracking.is_closed.is_(False), BusTracking.last_seen < cutoff_tracking)
            .delete(synchronize_session=False)
        )
        db.commit()
        if n1 or n2 or n3:
            logger.info("Pruned %d unlabeled records, %d closed + %d stale-open tracking rows",
                        n1, n2, n3)
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

            # One bad cycle (e.g. "database is locked" outlasting the busy
            # timeout while a retrain or big admin query holds the lock) must
            # never kill this task for good — it would silently stop all data
            # collection until the service is manually restarted.
            try:
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
            except Exception:
                logger.exception("Collection cycle failed; retrying next interval")

            # Periodic model retraining
            elapsed = time.monotonic() - last_retrain
            if elapsed >= retrain_every:
                last_retrain = time.monotonic()  # always advance so failures don't cause infinite retries
                logger.info("Triggering scheduled model retrain")
                try:
                    # Training fits a 200-estimator GBR on ~35k rows — seconds of
                    # CPU. Off the event loop so API requests don't stall.
                    await asyncio.to_thread(global_model.retrain_from_db)
                except Exception as exc:
                    logger.exception("Model retrain failed: %s", exc)

            # Daily prune
            if time.monotonic() - last_prune >= 24 * 3600:
                last_prune = time.monotonic()
                _prune_old_data()

            await asyncio.sleep(interval_sec)
