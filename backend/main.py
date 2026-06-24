"""
FastAPI application entry point.

Startup sequence
----------------
1. Create all DB tables (idempotent).
2. Seed monitored stops from MONITORED_STOPS env var.
3. Load the ML model (or train from scratch if none saved yet).
4. Launch the background data-collection loop as an asyncio task.

The frontend (../frontend/) is served as static files at the root path ("/").
All API endpoints are available under "/api/".
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from api_routes import router
from auth_routes import router as auth_router, hash_password, verify_password
from config import DEFAULT_MONITORED_STOPS
from data_collector import start_data_collection
from database import init_db, SessionLocal, User
from ml_model import model

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ───────────────────────────────────────────────────────────────
    logger.info("Initialising database …")
    init_db(seed_stops=DEFAULT_MONITORED_STOPS)

    # Provision the admin account from the ADMIN_PASSWORD env var (.env on the
    # server). Never hardcoded — this repo is public.
    admin_pw = os.getenv("ADMIN_PASSWORD")
    if admin_pw:
        db = SessionLocal()
        try:
            admin = db.query(User).filter_by(username="admin").first()
            if admin is None:
                db.add(User(username="admin", password_hash=hash_password(admin_pw), is_admin=True))
                logger.info("Admin account created.")
            else:
                if not verify_password(admin_pw, admin.password_hash):
                    admin.password_hash = hash_password(admin_pw)
                    logger.info("Admin password rotated from ADMIN_PASSWORD.")
                # Idempotently ensure the flag is set (covers pre-is_admin accounts).
                admin.is_admin = True
            db.commit()
        finally:
            db.close()
    else:
        logger.warning("ADMIN_PASSWORD not set — admin account not provisioned.")

    logger.info("Loading / training ML model …")
    model.load_or_train()

    logger.info("Syncing bus stop directory from LTA …")
    try:
        from api_routes import _sync_stops_impl
        await _sync_stops_impl()
        logger.info("Bus stop directory synced.")
    except Exception as exc:
        logger.warning("Bus stop sync failed (non-fatal): %s", exc)

    logger.info("Starting background data collector …")
    collector_task = asyncio.create_task(start_data_collection())

    yield

    # ── Shutdown ──────────────────────────────────────────────────────────────
    logger.info("Shutting down …")
    collector_task.cancel()
    try:
        await collector_task
    except asyncio.CancelledError:
        pass


# ── App ───────────────────────────────────────────────────────────────────────

_PRODUCTION = not os.getenv("DEBUG")

app = FastAPI(
    title="Singapore AI Bus Predictor",
    description="Real-time bus arrivals with ML-adjusted predictions.",
    version="1.0.0",
    lifespan=lifespan,
    # Disable interactive docs in production — they expose the full API surface
    # and let anyone fire requests from a browser UI without credentials.
    docs_url=None if _PRODUCTION else "/docs",
    redoc_url=None if _PRODUCTION else "/redoc",
    openapi_url=None if _PRODUCTION else "/openapi.json",
)

_ALLOWED_ORIGINS = [
    "https://alstonshi.com",
    "https://www.alstonshi.com",
    "https://alston-b550mh.tail8c7cb3.ts.net",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


class _SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Inject defensive HTTP response headers on every reply."""
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "geolocation=(), camera=(), microphone=()"
        # The service is only ever reached over HTTPS (Tailscale Funnel terminates
        # TLS). Tell browsers to refuse plain-HTTP for a year so a downgrade /
        # SSL-strip attack can't trick a client into sending a Bearer token in the
        # clear. No `preload`/`includeSubDomains` — keep the policy scoped.
        response.headers["Strict-Transport-Security"] = "max-age=31536000"
        # Remove the server banner so version-fingerprinting is harder
        if "server" in response.headers:
            del response.headers["server"]
        return response


app.add_middleware(_SecurityHeadersMiddleware)
# Compress large JSON/text responses (e.g. /api/stops/all ~5000 rows, the admin
# dashboards). ~5–10× smaller over the wire for a few ms of CPU.
app.add_middleware(GZipMiddleware, minimum_size=1024)

app.include_router(router, prefix="/api")
app.include_router(auth_router, prefix="/api")

# Serve the React/HTML frontend.
# Must be mounted AFTER the API router so "/api/*" routes take priority.
_frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(_frontend_dir):
    app.mount("/", StaticFiles(directory=_frontend_dir, html=True), name="frontend")
    logger.info("Serving frontend from %s", os.path.abspath(_frontend_dir))
else:
    logger.warning("Frontend directory not found at %s", _frontend_dir)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
