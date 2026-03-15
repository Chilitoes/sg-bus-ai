"""
SQLAlchemy database models and session management.

Tables
------
bus_arrival_records  – raw API snapshots used to train the ML model
bus_tracking         – links consecutive snapshots of the same bus to derive
                       a ground-truth delay once the bus "disappears" from
                       the API (i.e. it has arrived)
monitored_stops      – bus stop codes the background collector polls
bus_stops            – full Singapore bus stop directory (synced from LTA)
"""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    Integer,
    String,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from config import DATABASE_URL

# ── Engine & session ──────────────────────────────────────────────────────────
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


# ── Models ────────────────────────────────────────────────────────────────────

class BusArrivalRecord(Base):
    """
    One row per (collection_time, stop, service, bus slot).

    The 'delay_seconds' column is populated retroactively by the tracker once
    we know the bus arrived (i.e. the tracking row is closed).
    Positive delay  → bus ran late vs its first reported estimate.
    Negative delay  → bus ran early.
    """
    __tablename__ = "bus_arrival_records"

    id = Column(Integer, primary_key=True, index=True)
    bus_stop_code    = Column(String(10), index=True, nullable=False)
    bus_service      = Column(String(10), index=True, nullable=False)
    # ISO-8601 timestamp when we queried the API
    collection_time  = Column(DateTime, nullable=False, default=datetime.utcnow)
    # Estimated arrival reported by the LTA API at collection_time
    estimated_arrival = Column(DateTime, nullable=False)
    # Seconds until arrival at collection_time  (estimated_arrival − collection_time)
    wait_seconds     = Column(Float, nullable=False)
    # Populated once we have ground truth
    delay_seconds    = Column(Float, nullable=True)

    # Derived convenience columns (denormalised for fast ML queries)
    hour_of_day  = Column(Integer, nullable=False)   # 0–23
    day_of_week  = Column(Integer, nullable=False)   # 0=Mon … 6=Sun
    is_peak      = Column(Boolean, nullable=False, default=False)
    is_weekend   = Column(Boolean, nullable=False, default=False)

    bus_load  = Column(String(5), nullable=True)   # SEA | SDA | LSD
    bus_type  = Column(String(5), nullable=True)   # SD | DD | BD
    # Which slot this came from (1/2/3)
    slot = Column(Integer, nullable=True)


class BusTracking(Base):
    """
    Tracks a specific bus journey across consecutive API polls so we can
    compute a ground-truth delay when the bus disappears from the API.

    A bus is identified by (stop, service, rounded estimated_arrival).
    We round to the nearest minute to tolerate small API fluctuations.
    """
    __tablename__ = "bus_tracking"
    __table_args__ = (
        UniqueConstraint("bus_stop_code", "bus_service", "arrival_key",
                         name="uq_tracking"),
    )

    id = Column(Integer, primary_key=True, index=True)
    bus_stop_code = Column(String(10), index=True, nullable=False)
    bus_service   = Column(String(10), nullable=False)
    # Rounded estimated arrival used as a stable key across polls
    arrival_key   = Column(DateTime, nullable=False)

    first_seen        = Column(DateTime, nullable=False)
    first_estimate    = Column(DateTime, nullable=False)
    last_seen         = Column(DateTime, nullable=True)
    last_estimate     = Column(DateTime, nullable=True)

    # Filled in once the bus disappears (arrived)
    is_closed       = Column(Boolean, default=False, nullable=False)
    delay_seconds   = Column(Float, nullable=True)  # last_estimate − first_estimate


class BusStop(Base):
    """Full Singapore bus stop directory, synced from LTA on startup."""
    __tablename__ = "bus_stops"

    bus_stop_code = Column(String(10), primary_key=True)
    road_name     = Column(String(100), nullable=True)
    description   = Column(String(200), nullable=True)
    latitude      = Column(Float, nullable=True)
    longitude     = Column(Float, nullable=True)
    synced_at     = Column(DateTime, default=datetime.utcnow, nullable=False)


class MonitoredStop(Base):
    """Bus stop codes the background data collector actively polls."""
    __tablename__ = "monitored_stops"

    bus_stop_code = Column(String(10), primary_key=True)
    added_at      = Column(DateTime, default=datetime.utcnow, nullable=False)
    is_active     = Column(Boolean, default=True, nullable=False)


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_db():
    """FastAPI dependency that yields a DB session and closes it afterwards."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db(seed_stops: list[str] | None = None) -> None:
    """Create all tables and optionally seed the monitored-stops list."""
    Base.metadata.create_all(bind=engine)
    if seed_stops:
        db = SessionLocal()
        try:
            for code in seed_stops:
                exists = db.query(MonitoredStop).filter_by(bus_stop_code=code).first()
                if not exists:
                    db.add(MonitoredStop(bus_stop_code=code))
            db.commit()
        finally:
            db.close()
