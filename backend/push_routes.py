"""
Web Push bus alerts: pings that reach the phone even when the app is closed.

Phones pause web apps in the background, so an alert that only runs in the
page fires late or not at all. Instead the app hands the alert to the server
with its push subscription; a background loop here watches LTA arrivals and
sends a Web Push when it's time. Works on Android browsers and on iPhone for
apps added to the Home Screen (iOS 16.4+).

GET    /api/push/key           VAPID public key (or enabled=false)
POST   /api/push/alerts        create an alert   → {"id": ...}
DELETE /api/push/alerts/{id}   cancel it (the id is the secret)

Alert kinds
-----------
arrive  "Bus 858 arriving in ~2 min" at the stop you're waiting at. Buses due
        before `skip_until` are ignored (used for "ping me for the next one").

alight  You're riding (or about to board) a bus and want a heads-up one stop
        before your stop. The server can't see the rider's phone, so it
        follows the *bus*: LTA publishes each approaching bus's live position.
        The rider's bus is identified at the boarding stop (by its arrival
        time, or as the last bus to have passed that stop if already on
        board), then matched poll by poll to the nearest bus at the stop
        before the destination. When that bus is ~30 s from it, we push "Your
        stop is next".

Requires `pywebpush` (in requirements.txt). If it isn't installed, push is
reported as disabled and the app falls back to in-app alerts.
"""

import asyncio
import json
import logging
import math
import os
import re
import secrets
from datetime import datetime, timedelta
from pathlib import Path as FsPath
from urllib.parse import urlparse

import pydantic
from fastapi import APIRouter, HTTPException, Path, Request

from database import PushAlert, SessionLocal

logger = logging.getLogger(__name__)
router = APIRouter()

try:  # optional dependency
    from py_vapid import Vapid01
    from pywebpush import WebPushException, webpush
    from cryptography.hazmat.primitives import serialization
    _PUSH_LIB = True
except ImportError:  # pragma: no cover
    _PUSH_LIB = False

_KEY_FILE = FsPath(__file__).with_name("vapid_private.pem")
_CLAIMS = {"sub": os.getenv("VAPID_SUBJECT", "https://alstonshi.com/bus/")}
_vapid = None
_public_key_b64 = None

# Only real browser push services, so the server can never be pointed at an
# arbitrary URL (SSRF).
_PUSH_HOSTS = re.compile(
    r"^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com"
    r"|[a-z0-9.-]*push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]*\.notify\.windows\.com"
    r"|[a-z0-9.-]*\.push\.apple\.com)$"
)
_STOP_RE = re.compile(r"^\d{5}$")
_SVC_RE = re.compile(r"^[0-9A-Za-z]{1,6}$")

MAX_PER_DEVICE = 8
MAX_TOTAL = 1000
ALERT_TTL = timedelta(hours=3)
POLL_SEC = 15
ARRIVE_SEC = 120       # "arriving in ~2 min"
ALIGHT_SEC = 35        # bus is about at the stop before yours


def _load_keys() -> None:
    """Load the VAPID signing key, generating and saving one on first run."""
    global _vapid, _public_key_b64
    if not _PUSH_LIB or _vapid is not None:
        return
    try:
        if _KEY_FILE.exists():
            v = Vapid01.from_file(str(_KEY_FILE))
        else:
            v = Vapid01()
            v.generate_keys()
            v.save_key(str(_KEY_FILE))
            os.chmod(_KEY_FILE, 0o600)
            logger.info("Generated a new Web Push (VAPID) key at %s", _KEY_FILE)
        raw = v.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        import base64
        _public_key_b64 = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
        _vapid = v
    except Exception as exc:  # noqa: BLE001
        logger.warning("Web Push disabled — could not load VAPID key: %s", exc)


def push_enabled() -> bool:
    _load_keys()
    return _vapid is not None


# ── API ──────────────────────────────────────────────────────────────────────

