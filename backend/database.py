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
    inspect,
    text,
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


class BusRoute(Base):
    """LTA bus route data: which stops each service visits, in sequence order."""
    __tablename__ = "bus_routes"
    __table_args__ = (
        UniqueConstraint("service_no", "direction", "stop_sequence", name="uq_route_seq"),
    )

    id            = Column(Integer, primary_key=True)
    service_no    = Column(String(10), nullable=False, index=True)
    direction     = Column(Integer, nullable=False)
    stop_sequence = Column(Integer, nullable=False)
    bus_stop_code = Column(String(10), nullable=False, index=True)
    distance_km   = Column(Float, nullable=True)
    synced_at     = Column(DateTime, default=datetime.utcnow, nullable=False)


class User(Base):
    """Registered account.

    Two ways to sign in:
    - Password accounts: ``password_hash`` is a salted PBKDF2 hash.
    - Google accounts: ``google_sub`` is the Google subject id; ``password_hash``
      holds an unusable random hash so password login can never succeed.
    """
    __tablename__ = "users"

    id            = Column(Integer, primary_key=True)
    username      = Column(String(30), unique=True, index=True, nullable=False)
    password_hash = Column(String(200), nullable=False)
    created_at    = Column(DateTime, default=datetime.utcnow, nullable=False)

    # OAuth / profile (nullable: password-only accounts leave these empty)
    email         = Column(String(255), index=True, nullable=True)
    google_sub    = Column(String(64), unique=True, index=True, nullable=True)
    auth_provider = Column(String(20), default="password", nullable=True)

    # Notifications: all system notifications created after this timestamp are
    # "unread" for this user. NULL means never checked → all are unread.
    notifications_seen_at = Column(DateTime, nullable=True)


class UserSession(Base):
    """Opaque bearer tokens. One row per logged-in device; revocable."""
    __tablename__ = "user_sessions"

    token      = Column(String(64), primary_key=True)
    user_id    = Column(Integer, index=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_used  = Column(DateTime, default=datetime.utcnow, nullable=False)


class UserFavourite(Base):
    """Server-side favourite stops, so they follow the account across devices."""
    __tablename__ = "user_favourites"
    __table_args__ = (
        UniqueConstraint("user_id", "bus_stop_code", name="uq_user_fav"),
    )

    id            = Column(Integer, primary_key=True)
    user_id       = Column(Integer, index=True, nullable=False)
    bus_stop_code = Column(String(10), nullable=False)
    description   = Column(String(200), nullable=True)
    road_name     = Column(String(100), nullable=True)
    added_at      = Column(DateTime, default=datetime.utcnow, nullable=False)


class SavedJourney(Base):
    """Saved origin→destination pairs stored per user account."""
    __tablename__ = "saved_journeys"
    __table_args__ = (
        UniqueConstraint("user_id", "from_lat", "from_lng", "to_lat", "to_lng",
                         name="uq_user_journey"),
    )

    id        = Column(Integer, primary_key=True)
    user_id   = Column(Integer, index=True, nullable=False)
    from_name = Column(String(200), nullable=False)
    from_lat  = Column(Float, nullable=False)
    from_lng  = Column(Float, nullable=False)
    to_name   = Column(String(200), nullable=False)
    to_lat    = Column(Float, nullable=False)
    to_lng    = Column(Float, nullable=False)
    saved_at  = Column(DateTime, default=datetime.utcnow, nullable=False)


class Feedback(Base):
    """User-submitted feedback (anonymous; no auth required)."""
    __tablename__ = "feedback"

    id           = Column(Integer, primary_key=True)
    rating       = Column(Integer, nullable=True)         # 1–5
    message      = Column(String(2000), nullable=True)
    context      = Column(String(50),   nullable=True)    # e.g. "arrivals", "plan"
    username     = Column(String(50),   nullable=True)    # logged-in user, if any
    ip_address   = Column(String(45),   nullable=True)    # IPv4 or IPv6
    user_agent   = Column(String(300),  nullable=True)
    submitted_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class SystemNotification(Base):
    """Admin-created system notifications visible to all logged-in users."""
    __tablename__ = "system_notifications"

    id         = Column(Integer, primary_key=True)
    title      = Column(String(120), nullable=False)
    body       = Column(String(2000), nullable=True)
    level      = Column(String(10), default="info", nullable=False)  # info | warning | update
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class DailyActivity(Base):
    """Daily request counters keyed by (date_sgt, metric, label).

    Metrics: "arrivals" (label=stop_code), "journey_plan", "multimodal_plan".
    Incremented as FastAPI background tasks so they never slow a response.
    """
    __tablename__ = "daily_activity"
    __table_args__ = (
        UniqueConstraint("date", "metric", "label", name="uq_daily_activity"),
    )

    id     = Column(Integer, primary_key=True)
    date   = Column(String(10), nullable=False, index=True)  # "YYYY-MM-DD" SGT
    metric = Column(String(30), nullable=False)
    label  = Column(String(30), nullable=False, default="")
    count  = Column(Integer,    default=0,      nullable=False)


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_db():
    """FastAPI dependency that yields a DB session and closes it afterwards."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _migrate_feedback_columns() -> None:
    """Add username/ip_address/user_agent to a pre-existing feedback table."""
    insp = inspect(engine)
    if "feedback" not in insp.get_table_names():
        return
    existing = {c["name"] for c in insp.get_columns("feedback")}
    additions = {
        "username":   "VARCHAR(50)",
        "ip_address": "VARCHAR(45)",
        "user_agent": "VARCHAR(300)",
    }
    with engine.begin() as conn:
        for name, ddl in additions.items():
            if name not in existing:
                conn.execute(text(f"ALTER TABLE feedback ADD COLUMN {name} {ddl}"))


def _migrate_user_columns() -> None:
    """Add the OAuth columns to a pre-existing ``users`` table.

    ``create_all`` only creates *missing tables*, never missing columns, so an
    older database that predates Google sign-in needs the new columns added by
    hand. Portable across SQLite and PostgreSQL.
    """
    insp = inspect(engine)
    if "users" not in insp.get_table_names():
        return
    existing = {c["name"] for c in insp.get_columns("users")}
    additions = {
        "email": "VARCHAR(255)",
        "google_sub": "VARCHAR(64)",
        "auth_provider": "VARCHAR(20) DEFAULT 'password'",
    }
    with engine.begin() as conn:
        for name, ddl in additions.items():
            if name not in existing:
                conn.execute(text(f"ALTER TABLE users ADD COLUMN {name} {ddl}"))
        # Unique index on google_sub (NULLs are allowed to repeat on both engines)
        conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_google_sub "
            "ON users (google_sub)"
        ))


def _migrate_notifications_column() -> None:
    """Add notifications_seen_at to a pre-existing users table."""
    insp = inspect(engine)
    if "users" not in insp.get_table_names():
        return
    existing = {c["name"] for c in insp.get_columns("users")}
    if "notifications_seen_at" not in existing:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE users ADD COLUMN notifications_seen_at DATETIME"))


def init_db(seed_stops: list[str] | None = None) -> None:
    """Create all tables and optionally seed the monitored-stops list."""
    Base.metadata.create_all(bind=engine)
    _migrate_user_columns()
    _migrate_feedback_columns()
    _migrate_notifications_column()
    # DailyActivity is new — create_all handles it; no column migration needed.
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
