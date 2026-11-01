"""
Carpark availability — HDB, URA and LTA (malls / major developments) carparks.

GET /api/carparks/nearby?lat=&lng=&limit=   closest carparks with live lots
GET /api/carparks/search?q=&limit=          by development / area name
GET /api/carparks/{carpark_id}              one carpark
GET    /api/saved-carparks                   the user's saved carparks + live lots
POST   /api/saved-carparks/{carpark_id}      save   (body: {"name": ...}, optional)
DELETE /api/saved-carparks/{carpark_id}      unsave

Source: LTA DataMall CarParkAvailabilityv2 (same AccountKey as the bus
endpoints). LTA refreshes it every minute and returns one row per carpark per
lot type (C = car, Y = motorcycle, H = heavy vehicle), 500 rows per page via
$skip. The whole set (~2,000 carparks) is pulled at most once a minute into
memory and grouped per carpark; every request is served from that snapshot. If
a refresh fails, the last good snapshot keeps being served (marked stale).
"""

import asyncio
import logging
import math
import re
import time
from datetime import datetime, timezone

import httpx
import pydantic
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from auth_routes import get_current_user
from config import LTA_API_KEY, LTA_BASE_URL
from database import SavedCarpark, User, get_db

logger = logging.getLogger(__name__)
router = APIRouter()

_CP_URL = f"{LTA_BASE_URL}/CarParkAvailabilityv2"
_CP_TTL = 60.0
_LOT_KEYS = {"C": "car", "Y": "motorcycle", "H": "heavy"}

_client = httpx.AsyncClient(timeout=15)
_lock = asyncio.Lock()
_snapshot: dict = {"ts": 0.0, "fetched_at": None, "carparks": {}}


def _parse(rows: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for r in rows:
        cid = str(r.get("CarParkID") or "").strip()
        if not cid:
            continue
        cp = out.get(cid)
        if cp is None:
            lat = lng = None
            parts = str(r.get("Location") or "").split()
            if len(parts) == 2:
                try:
                    lat, lng = float(parts[0]), float(parts[1])
                except ValueError:
                    lat = lng = None
            cp = out[cid] = {
                "id": cid,
                "name": (r.get("Development") or "").strip() or cid,
                "area": (r.get("Area") or "").strip(),
                "agency": (r.get("Agency") or "").strip(),
                "lat": lat,
                "lng": lng,
                "lots": {},
            }
        key = _LOT_KEYS.get(str(r.get("LotType") or "").strip().upper())
        if key:
            try:
                cp["lots"][key] = int(r.get("AvailableLots") or 0)
            except (TypeError, ValueError):
                pass
    return out


async def _fetch_all() -> dict[str, dict]:
    rows: list[dict] = []
    skip = 0
    while True:
        resp = await _client.get(_CP_URL, headers={"AccountKey": LTA_API_KEY}, params={"$skip": skip})
        resp.raise_for_status()
        page = resp.json().get("value", [])
        rows.extend(page)
        if len(page) < 500:
            break
        skip += 500
        if skip > 20_000:  # safety stop; the full set is a few thousand rows
            break
    return _parse(rows)


async def _carparks() -> tuple[dict[str, dict], str | None, bool]:
    """(carparks by id, ISO time of the snapshot, is_stale)."""
    if time.monotonic() - _snapshot["ts"] < _CP_TTL:
        return _snapshot["carparks"], _snapshot["fetched_at"], False
    async with _lock:
        if time.monotonic() - _snapshot["ts"] < _CP_TTL:  # refreshed while we waited
            return _snapshot["carparks"], _snapshot["fetched_at"], False
        try:
            data = await _fetch_all()
            if not data:
                raise ValueError("empty carpark feed")
            _snapshot.update(
                ts=time.monotonic(),
                fetched_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                carparks=data,
            )
            return data, _snapshot["fetched_at"], False
        except Exception as exc:  # noqa: BLE001
            logger.warning("Carpark availability refresh failed: %s: %s", type(exc).__name__, exc)
            if _snapshot["carparks"]:
                # Retry in ~15 s rather than hammering LTA on every request.
                _snapshot["ts"] = time.monotonic() - _CP_TTL + 15
                return _snapshot["carparks"], _snapshot["fetched_at"], True
            raise HTTPException(status_code=502, detail="Carpark availability is temporarily unavailable.")


def _dist_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6_371_000 * 2 * math.asin(min(1.0, math.sqrt(a)))


@router.get("/carparks/nearby")
async def carparks_nearby(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    limit: int = Query(20, ge=1, le=60),
) -> dict:
    cps, fetched_at, stale = await _carparks()
    located = [c for c in cps.values() if c["lat"] is not None]
    ranked = sorted(
        ({**c, "distance_m": round(_dist_m(lat, lng, c["lat"], c["lng"]))} for c in located),
        key=lambda c: c["distance_m"],
    )
    return {"updated_at": fetched_at, "stale": stale, "results": ranked[:limit]}


@router.get("/carparks/search")
async def carparks_search(
    q: str = Query(..., min_length=1, max_length=60),
    limit: int = Query(10, ge=1, le=30),
) -> dict:
    cps, fetched_at, stale = await _carparks()
    terms = q.lower().split()
    scored = []
    for c in cps.values():
        hay = f"{c['name']} {c['area']} {c['id']}".lower()
        if all(t in hay for t in terms):
            name = c["name"].lower()
            # Name starts with the query > a word in the name starts with it > anywhere.
            rank = 0 if name.startswith(q.lower()) else 1 if any(w.startswith(terms[0]) for w in name.split()) else 2
            scored.append((rank, c["name"], c))
    scored.sort(key=lambda x: (x[0], x[1]))
    return {"updated_at": fetched_at, "stale": stale, "results": [c for _, _, c in scored[:limit]]}


@router.get("/carparks/{carpark_id}")
async def carpark_one(carpark_id: str = Path(..., max_length=20)) -> dict:
    cps, fetched_at, stale = await _carparks()
    cp = cps.get(carpark_id)
    if cp is None:
        raise HTTPException(status_code=404, detail="Carpark not found")
    return {"updated_at": fetched_at, "stale": stale, "carpark": cp}


# ── Saved carparks (per account) ─────────────────────────────────────────────

MAX_SAVED_CARPARKS = 30
_CP_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,20}$")