class _Keys(pydantic.BaseModel):
    p256dh: str = pydantic.Field(..., max_length=200)
    auth: str = pydantic.Field(..., max_length=100)


class _Sub(pydantic.BaseModel):
    endpoint: str = pydantic.Field(..., max_length=1000)
    keys: _Keys


class AlertIn(pydantic.BaseModel):
    subscription: _Sub
    kind: str = pydantic.Field(..., pattern="^(arrive|alight)$")
    service_no: str
    stop: str                       # arrive: your stop · alight: the stop before your destination
    board_stop: str | None = None   # alight only
    dest_stop: str | None = None    # alight only
    stop_name: str | None = pydantic.Field(None, max_length=120)
    skip_until: str | None = pydantic.Field(None, max_length=40)   # UTC ISO, as /api/arrivals returns
    # alight, already on board: the rider's own position = the bus's position
    rider_lat: float | None = pydantic.Field(None, ge=1.1, le=1.5)
    rider_lng: float | None = pydantic.Field(None, ge=103.5, le=104.1)


@router.get("/push/key")
def push_key() -> dict:
    return {"enabled": push_enabled(), "key": _public_key_b64}


@router.post("/push/alerts")
def create_alert(body: AlertIn, request: Request) -> dict:
    if not push_enabled():
        raise HTTPException(status_code=503, detail="Push notifications aren't set up on the server.")
    host = (urlparse(body.subscription.endpoint).hostname or "").lower()
    if urlparse(body.subscription.endpoint).scheme != "https" or not _PUSH_HOSTS.match(host):
        raise HTTPException(status_code=400, detail="Unsupported push service.")
    if not _SVC_RE.match(body.service_no) or not _STOP_RE.match(body.stop):
        raise HTTPException(status_code=400, detail="Invalid stop or service.")
    if body.kind == "alight":
        if not (body.board_stop and _STOP_RE.match(body.board_stop) and body.dest_stop and _STOP_RE.match(body.dest_stop)):
            raise HTTPException(status_code=400, detail="Missing boarding or destination stop.")
    skip = None
    if body.skip_until:
        try:
            skip = datetime.fromisoformat(body.skip_until.replace("Z", "")).replace(tzinfo=None)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid skip_until.")

    db = SessionLocal()
    try:
        now = datetime.utcnow()
        db.query(PushAlert).filter(PushAlert.expires_at < now).delete()
        if db.query(PushAlert).count() >= MAX_TOTAL:
            raise HTTPException(status_code=503, detail="Too many alerts right now. Try again later.")
        mine = db.query(PushAlert).filter_by(endpoint=body.subscription.endpoint)
        # Same kind + bus + stop replaces the old one instead of stacking.
        mine.filter_by(kind=body.kind, service_no=body.service_no, watch_stop=body.stop).delete()
        if mine.count() >= MAX_PER_DEVICE:
            raise HTTPException(status_code=400, detail=f"Up to {MAX_PER_DEVICE} alerts at a time.")
        aid = secrets.token_urlsafe(24)
        db.add(PushAlert(
            id=aid, kind=body.kind, endpoint=body.subscription.endpoint,
            p256dh=body.subscription.keys.p256dh, auth=body.subscription.keys.auth,
            service_no=body.service_no.upper(), watch_stop=body.stop,
            board_stop=body.board_stop, dest_stop=body.dest_stop,
            title_stop=(body.stop_name or "").strip() or None, skip_until=skip,
            phase=("boarding" if skip else "riding") if body.kind == "alight" else None,
            bus_lat=body.rider_lat if body.kind == "alight" and not skip else None,
            bus_lng=body.rider_lng if body.kind == "alight" and not skip else None,
            created_at=now, expires_at=now + ALERT_TTL,
        ))
        db.commit()
        return {"id": aid}
    finally:
        db.close()


