"""
MRT stations with *scheduled* train info, the way Apple / Google Maps show it.

GET /api/mrt/stations                 every station (interchanges merged)
GET /api/mrt/nearby?lat=&lng=&limit=  closest stations, with distance_m
GET /api/mrt/station/{name}           directions, typical frequency right now,
                                      first/last trains, live disruption alerts

There is no public live train-arrival feed in Singapore (LTA doesn't publish
one; SMRT's app feed needs a login), so nothing here is a live countdown:

- Frequency: typical headways per line, peak vs off-peak (HEADWAYS below).
- First/last trains: SMRT's public per-station timetable pages on its CDN
  (NSL, EWL, CCL, TEL). SBS Transit (NEL, DTL) doesn't publish an
  equivalent, so those show frequency and general operating hours only.
- Disruptions: LTA DataMall TrainServiceAlerts (live).
"""

import logging
import math
import re
import time
from datetime import datetime, timedelta, timezone
from html import unescape
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Path, Query

from config import LTA_API_KEY, LTA_BASE_URL
from mrt_data import LINE_DISPLAY, LINE_SEQUENCES, STATIONS

logger = logging.getLogger(__name__)
router = APIRouter()

_SGT = timezone(timedelta(hours=8))
_client = httpx.AsyncClient(timeout=10)

_PREFIX_LINE = {"EW": "EWL", "CG": "EWL", "NS": "NSL", "NE": "NEL", "CC": "CCL", "CE": "CCL", "DT": "DTL", "TE": "TEL"}
_OPERATOR = {"EWL": "SMRT", "NSL": "SMRT", "CCL": "SMRT", "TEL": "SMRT", "NEL": "SBS Transit", "DTL": "SBS Transit"}

# Typical minutes between trains: (peak, off-peak). Indicative — operators
# don't publish a machine-readable timetable, and real gaps vary by time.
HEADWAYS = {
    "EWL": ((2, 3), (4, 6)),
    "NSL": ((2, 3), (4, 6)),
    "NEL": ((2, 3), (4, 6)),
    "DTL": ((2, 3), (4, 6)),
    "CCL": ((3, 4), (5, 7)),
    "TEL": ((3, 4), (5, 6)),
}
GENERAL_HOURS = "about 5:30am to midnight"


def _line_of(code: str) -> str | None:
    m = re.match(r"([A-Z]+)", code)
    return _PREFIX_LINE.get(m.group(1)) if m else None


def _build_stations() -> dict[str, dict]:
    by_name: dict[str, dict] = {}
    for code, info in STATIONS.items():
        line = _line_of(code)
        st = by_name.setdefault(info["name"], {"name": info["name"], "lat": info["lat"], "lng": info["lng"], "lines": []})
        if line and all(l["code"] != code for l in st["lines"]):
            st["lines"].append({"line": line, "code": code, **LINE_DISPLAY.get(line, {"name": line, "color": "#666"})})
    order = list(LINE_SEQUENCES)
    for st in by_name.values():
        st["lines"].sort(key=lambda l: order.index(l["line"]) if l["line"] in order else 99)
    return by_name


_STATIONS_BY_NAME = _build_stations()


def _dist_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6_371_000 * 2 * math.asin(min(1.0, math.sqrt(a)))


# ── SMRT first/last train timetable (public CDN page per station) ─────────────

_TT_URL = "https://connect-cdn.smrt.wwprojects.com/autoupdate/mrt-timing/{}.html"
_TT_TTL = 12 * 3600
_tt_cache: dict[str, tuple[float, list[dict]]] = {}
_TIME = r"(\d{2}:\d{2}|--:--)"


def _t(v: str) -> str | None:
    return None if v == "--:--" else v


