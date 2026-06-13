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
import logging
import re
import secrets
import time
from collections import defaultdict
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from config import GOOGLE_CLIENT_ID
from database import User, UserFavourite, UserSession, MonitoredStop, SavedJourney, get_db

router = APIRouter()
logger = logging.getLogger(__name__)

PBKDF2_ITERATIONS = 200_000
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")
MAX_FAVOURITES = 30
MAX_SAVED_JOURNEYS = 30

# Naive in-memory throttle: 20 auth attempts per (IP, username) per 15 minutes.
# Keyed per-username too because behind a reverse proxy / Tailscale Funnel all
# visitors can share one client IP — a pure per-IP bucket would let one person
# lock out logins for everyone.
_attempts: dict[str, list[float]] = defaultdict(list)
_ATTEMPT_WINDOW_SEC = 15 * 60
_ATTEMPT_LIMIT = 20

# Sessions idle longer than this are rejected and deleted.
SESSION_TTL_DAYS = 30


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


def unusable_password_hash() -> str:
    """A valid-looking hash of an unknowable secret — for OAuth-only accounts.

    Stored so the NOT NULL ``password_hash`` column is satisfied; password login
    against it can never succeed because nobody knows the underlying password.
    """
    return hash_password(secrets.token_hex(32))


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _throttle(request: Request, username: str = "") -> None:
    key = f"{_client_ip(request)}|{username.strip().lower()}"
    now = time.monotonic()
    _attempts[key] = [t for t in _attempts[key] if now - t < _ATTEMPT_WINDOW_SEC]
    if len(_attempts[key]) >= _ATTEMPT_LIMIT:
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")
    _attempts[key].append(now)
    # Keep the table from growing forever
    if len(_attempts) > 2000:
        for stale in [k for k, v in _attempts.items()
                      if not v or now - v[-1] > _ATTEMPT_WINDOW_SEC]:
            del _attempts[stale]


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
    if session.last_used < datetime.utcnow() - timedelta(days=SESSION_TTL_DAYS):
        db.delete(session)
        db.commit()
        raise HTTPException(status_code=401, detail="Session expired. Log in again.")
    user = db.query(User).filter_by(id=session.user_id).first()
    if user is None:
        raise HTTPException(status_code=401, detail="Account no longer exists")
    session.last_used = datetime.utcnow()
    db.commit()
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.username.lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
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
    _throttle(request, creds.username)
    username = creds.username.strip()
    if not USERNAME_RE.match(username):
        raise HTTPException(
            status_code=400,
            detail="Username must be 3-20 characters: letters, numbers, underscores.",
        )
    if username.lower() == "admin":
        raise HTTPException(status_code=409, detail="That username is taken.")
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
    _throttle(request, creds.username)
    username = creds.username.strip()
    user = db.query(User).filter(func.lower(User.username) == username.lower()).first()
    if user is None or not verify_password(creds.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Wrong username or password.")
    return {"token": _issue_token(db, user.id), "username": user.username}


# ── Google OAuth ──────────────────────────────────────────────────────────────

class GoogleAuthIn(BaseModel):
    credential: str   # the ID token (JWT) returned by Google Identity Services


def _unique_username(db: Session, base: str) -> str:
    """Derive a valid, unused username from a Google display name / email."""
    cleaned = re.sub(r"[^A-Za-z0-9_]", "", base or "")
    if len(cleaned) < 3:
        cleaned = (cleaned + "user")
    cleaned = cleaned[:20]
    candidate = cleaned
    n = 0
    while (
        candidate.lower() == "admin"
        or db.query(User).filter(func.lower(User.username) == candidate.lower()).first()
    ):
        n += 1
        suffix = str(n)
        candidate = cleaned[: 20 - len(suffix)] + suffix
    return candidate


@router.post("/auth/google")
def google_auth(body: GoogleAuthIn, request: Request, db: Session = Depends(get_db)) -> dict:
    _throttle(request, "google")
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured.")

    # Verify the ID token: checks signature against Google's keys, audience
    # (our client id), issuer and expiry. Raises on any failure.
    # clock_skew_in_seconds gives a little tolerance for small clock drift.
    try:
        from google.auth.transport import requests as google_requests
        from google.oauth2 import id_token as google_id_token
        info = google_id_token.verify_oauth2_token(
            body.credential, google_requests.Request(), GOOGLE_CLIENT_ID,
            clock_skew_in_seconds=10,
        )
    except Exception as e:
        # Surface the underlying reason so misconfiguration (e.g. an audience
        # mismatch between the frontend and backend client IDs) is diagnosable
        # instead of hidden behind a generic message.
        logger.warning("Google ID token verification failed: %s: %s", type(e).__name__, e)
        raise HTTPException(status_code=401, detail=f"Google sign-in failed: {e}")

    if info.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise HTTPException(status_code=401, detail="Invalid Google token issuer.")

    sub = info.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="Google token missing subject.")
    email = (info.get("email") or "").strip().lower()
    email_verified = bool(info.get("email_verified"))
    display = info.get("name") or (email.split("@")[0] if email else "user")

    # 1) Returning Google user
    user = db.query(User).filter_by(google_sub=sub).first()

    # 2) Link to an existing account that shares this verified email
    if user is None and email and email_verified:
        user = db.query(User).filter(func.lower(User.email) == email).first()
        if user is not None:
            user.google_sub = sub

    # 3) Brand-new account
    if user is None:
        user = User(
            username=_unique_username(db, display),
            password_hash=unusable_password_hash(),
            email=email or None,
            google_sub=sub,
            auth_provider="google",
        )
        db.add(user)
    else:
        if email and not user.email:
            user.email = email

    db.commit()
    db.refresh(user)
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


class ChangePassword(BaseModel):
    current_password: str
    new_password: str


@router.post("/auth/change-password")
def change_password(
    body: ChangePassword,
    request: Request,
    authorization: str | None = Header(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _throttle(request, user.username)
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="Current password is wrong.")
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    user.password_hash = hash_password(body.new_password)
    # Revoke every other session so a stolen token dies with the old password
    current_token = (authorization or "").removeprefix("Bearer ").strip()
    db.query(UserSession).filter(
        UserSession.user_id == user.id, UserSession.token != current_token
    ).delete()
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
        "is_admin": user.username.lower() == "admin",
        "email": user.email,
        "auth_provider": user.auth_provider or "password",
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