@router.delete("/push/alerts/{alert_id}")
def delete_alert(alert_id: str = Path(..., max_length=40)) -> dict:
    db = SessionLocal()
    try:
        db.query(PushAlert).filter_by(id=alert_id).delete()
        db.commit()
    finally:
        db.close()
    return {"status": "cancelled"}


# ── Background watcher ───────────────────────────────────────────────────────

def _buses(payload: dict, service_no: str) -> list[dict]:
    """The service's upcoming buses at a stop: [{eta (UTC naive), lat, lng}]."""
    from api_routes import _parse_lta_dt
    for svc in payload.get("Services", []) or []:
        if str(svc.get("ServiceNo", "")).upper() != service_no:
            continue
        out = []
        for key in ("NextBus", "NextBus2", "NextBus3"):
            b = svc.get(key) or {}
            eta = _parse_lta_dt(b.get("EstimatedArrival"))
            if eta is None or eta.year < 2000:
                continue
            try:
                lat, lng = float(b.get("Latitude") or 0), float(b.get("Longitude") or 0)
            except (TypeError, ValueError):
                lat = lng = 0.0
            out.append({"eta": eta, "lat": lat or None, "lng": lng or None})
        return out
    return []


def _dist_m(a_lat, a_lng, b_lat, b_lng) -> float:
    if None in (a_lat, a_lng, b_lat, b_lng):
        return math.inf
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6_371_000 * 2 * math.asin(min(1.0, math.sqrt(h)))


def _nearest(buses: list[dict], lat, lng, max_m: float) -> dict | None:
    best = min(buses, key=lambda b: _dist_m(lat, lng, b["lat"], b["lng"]), default=None)
    return best if best and _dist_m(lat, lng, best["lat"], best["lng"]) <= max_m else None


_last_seen: dict[str, datetime] = {}   # alert id → when its bus was last matched


def _decide(a: PushAlert, stops: dict[str, list[dict]], now: datetime) -> tuple[bool, str, str] | None:
    """Return (fire, title, body) when the alert should be sent now, else None.
    Mutates the alert's tracking fields (bus position / phase) as it goes."""
    svc = a.service_no
    if a.kind == "arrive":
        cutoff = (a.skip_until + timedelta(seconds=30)) if a.skip_until else None
        for b in stops.get(a.watch_stop, []):
            if cutoff and b["eta"] <= cutoff:
                continue
            secs = (b["eta"] - now).total_seconds()
            # (down to -2 min: an early bus can skip past the window between polls)
            if -120 < secs <= ARRIVE_SEC:
                when = "now" if secs < 45 else f"in ~{max(1, round(secs / 60))} min"
                return True, f"Bus {svc} arriving {when}", a.title_stop or f"Stop {a.watch_stop}"
            return None
        return None

    # alight — follow the rider's bus.
    at_board = stops.get(a.board_stop, [])
    at_watch = stops.get(a.watch_stop, [])
    if a.phase == "boarding":
        # `skip_until` holds the rider's bus's arrival time at the boarding
        # stop. Follow it by that time (±3 min) — never by position alone,
        # which would latch onto the next bus once the rider's has left.
        if a.skip_until is None or a.skip_until < now - timedelta(minutes=3):
            a.phase = "riding"         # already on board
        else:
            near = [x for x in at_board if abs((x["eta"] - a.skip_until).total_seconds()) <= 180]
            b = min(near, key=lambda x: abs((x["eta"] - a.skip_until).total_seconds()), default=None)
            if b and (b["eta"] - now).total_seconds() > -20:
                a.skip_until = b["eta"]
                if b["lat"] is not None:
                    a.bus_lat, a.bus_lng = b["lat"], b["lng"]
                    _last_seen[a.id] = now
                return None
            if b is None and at_board and a.skip_until > now + timedelta(seconds=20):
                return None            # bus not in LTA's window yet; keep waiting
            a.phase = "riding"         # it has left the boarding stop
            if a.watch_stop == a.board_stop:   # your stop is the one right after boarding
                return True, "Your stop is next", f"Get ready to get off bus {svc} at {a.title_stop or a.dest_stop}"

    # Riding: buses still heading to the boarding stop are behind the rider.
    behind = [x for x in at_board if x["lat"] is not None]
    ahead = [x for x in at_watch if x["lat"] is not None
             and not any(_dist_m(x["lat"], x["lng"], y["lat"], y["lng"]) < 60 for y in behind)]
    if a.bus_lat is None:
        # Already on board when the alert was set: the rider's bus is the last
        # one to have passed the boarding stop, i.e. the latest-arriving of
        # the buses ahead of it.
        if not ahead:
            return None
        b = max(ahead, key=lambda x: x["eta"])
    else:
        # A bus covers at most ~20 m/s; anything farther is a different bus.
        since = (now - _last_seen.get(a.id, now - timedelta(seconds=POLL_SEC))).total_seconds()
        b = _nearest(ahead, a.bus_lat, a.bus_lng, 300 + 20 * max(since, POLL_SEC))
        if b is None:
            return None                # not within LTA's next-3 window for that stop yet
    a.bus_lat, a.bus_lng = b["lat"], b["lng"]
    _last_seen[a.id] = now
    secs = (b["eta"] - now).total_seconds()
    if secs <= ALIGHT_SEC:
        return True, "Your stop is next", f"Get ready to get off bus {svc} at {a.title_stop or a.dest_stop}"
    return None