def parse_timetable(html: str) -> list[dict]:
    """SMRT's page: a heading ("First/Last train service terminating at EW33
    Tuas Link", "CLOCKWISE towards Caldecott - Ends at Marina Bay", ...) then a
    First/Last table for Mon–Fri, Saturday, Sunday/PH and eve-of-PH."""
    html = re.sub(r"<!--.*?-->", " ", html, flags=re.S)
    text = re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", html))).strip()
    parts = text.split("First Train Last Train")
    blocks, heading = [], parts[0]
    for seg in parts[1:]:
        rows = {
            "weekday":  re.search(r"Monday - Friday " + _TIME + " " + _TIME, seg),
            "saturday": re.search(r"Saturday " + _TIME + " " + _TIME, seg),
            "sunday":   re.search(r"Sunday/Public Holidays " + _TIME + " " + _TIME, seg),
            "eve":      re.search(r"Eve of Public Holidays Last Train " + _TIME + " " + _TIME, seg),
        }
        found = [m for m in rows.values() if m]
        has_any_time = any(m.group(1) != "--:--" or m.group(2) != "--:--" for m in found)
        if found and not has_any_time:  # e.g. a direction listed with every cell "--:--"
            heading = seg[max(m.end() for m in found):]
            continue
        if found:
            head = re.split(_TIME, heading)[-1].strip(" -")
            block = {k: ({"first": _t(m.group(1)), "last": _t(m.group(2))} if m else None) for k, m in rows.items()}
            block["heading"] = head
            blocks.append(block)
            heading = seg[max(m.end() for m in found):]
        else:
            heading = seg
    return blocks


def _describe(block: dict, station_lines: set[str]) -> dict:
    """Turn a raw block into {line, to, kind, note}."""
    h = block["heading"]
    line, to, note = None, h, ""
    # Interchanges list every code: "terminating at NS1 EW24 Jurong East".
    m = re.search(r"(?:terminating at|[Tt]owards)\s+((?:[A-Z]{2}\d+\s+)+)(.+)$", h)
    if m:
        line = _PREFIX_LINE.get(m.group(1)[:2])
        to = m.group(2).strip()
    else:
        m = re.match(r"(ANTI-?CLOCKWISE|CLOCKWISE)\s+towards\s+(.+?)(?:\s*-\s*(.+))?$", h, re.I)
        if m:
            line = "CCL"
            to = m.group(2).strip()
            note = (m.group(3) or "").strip()
            note = "" if note.lower() == "full loop" else note
            if note.lower().startswith("ends at"):
                note = "Ends at " + note[7:].strip()
    if line is None and len(station_lines) == 1:
        line = next(iter(station_lines))
    has_first = any((block.get(k) or {}).get("first") for k in ("weekday", "saturday", "sunday"))
    first_only = h.lower().startswith("first train service")
    if first_only:
        note = "Early trains only"
    elif not has_first and not note:
        note = "Last trains only"
    return {"line": line, "to": to, "note": note, "kind": "main" if has_first and not first_only else "short"}


async def _timetable(name: str, station_lines: set[str]) -> list[dict] | None:
    if not station_lines & {"EWL", "NSL", "CCL", "TEL"}:
        return None
    hit = _tt_cache.get(name)
    if hit and time.monotonic() - hit[0] < _TT_TTL:
        return hit[1]
    try:
        r = await _client.get(_TT_URL.format(quote(name.lower())))
        r.raise_for_status()
        blocks = [{**b, **_describe(b, station_lines)} for b in parse_timetable(r.text)]
    except Exception as exc:  # noqa: BLE001
        logger.warning("SMRT timetable fetch failed for %s: %s", name, exc)
        return hit[1] if hit else None
    _tt_cache[name] = (time.monotonic(), blocks)
    return blocks


# ── Live disruption alerts (LTA) ──────────────────────────────────────────────

_alerts: dict = {"ts": 0.0, "data": None}


async def _train_alerts() -> dict | None:
    if time.monotonic() - _alerts["ts"] < 60:
        return _alerts["data"]
    try:
        r = await _client.get(f"{LTA_BASE_URL}/TrainServiceAlerts", headers={"AccountKey": LTA_API_KEY})
        r.raise_for_status()
        v = r.json().get("value", {}) or {}
        _alerts.update(ts=time.monotonic(), data={
            "status": v.get("Status"),
            "segments": v.get("AffectedSegments") or [],
            "messages": [m.get("Content") for m in (v.get("Message") or []) if m.get("Content")],
        })
    except Exception as exc:  # noqa: BLE001
        logger.warning("TrainServiceAlerts fetch failed: %s", exc)
        _alerts["ts"] = time.monotonic() - 45  # retry in ~15 s
    return _alerts["data"]


