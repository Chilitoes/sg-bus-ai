-- ═══════════════════════════════════════════════════════════════════
-- SG Bus AI — Database Schema
--
-- SQLAlchemy creates these tables automatically on startup.
-- This file is documentation / for manual inspection or migration.
-- ═══════════════════════════════════════════════════════════════════

-- ── Bus arrival records ────────────────────────────────────────────
-- One row per (collection cycle × bus stop × service × slot).
-- delay_seconds is NULL until the bus's BusTracking row is closed.
CREATE TABLE IF NOT EXISTS bus_arrival_records (
    id                INTEGER     PRIMARY KEY AUTOINCREMENT,
    bus_stop_code     TEXT        NOT NULL,
    bus_service       TEXT        NOT NULL,
    collection_time   DATETIME    NOT NULL,
    estimated_arrival DATETIME    NOT NULL,
    wait_seconds      REAL        NOT NULL,     -- (estimated_arrival - collection_time) in seconds
    delay_seconds     REAL,                     -- ground truth; filled once bus arrives
    hour_of_day       INTEGER     NOT NULL,     -- 0–23
    day_of_week       INTEGER     NOT NULL,     -- 0=Mon … 6=Sun
    is_peak           BOOLEAN     NOT NULL DEFAULT 0,
    is_weekend        BOOLEAN     NOT NULL DEFAULT 0,
    bus_load          TEXT,                     -- SEA | SDA | LSD
    bus_type          TEXT,                     -- SD | DD | BD
    slot              INTEGER                   -- 1 | 2 | 3
);

CREATE INDEX IF NOT EXISTS idx_bar_stop    ON bus_arrival_records (bus_stop_code);
CREATE INDEX IF NOT EXISTS idx_bar_service ON bus_arrival_records (bus_service);
CREATE INDEX IF NOT EXISTS idx_bar_time    ON bus_arrival_records (collection_time);

-- ── Bus tracking ───────────────────────────────────────────────────
-- Links consecutive API snapshots of the same bus so we can derive
-- ground-truth delay once the bus disappears from the API.
--
-- A bus is identified by (stop, service, arrival_key).
-- arrival_key = estimated_arrival rounded to the nearest minute.
CREATE TABLE IF NOT EXISTS bus_tracking (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bus_stop_code   TEXT    NOT NULL,
    bus_service     TEXT    NOT NULL,
    arrival_key     DATETIME NOT NULL,          -- rounded estimated arrival (stable key)
    first_seen      DATETIME NOT NULL,
    first_estimate  DATETIME NOT NULL,
    last_seen       DATETIME,
    last_estimate   DATETIME,
    is_closed       BOOLEAN NOT NULL DEFAULT 0,
    delay_seconds   REAL,                       -- last_estimate - first_estimate (seconds)

    UNIQUE (bus_stop_code, bus_service, arrival_key)
);

-- ── Monitored stops ────────────────────────────────────────────────
-- Bus stop codes the background collector polls every N minutes.
CREATE TABLE IF NOT EXISTS monitored_stops (
    bus_stop_code   TEXT        PRIMARY KEY,
    added_at        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_active       BOOLEAN     NOT NULL DEFAULT 1
);