class SavedCarparkIn(pydantic.BaseModel):
    name: str | None = pydantic.Field(None, max_length=200)


def _valid_cp_id(cid: str) -> str:
    if not _CP_ID_RE.match(cid):
        raise HTTPException(status_code=400, detail="Invalid carpark id.")
    return cid


@router.get("/saved-carparks")
async def saved_carparks(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    rows = db.query(SavedCarpark).filter_by(user_id=user.id).order_by(SavedCarpark.added_at.desc()).all()
    try:
        cps, fetched_at, stale = await _carparks()
    except HTTPException:  # LTA unreachable and nothing cached: still list them
        cps, fetched_at, stale = {}, None, True
    out = []
    for r in rows:
        live = cps.get(r.carpark_id)
        out.append({**(live or {"id": r.carpark_id, "name": r.name or r.carpark_id,
                                 "area": "", "agency": "", "lat": None, "lng": None, "lots": {}}),
                    "saved_name": r.name, "live": live is not None})
    return {"updated_at": fetched_at, "stale": stale, "results": out}


@router.post("/saved-carparks/{carpark_id}")
def save_carpark(
    carpark_id: str = Path(..., max_length=20),
    body: SavedCarparkIn | None = Body(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    cid = _valid_cp_id(carpark_id)
    row = db.query(SavedCarpark).filter_by(user_id=user.id, carpark_id=cid).first()
    if row is None:
        if db.query(SavedCarpark).filter_by(user_id=user.id).count() >= MAX_SAVED_CARPARKS:
            raise HTTPException(status_code=400, detail=f"Limit of {MAX_SAVED_CARPARKS} saved carparks reached.")
        db.add(SavedCarpark(user_id=user.id, carpark_id=cid, name=body.name if body else None))
    elif body and body.name:
        row.name = body.name
    db.commit()
    return {"status": "saved", "id": cid}


@router.delete("/saved-carparks/{carpark_id}")
def unsave_carpark(
    carpark_id: str = Path(..., max_length=20),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    cid = _valid_cp_id(carpark_id)
    db.query(SavedCarpark).filter_by(user_id=user.id, carpark_id=cid).delete()
    db.commit()
    return {"status": "removed", "id": cid}