def _send(a: PushAlert, title: str, body: str) -> bool | None:
    """True = sent, None = subscription gone (drop it), False = temporary failure."""
    payload = json.dumps({"title": title, "body": body, "tag": f"sgbus-{a.kind}-{a.service_no}-{a.watch_stop}",
                          "url": "./"})
    try:
        webpush(subscription_info={"endpoint": a.endpoint, "keys": {"p256dh": a.p256dh, "auth": a.auth}},
                data=payload, vapid_private_key=_vapid, vapid_claims=dict(_CLAIMS), ttl=120, timeout=10)
        return True
    except WebPushException as exc:
        code = getattr(exc.response, "status_code", None)
        if code in (404, 410):
            return None
        logger.warning("Web Push failed (%s): %s", code, exc)
        return False
    except Exception as exc:  # noqa: BLE001
        logger.warning("Web Push failed: %s", exc)
        return False


async def run_once() -> int:
    """One pass over pending alerts. Returns how many were sent."""
    from api_routes import _call_lta
    db = SessionLocal()
    sent = 0
    try:
        now = datetime.utcnow()
        db.query(PushAlert).filter(PushAlert.expires_at < now).delete()
        alerts = db.query(PushAlert).all()
        if not alerts:
            db.commit()
            return 0
        needed = {s for a in alerts for s in (a.watch_stop, a.board_stop) if s}
        payloads: dict[str, dict] = {}
        for stop in needed:
            try:
                payloads[stop], _ = await _call_lta(stop)
            except Exception:  # noqa: BLE001 — skip this stop this round
                pass
        for a in alerts:
            stops = {s: _buses(payloads[s], a.service_no) for s in (a.watch_stop, a.board_stop) if s and s in payloads}
            decision = _decide(a, stops, now)
            if not decision:
                continue
            _, title, body = decision
            ok = await asyncio.to_thread(_send, a, title, body)
            if ok is None:
                db.query(PushAlert).filter_by(endpoint=a.endpoint).delete()
            elif ok:
                db.delete(a)
                sent += 1
        db.commit()
    finally:
        db.close()
    return sent


async def push_watcher() -> None:
    if not push_enabled():
        logger.info("Web Push not available (pywebpush missing or key error) — alerts stay in-app.")
        return
    await asyncio.sleep(10)
    while True:
        try:
            await run_once()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Push watcher pass failed: %s", exc)
        await asyncio.sleep(POLL_SEC)
