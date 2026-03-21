"""
AI delay-prediction model.

Architecture
------------
Algorithm : GradientBoostingRegressor (scikit-learn)
Target    : delay_seconds — how many seconds the bus will arrive earlier (−)
            or later (+) than the LTA API's current estimate.
            e.g. +120 → API estimate is optimistic by 2 min; add 2 min.

Feature engineering
-------------------
  hour_sin / hour_cos   – cyclical encoding of hour (0-23) so midnight ≈ 1 am
  dow_sin  / dow_cos    – cyclical encoding of day-of-week
  is_peak               – morning peak 7-9 or evening peak 17-19, weekday
  is_weekend            – Saturday or Sunday
  load_code             – SEA=0, SDA=1, LSD=2  (seat/stand availability)
  type_code             – SD=0, DD=1, BD=2
  service_hash          – hash(service_no) % 1000  (stable numeric proxy)
  stop_hash             – hash(stop_code)   % 1000

Bootstrapping
-------------
On first run there is no historical data.  We generate ~5 000 synthetic rows
that encode realistic Singapore delay patterns:
  • weekday peaks  → mean +150 s, std 90 s
  • weekday off-peak → mean +40 s, std 60 s
  • weekends        → mean +20 s, std 50 s
  • late night 22-06 → mean +10 s, std 30 s

Once real data accumulates the model is retrained on the combined dataset,
gradually replacing the synthetic signal with ground-truth observations.
"""

import logging
import math
import os
from datetime import datetime
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

LOAD_MAP  = {"SEA": 0, "SDA": 1, "LSD": 2}
TYPE_MAP  = {"SD": 0, "DD": 1, "BD": 2}
FEATURES  = [
    "hour_sin", "hour_cos",
    "dow_sin",  "dow_cos",
    "is_peak", "is_weekend",
    "load_code", "type_code",
    "service_hash", "stop_hash",
]


# ── Feature helpers ───────────────────────────────────────────────────────────

def _cyclic(value: float, period: float) -> tuple[float, float]:
    """Return (sin, cos) cyclical encoding so the scale wraps around."""
    angle = 2 * math.pi * value / period
    return math.sin(angle), math.cos(angle)


def _is_peak(hour: int, is_weekend: bool) -> bool:
    if is_weekend:
        return False
    return (7 <= hour < 9) or (17 <= hour < 19)


def build_features(
    hour: int,
    day_of_week: int,
    bus_load: str = "SEA",
    bus_type: str = "SD",
    service_no: str = "0",
    stop_code: str = "0",
) -> dict[str, float]:
    """Return a feature dict ready for model inference."""
    is_wkend = day_of_week >= 5
    hs, hc = _cyclic(hour, 24)
    ds, dc = _cyclic(day_of_week, 7)
    return {
        "hour_sin":     hs,
        "hour_cos":     hc,
        "dow_sin":      ds,
        "dow_cos":      dc,
        "is_peak":      float(_is_peak(hour, is_wkend)),
        "is_weekend":   float(is_wkend),
        "load_code":    float(LOAD_MAP.get(bus_load, 0)),
        "type_code":    float(TYPE_MAP.get(bus_type, 0)),
        "service_hash": float(hash(service_no) % 1000),
        "stop_hash":    float(hash(stop_code)   % 1000),
    }


# ── Synthetic data ────────────────────────────────────────────────────────────

def _generate_synthetic_data(n: int = 5000, seed: int = 42) -> pd.DataFrame:
    """
    Generate synthetic training rows encoding realistic SG bus delay patterns.
    Used to bootstrap the model before real data is available.
    """
    rng = np.random.default_rng(seed)
    rows = []
    for _ in range(n):
        hour        = int(rng.integers(0, 24))
        dow         = int(rng.integers(0, 7))
        is_wkend    = dow >= 5
        is_pk       = _is_peak(hour, is_wkend)
        load        = rng.choice(["SEA", "SDA", "LSD"], p=[0.5, 0.35, 0.15])
        bus_type    = rng.choice(["SD", "DD", "BD"],    p=[0.5, 0.40, 0.10])
        service_no  = str(rng.integers(1, 400))
        stop_code   = str(rng.integers(10000, 99999))

        # Delay distribution by time context
        if is_pk:
            delay = rng.normal(150, 90)
        elif is_wkend:
            delay = rng.normal(20, 50)
        elif 22 <= hour or hour < 6:
            delay = rng.normal(10, 30)
        else:
            delay = rng.normal(40, 60)

        feats = build_features(hour, dow, load, bus_type, service_no, stop_code)
        feats["delay_seconds"] = float(delay)
        rows.append(feats)

    return pd.DataFrame(rows)


# ── Model class ───────────────────────────────────────────────────────────────

