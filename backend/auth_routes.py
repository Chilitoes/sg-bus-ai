"""
Account + favourites router.

Deliberately simple:
- Passwords hashed with salted PBKDF2-HMAC-SHA256 (stdlib, no extra deps).
- Sessions are opaque random tokens stored in the DB (revocable per device).
- Clients send  Authorization: Bearer <token>.

Endpoints
---------
POST /api/auth/register        {username, password} -> {token, username}
POST /api/auth/login           {username, password} -> {token, username}
POST /api/auth/logout          (auth) revoke current token
GET  /api/auth/me              (auth) account info
GET  /api/favourites           (auth) list favourites
POST /api/favourites/{code}    (auth) add favourite
DELETE /api/favourites/{code}  (auth) remove favourite
POST /api/favourites/sync      (auth) merge a local list into the account,
                               returns the merged server list
"""

import hashlib
import hmac
import re
import secrets
import time
from collections import defaultdict
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import User, UserFavourite, UserSession, MonitoredStop, SavedJourney, get_db

router = APIRouter()

PBKDF2_ITERATIONS = 200_000
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")
MAX_FAVOURITES = 30
MAX_SAVED_JOURNEYS = 30

# Naive in-memory throttle: 20 auth attempts per IP per 15 minutes.
_attempts: dict[str, list[float]] = defaultdict(list)
_ATTEMPT_WINDOW_SEC = 15 * 60
_ATTEMPT_LIMIT = 20


# ── Password hashing ──────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _algo, iters, salt_hex, dk_hex = stored.split("$")
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(iters)
        )
        return hmac.compare_digest(dk.hex(), dk_hex)
    except Exception:
        return False