# ── Endpoints ─────────────────────────────────────────────────────────────────

def _period(now: datetime) -> str:
    if now.weekday() < 5 and ((7 <= now.hour < 9) or (now.hour == 9 and now.minute < 30) or (17 <= now.hour < 20)):
        return "peak"
    return "off-peak"


def _day_type(now: datetime) -> str:
    # Service day starts ~04:30; a 00:30 last train still belongs to "yesterday".
    d = now - timedelta(hours=4, minutes=30)
    return "weekday" if d.weekday() < 5 else "saturday" if d.weekday() == 5 else "sunday"


@router.get("/mrt/stations")
def mrt_stations() -> dict:
    return {"results": list(_STATIONS_BY_NAME.values())}


@router.get("/mrt/nearby")
def mrt_nearby(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    limit: int = Query(8, ge=1, le=30),
) -> dict:
    ranked = sorted(
        ({**s, "distance_m": round(_dist_m(lat, lng, s["lat"], s["lng"]))} for s in _STATIONS_BY_NAME.values()),
        key=lambda s: s["distance_m"],
    )
    return {"results": ranked[:limit]}


@router.get("/mrt/station/{name}")
async def mrt_station(name: str = Path(..., max_length=60)) -> dict:
    st = next((s for n, s in _STATIONS_BY_NAME.items() if n.lower() == name.lower()), None)
    if st is None:
        raise HTTPException(status_code=404, detail="Station not found")
    now = datetime.now(_SGT)
    period, day_type = _period(now), _day_type(now)
    line_ids = {l["line"] for l in st["lines"]}
    blocks = await _timetable(st["name"], line_ids)
    alerts = await _train_alerts()

    lines = []
    for l in st["lines"]:
        lid = l["line"]
        peak, off = HEADWAYS.get(lid, ((3, 5), (5, 8)))
        lo, hi = peak if period == "peak" else off
        # (skip "last train terminating at <this station>" — nothing to board)
        dirs = [b for b in (blocks or []) if b["line"] == lid and b["to"].lower() != st["name"].lower()]
        if dirs:
            dirs.sort(key=lambda b: (b["kind"] != "main",))
            directions = [{
                "to": b["to"], "note": b["note"], "kind": b["kind"],
                "today": b.get(day_type), "eve_last": (b.get("eve") or {}).get("last"),
                "weekday": b.get("weekday"), "saturday": b.get("saturday"), "sunday": b.get("sunday"),
            } for b in dirs]
        else:
            seq = LINE_SEQUENCES.get(lid, [])
            ends = [STATIONS[c]["name"] for c in (seq[:1] + seq[-1:]) if c in STATIONS and STATIONS[c]["name"] != st["name"]]
            directions = [{"to": e, "note": "", "kind": "main", "today": None, "eve_last": None} for e in ends]
        segs = [s for s in ((alerts or {}).get("segments") or []) if s.get("Line") == lid]
        lines.append({
            **l,
            "operator": _OPERATOR.get(lid, ""),
            "frequency": {"min": lo, "max": hi, "period": period},
            "timetable": bool(dirs),
            "general_hours": None if dirs else GENERAL_HOURS,
            "directions": directions,
            "disruption": [{"direction": s.get("Direction"), "stations": s.get("Stations"),
                            "shuttle": s.get("FreePublicBus") or s.get("FreeMRTShuttle")} for s in segs],
        })
    disrupted = any(l["disruption"] for l in lines)
    return {
        "name": st["name"], "lat": st["lat"], "lng": st["lng"],
        "now": {"time": now.strftime("%H:%M"), "day_type": day_type, "period": period},
        "lines": lines,
        "alert_messages": (alerts or {}).get("messages", []) if disrupted else [],
    }