class BusDelayModel:
    """
    Wraps a scikit-learn GradientBoostingRegressor pipeline.

    Usage
    -----
    model = BusDelayModel()
    model.load_or_train()              # call once at startup

    adjustment = model.predict(        # call per bus arrival
        hour=8, day_of_week=1,
        bus_load="SDA", bus_type="DD",
        service_no="65", stop_code="83139"
    )
    # adjustment is seconds to add to the LTA API estimate
    """

    def __init__(self, model_path: str | None = None) -> None:
        from config import MODEL_PATH
        self.model_path = model_path or MODEL_PATH
        self._pipeline: Pipeline | None = None
        self.last_trained: datetime | None = None
        self.training_rows: int = 0
        self.mae: float | None = None          # mean-absolute-error on validation set

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
        joblib.dump(
            {
                "pipeline":      self._pipeline,
                "last_trained":  self.last_trained,
                "training_rows": self.training_rows,
                "mae":           self.mae,
            },
            self.model_path,
        )
        logger.info("Model saved → %s", self.model_path)

    def load(self) -> bool:
        if not os.path.exists(self.model_path):
            return False
        data = joblib.load(self.model_path)
        self._pipeline    = data["pipeline"]
        self.last_trained = data["last_trained"]
        self.training_rows = data.get("training_rows", 0)
        self.mae          = data.get("mae")
        logger.info("Model loaded  rows=%d  MAE=%.1fs", self.training_rows, self.mae or 0)
        return True

    # ── Training ──────────────────────────────────────────────────────────────

    def train(self, df: pd.DataFrame | None = None) -> None:
        """
        Train on *df* if provided (real DB data), otherwise use synthetic data.
        If both synthetic and real data exist, they are combined so the model
        benefits from real patterns as soon as they appear.
        """
        synthetic = _generate_synthetic_data()

        if df is not None and len(df) >= 50:
            # Combine: give real data 3× weight by repeating rows
            df_real = df[FEATURES + ["delay_seconds"]].dropna()
            combined = pd.concat([synthetic, df_real, df_real, df_real], ignore_index=True)
            logger.info("Training on %d synthetic + %d real rows", len(synthetic), len(df_real))
        else:
            combined = synthetic
            logger.info("Training on %d synthetic rows (no real data yet)", len(synthetic))

        X = combined[FEATURES].values
        y = combined["delay_seconds"].values

        X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.15, random_state=42)

        self._pipeline = Pipeline([
            ("scaler", StandardScaler()),
            ("gbr", GradientBoostingRegressor(
                n_estimators=200,
                max_depth=4,
                learning_rate=0.05,
                subsample=0.8,
                random_state=42,
            )),
        ])
        self._pipeline.fit(X_train, y_train)

        y_pred = self._pipeline.predict(X_val)
        self.mae = float(mean_absolute_error(y_val, y_pred))
        self.last_trained  = datetime.utcnow()
        self.training_rows = len(combined)

        logger.info("Training complete  rows=%d  MAE=%.1fs", self.training_rows, self.mae)
        self.save()

    def load_or_train(self, df: pd.DataFrame | None = None) -> None:
        """Load a saved model if available; otherwise train from scratch."""
        if not self.load():
            logger.info("No saved model found — training from scratch")
            self.train(df)

    def retrain_from_db(self) -> None:
        """Pull ground-truth rows from the DB and retrain."""
        from database import SessionLocal, BusArrivalRecord

        db = SessionLocal()
        try:
            rows = (
                db.query(BusArrivalRecord)
                .filter(BusArrivalRecord.delay_seconds.isnot(None))
                .order_by(BusArrivalRecord.collection_time.desc())
                .limit(30_000)
                .all()
            )
            if not rows:
                self.train()
                return

            records = [
                {
                    **build_features(
                        r.hour_of_day,
                        r.day_of_week,
                        r.bus_load or "SEA",
                        r.bus_type or "SD",
                        r.bus_service,
                        r.bus_stop_code,
                    ),
                    "delay_seconds": r.delay_seconds,
                }
                for r in rows
            ]
            self.train(pd.DataFrame(records))
        finally:
            db.close()

    # ── Inference ─────────────────────────────────────────────────────────────

    def predict(
        self,
        hour: int,
        day_of_week: int,
        bus_load: str = "SEA",
        bus_type: str = "SD",
        service_no: str = "0",
        stop_code: str = "0",
    ) -> float:
        """
        Return predicted delay adjustment in seconds.
        Add this value to the LTA API estimated arrival time to get the
        AI-corrected prediction.
        Returns 0 if the model is not ready.
        """
        if self._pipeline is None:
            return 0.0
        feats = build_features(hour, day_of_week, bus_load, bus_type, service_no, stop_code)
        X = np.array([[feats[f] for f in FEATURES]])
        return float(self._pipeline.predict(X)[0])

    # ── Status ────────────────────────────────────────────────────────────────

    def status(self) -> dict[str, Any]:
        return {
            "trained":       self._pipeline is not None,
            "last_trained":  self.last_trained.isoformat() if self.last_trained else None,
            "training_rows": self.training_rows,
            "mae_seconds":   round(self.mae, 1) if self.mae is not None else None,
            "algorithm":     "GradientBoostingRegressor",
            "features":      FEATURES,
        }


# Singleton used by the rest of the application
model = BusDelayModel()
