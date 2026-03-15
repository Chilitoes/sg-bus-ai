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

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from api_routes import router
from config import DEFAULT_MONITORED_STOPS
from data_collector import start_data_collection
from database import init_db
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

    logger.info("Loading / training ML model …")
    model.load_or_train()

    logger.info("Syncing bus stop directory from LTA …")
    try:
        from api_routes import sync_stops
        await sync_stops()
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

app = FastAPI(
    title="Singapore AI Bus Predictor",
    description="Real-time bus arrivals with ML-adjusted predictions.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten in production
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")

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