def _throttle(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    _attempts[ip] = [t for t in _attempts[ip] if now - t < _ATTEMPT_WINDOW_SEC]
    if len(_attempts[ip]) >= _ATTEMPT_LIMIT:
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")
    _attempts[ip].append(now)


# ── Auth dependency ───────────────────────────────────────────────────────────

def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not logged in")
    token = authorization.removeprefix("Bearer ").strip()
    session = db.query(UserSession).filter_by(token=token).first()
    if session is None:
        raise HTTPException(status_code=401, detail="Session expired. Log in again.")
    user = db.query(User).filter_by(id=session.user_id).first()
    if user is None:
        raise HTTPException(status_code=401, detail="Account no longer exists")
    session.last_used = datetime.utcnow()
    db.commit()
    return user


def _issue_token(db: Session, user_id: int) -> str:
    token = secrets.token_hex(32)
    db.add(UserSession(token=token, user_id=user_id))
    db.commit()
    return token


# ── Schemas ───────────────────────────────────────────────────────────────────

class Credentials(BaseModel):
    username: str
    password: str


class FavouriteIn(BaseModel):
    description: str | None = None
    road_name: str | None = None


class FavouriteList(BaseModel):
    favourites: list[dict] = []


def _fav_out(f: UserFavourite) -> dict:
    return {
        "code": f.bus_stop_code,
        "description": f.description,
        "road_name": f.road_name,
    }


def _ensure_monitored(db: Session, stop_code: str) -> None:
    """Favourited stops join the background collector so they build history."""
    existing = db.query(MonitoredStop).filter_by(bus_stop_code=stop_code).first()
    if existing:
        existing.is_active = True
    else:
        db.add(MonitoredStop(bus_stop_code=stop_code))


# ── Auth endpoints ────────────────────────────────────────────────────────────

@router.post("/auth/register")
def register(creds: Credentials, request: Request, db: Session = Depends(get_db)) -> dict:
    _throttle(request)
    username = creds.username.strip()
    if not USERNAME_RE.match(username):
        raise HTTPException(
            status_code=400,
            detail="Username must be 3-20 characters: letters, numbers, underscores.",
        )
    if len(creds.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    exists = db.query(User).filter(func.lower(User.username) == username.lower()).first()
    if exists:
        raise HTTPException(status_code=409, detail="That username is taken.")
    user = User(username=username, password_hash=hash_password(creds.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"token": _issue_token(db, user.id), "username": user.username}


@router.post("/auth/login")
def login(creds: Credentials, request: Request, db: Session = Depends(get_db)) -> dict:
    _throttle(request)
    username = creds.username.strip()
    user = db.query(User).filter(func.lower(User.username) == username.lower()).first()
    if user is None or not verify_password(creds.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Wrong username or password.")
    return {"token": _issue_token(db, user.id), "username": user.username}


@router.post("/auth/logout")
def logout(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    if authorization and authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()
        db.query(UserSession).filter_by(token=token).delete()
        db.commit()
    return {"status": "ok"}


@router.get("/auth/me")
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    fav_count = db.query(func.count(UserFavourite.id)).filter_by(user_id=user.id).scalar() or 0
    journey_count = db.query(func.count(SavedJourney.id)).filter_by(user_id=user.id).scalar() or 0
    return {
        "username": user.username,
        "created_at": user.created_at.isoformat(),
        "favourite_count": fav_count,
        "journey_count": journey_count,
    }


# ── Favourites endpoints ──────────────────────────────────────────────────────

@router.get("/favourites")
def list_favourites(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    favs = (
        db.query(UserFavourite)
        .filter_by(user_id=user.id)
        .order_by(UserFavourite.added_at.desc())
        .all()
    )
    return {"favourites": [_fav_out(f) for f in favs]}


@router.post("/favourites/{stop_code}")
def add_favourite(
    stop_code: str,
    body: FavouriteIn | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    count = db.query(func.count(UserFavourite.id)).filter_by(user_id=user.id).scalar() or 0
    existing = (
        db.query(UserFavourite)
        .filter_by(user_id=user.id, bus_stop_code=stop_code)
        .first()
    )
    if existing is None:
        if count >= MAX_FAVOURITES:
            raise HTTPException(status_code=400, detail=f"Limit of {MAX_FAVOURITES} favourites reached.")
        db.add(UserFavourite(
            user_id=user.id,
            bus_stop_code=stop_code,
            description=body.description if body else None,
            road_name=body.road_name if body else None,
        ))
    elif body:
        existing.description = body.description or existing.description
        existing.road_name = body.road_name or existing.road_name
    _ensure_monitored(db, stop_code)
    db.commit()
    return {"status": "added", "code": stop_code}


@router.delete("/favourites/{stop_code}")
def remove_favourite(
    stop_code: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    db.query(UserFavourite).filter_by(user_id=user.id, bus_stop_code=stop_code).delete()
    db.commit()
    return {"status": "removed", "code": stop_code}


class SavedJourneyIn(BaseModel):
    from_name: str
    from_lat: float
    from_lng: float
    to_name: str
    to_lat: float
    to_lng: float


def _journey_out(j: SavedJourney) -> dict:
    return {
        "id": j.id,
        "from_name": j.from_name,
        "from_lat": j.from_lat,
        "from_lng": j.from_lng,
        "to_name": j.to_name,
        "to_lat": j.to_lat,
        "to_lng": j.to_lng,
        "saved_at": j.saved_at.isoformat(),
    }


@router.get("/saved-journeys")
def list_saved_journeys(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    journeys = (
        db.query(SavedJourney)
        .filter_by(user_id=user.id)
        .order_by(SavedJourney.saved_at.desc())
        .all()
    )
    return {"journeys": [_journey_out(j) for j in journeys]}


@router.post("/saved-journeys")
def save_journey(
    body: SavedJourneyIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    existing = (
        db.query(SavedJourney)
        .filter_by(user_id=user.id,
                   from_lat=body.from_lat, from_lng=body.from_lng,
                   to_lat=body.to_lat, to_lng=body.to_lng)
        .first()
    )
    if existing:
        return _journey_out(existing)
    count = db.query(func.count(SavedJourney.id)).filter_by(user_id=user.id).scalar() or 0
    if count >= MAX_SAVED_JOURNEYS:
        raise HTTPException(status_code=400, detail=f"Limit of {MAX_SAVED_JOURNEYS} saved routes reached.")
    j = SavedJourney(
        user_id=user.id,
        from_name=body.from_name, from_lat=body.from_lat, from_lng=body.from_lng,
        to_name=body.to_name,   to_lat=body.to_lat,   to_lng=body.to_lng,
    )
    db.add(j)
    db.commit()
    db.refresh(j)
    return _journey_out(j)


@router.delete("/saved-journeys/{journey_id}")
def delete_saved_journey(
    journey_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    j = db.query(SavedJourney).filter_by(id=journey_id, user_id=user.id).first()
    if j:
        db.delete(j)
        db.commit()
    return {"status": "removed", "id": journey_id}


@router.post("/favourites/sync")
def sync_favourites(
    body: FavouriteList,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Merge a client-side (localStorage) list into the account, then return
    the merged server list. Used once right after login/register."""
    existing_codes = {
        f.bus_stop_code
        for f in db.query(UserFavourite).filter_by(user_id=user.id).all()
    }
    for fav in body.favourites:
        code = str(fav.get("code", "")).strip()
        if not code or code in existing_codes or len(existing_codes) >= MAX_FAVOURITES:
            continue
        db.add(UserFavourite(
            user_id=user.id,
            bus_stop_code=code,
            description=fav.get("description"),
            road_name=fav.get("road_name"),
        ))
        _ensure_monitored(db, code)
        existing_codes.add(code)
    db.commit()
    favs = (
        db.query(UserFavourite)
        .filter_by(user_id=user.id)
        .order_by(UserFavourite.added_at.desc())
        .all()
    )
    return {"favourites": [_fav_out(f) for f in favs]}
