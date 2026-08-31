"""
AI delay-prediction model.

Architecture
------------
Algorithm : GradientBoostingRegressor (scikit-learn)
Target    : RESIDUAL slip in seconds — how much further this specific estimate
            will move before the bus actually arrives:

                residual = actual_arrival − estimated_arrival_now

            NOT the bus's total lifetime lateness. That distinction is the
            whole point: LTA's live feed re-estimates constantly, so by the
            time you read "5 min" any delay so far is already priced in.
            Predicting total lateness and adding it to an already-corrected
            estimate double-counts it, which made the adjustment look
            redundant (and often wrong) next to the raw LTA number.
            Residual answers the one question LTA can't: from right now,
            how much more will this slip?

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
  wait_min              – minutes until the CURRENT estimate. Essential: slip
                          accumulates over the journey still to come, so a bus
                          12 min out has room to drift while one 30 s out does
                          not. Without this the model can only learn a constant
                          per-route offset.

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

import hashlib
import logging
import math
import os
from collections import defaultdict
from datetime import datetime, timedelta
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
    "wait_min",
]

# Estimates beyond this are clipped — the LTA feed rarely looks further ahead
# and the relationship flattens out there anyway.
MAX_WAIT_MIN = 30.0

# Hard cap on any predicted adjustment (seconds).
MAX_ADJUSTMENT_SEC = 300.0
# Pseudo-count weight of the ML model when blending with per-route
# empirical medians: final = (n·median + K·model) / (n + K).
EMPIRICAL_PRIOR_K = 8.0
# Minimum observed samples for a (stop, service) pair before its
# empirical median participates in the blend.
EMPIRICAL_MIN_N = 3


def _stable_hash(s: str) -> int:
    """Deterministic across processes — unlike built-in hash(), which is
    salted per interpreter run and would scramble these features on every
    server restart."""
    return int(hashlib.md5(str(s).encode()).hexdigest()[:8], 16) % 1000


# ── Feature helpers ───────────────────────────────────────────────────────────

def _cyclic(value: float, period: float) -> tuple[float, float]:
    """Return (sin, cos) cyclical encoding so the scale wraps around."""
    angle = 2 * math.pi * value / period
    return math.sin(angle), math.cos(angle)


def _is_peak(hour: int, is_weekend: bool) -> bool:
    if is_weekend:
        return False
    return (7 <= hour < 9) or (17 <= hour < 19)


def _wait_band(wait_sec: float) -> int:
    """Coarse bucket of how far out the bus is. The empirical table is keyed on
    this so its per-route medians stay wait-aware — a single median across all
    distances would drag the model's prediction back toward a constant."""
    if wait_sec < 180:
        return 0        # arriving imminently
    if wait_sec < 480:
        return 1        # a few stops away
    return 2            # far out


def build_features(
    hour: int,
    day_of_week: int,
    bus_load: str = "SEA",
    bus_type: str = "SD",
    service_no: str = "0",
    stop_code: str = "0",
    wait_sec: float = 300.0,
) -> dict[str, float]:
    """Return a feature dict ready for model inference."""
    is_wkend = day_of_week >= 5
    hs, hc = _cyclic(hour, 24)
    ds, dc = _cyclic(day_of_week, 7)
    wait_min = max(0.0, min(MAX_WAIT_MIN, float(wait_sec or 0.0) / 60.0))
    return {
        "hour_sin":     hs,
        "hour_cos":     hc,
        "dow_sin":      ds,
        "dow_cos":      dc,
        "is_peak":      float(_is_peak(hour, is_wkend)),
        "is_weekend":   float(is_wkend),
        "load_code":    float(LOAD_MAP.get(bus_load, 0)),
        "type_code":    float(TYPE_MAP.get(bus_type, 0)),
        "service_hash": float(_stable_hash(service_no)),
        "stop_hash":    float(_stable_hash(stop_code)),
        "wait_min":     wait_min,
    }


# ── Synthetic data ────────────────────────────────────────────────────────────

def _generate_synthetic_data(n: int = 5000, seed: int = 42) -> pd.DataFrame:
    """
    Generate synthetic training rows encoding realistic SG bus delay patterns.
    Used to bootstrap the model before real data is available.

    Models slip as something that ACCUMULATES over the journey still ahead:
    a per-minute drift rate set by the time-of-day context, multiplied by the
    minutes remaining. So a peak-hour bus 10 min out is expected to slip far
    more than the same bus 1 min out — which is the shape the residual target
    has in the real data, and what stops the model settling on a constant.
    """
    rng = np.random.default_rng(seed)
    # Seconds of additional slip per minute of journey remaining.
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
        # Live feed skews toward buses that are close; sample accordingly.
        wait_sec    = float(rng.gamma(shape=2.0, scale=180.0))
        wait_sec    = min(wait_sec, MAX_WAIT_MIN * 60)
        wait_min    = wait_sec / 60.0

        if is_pk:
            rate, noise = 13.0, 7.0     # congestion bites hardest at peak
        elif is_wkend:
            rate, noise = 3.0, 4.0
        elif 22 <= hour or hour < 6:
            rate, noise = 1.5, 2.5      # empty roads, estimates hold
        else:
            rate, noise = 5.0, 5.0

        # Crowded buses dwell longer at each stop.
        rate *= {"SEA": 1.0, "SDA": 1.15, "LSD": 1.3}[str(load)]
        # Noise grows with the distance left (more chances to go wrong).
        delay = rng.normal(rate * wait_min, noise * math.sqrt(max(wait_min, 0.1)))

        feats = build_features(hour, dow, load, bus_type, service_no, stop_code, wait_sec)
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
        self.mae: float | None = None          # AI error on the validation set
        self.baseline_mae: float | None = None # raw-LTA error on the same rows
        self.improvement_pct: float | None = None
        self.residual_p90: float | None = None # for an honest "±" band
        # Per (stop, service, wait_band) empirical residual medians from real
        # observations. Blended with the ML output at inference time — routes
        # with real history lean on measured behaviour, unseen routes fall back
        # to the model's generalisation. Keyed by wait band so the blend stays
        # distance-aware instead of flattening back to a per-route constant.
        self._empirical: dict[tuple[str, str, int], tuple[float, int]] = {}
        self.real_rows: int = 0

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
        joblib.dump(
            {
                "pipeline":       self._pipeline,
                "last_trained":   self.last_trained,
                "training_rows":  self.training_rows,
                "mae":            self.mae,
                "baseline_mae":   self.baseline_mae,
                "improvement_pct": self.improvement_pct,
                "residual_p90":   self.residual_p90,
                "features":       FEATURES,
            },
            self.model_path,
        )
        logger.info("Model saved → %s", self.model_path)

    def load(self) -> bool:
        if not os.path.exists(self.model_path):
            return False
        try:
            data = joblib.load(self.model_path)
            # A model trained on a different feature set can't be used — the
            # pipeline would be handed the wrong number of columns and raise on
            # every prediction. Ignore it and retrain. This is what makes a
            # FEATURES change (e.g. adding wait_min) safe to deploy: the stale
            # model on disk is discarded automatically on the next start.
            saved_features = data.get("features")
            if list(saved_features or []) != FEATURES:
                logger.warning(
                    "Saved model was trained on a different feature set "
                    "(%s vs %d current) — retraining from scratch.",
                    len(saved_features) if saved_features else "none/legacy", len(FEATURES),
                )
                return False
            self._pipeline    = data["pipeline"]
            self.last_trained = data["last_trained"]
        except Exception as exc:
            # A truncated/incompatible file (disk-full during save, sklearn
            # version bump) must not crash-loop the service at startup —
            # fall through to retraining from scratch instead.
            logger.error("Saved model unreadable (%s) — will retrain: %s",
                         self.model_path, exc)
            return False
        self.training_rows   = data.get("training_rows", 0)
        self.mae             = data.get("mae")
        self.baseline_mae    = data.get("baseline_mae")
        self.improvement_pct = data.get("improvement_pct")
        self.residual_p90    = data.get("residual_p90")
        logger.info("Model loaded  rows=%d  MAE=%.1fs", self.training_rows, self.mae or 0)
        return True

    # ── Training ──────────────────────────────────────────────────────────────

    def train(self, df: pd.DataFrame | None = None) -> None:
        """
        Train on *df* if provided (real DB data), otherwise use synthetic data.

        Sample weighting:
        - real rows decay with age (half-life 14 days) so the model tracks
          current behaviour, with a 3× base weight over synthetic rows
        - synthetic bootstrap rows fade out as real data accumulates
        """
        synthetic = _generate_synthetic_data()

        if df is not None and len(df) >= 50:
            cols = [c for c in FEATURES + ["delay_seconds", "age_days"] if c in df.columns]
            df_real = df[cols].dropna(subset=FEATURES + ["delay_seconds"])
            age = df_real["age_days"].values if "age_days" in df_real.columns else np.zeros(len(df_real))
            real_w = 3.0 * np.power(0.5, age / 14.0)
            real_w = np.clip(real_w, 0.25, 3.0)
            synth_w = max(0.1, 1.0 - len(df_real) / 5000.0)

            combined = pd.concat(
                [synthetic[FEATURES + ["delay_seconds"]], df_real[FEATURES + ["delay_seconds"]]],
                ignore_index=True,
            )
            weights = np.concatenate([np.full(len(synthetic), synth_w), real_w])
            self.real_rows = len(df_real)
            logger.info("Training on %d synthetic (w=%.2f) + %d real rows",
                        len(synthetic), synth_w, len(df_real))
        else:
            combined = synthetic
            weights = np.ones(len(synthetic))
            self.real_rows = 0
            logger.info("Training on %d synthetic rows (no real data yet)", len(synthetic))

        X = combined[FEATURES].values
        y = combined["delay_seconds"].values

        X_train, X_val, y_train, y_val, w_train, _w_val = train_test_split(
            X, y, weights, test_size=0.15, random_state=42)

        # Fit into a local, then publish. predict() runs concurrently from
        # other threads; assigning the shared attribute before fit() finishes
        # would expose an unfitted pipeline (NotFittedError) mid-retrain.
        pipeline = Pipeline([
            ("scaler", StandardScaler()),
            ("gbr", GradientBoostingRegressor(
                n_estimators=200,
                max_depth=4,
                learning_rate=0.05,
                subsample=0.8,
                random_state=42,
            )),
        ])
        pipeline.fit(X_train, y_train, gbr__sample_weight=w_train)
        self._pipeline = pipeline

        y_pred = self._pipeline.predict(X_val)
        self.mae = float(mean_absolute_error(y_val, y_pred))

        # ── Head-to-head: raw LTA vs AI-adjusted ─────────────────────────
        # The target is the residual (actual − LTA estimate), so "trust LTA
        # exactly as-is" IS the zero-adjustment prediction. Its error on the
        # same held-out rows is therefore the honest baseline, and the gap
        # between the two is the only fair claim we can make about whether
        # the adjustment helps at all. If improvement isn't clearly positive,
        # the point adjustment is not worth showing — surface the uncertainty
        # band instead.
        self.baseline_mae = float(mean_absolute_error(y_val, np.zeros_like(y_val)))
        self.improvement_pct = (
            float((self.baseline_mae - self.mae) / self.baseline_mae * 100.0)
            if self.baseline_mae > 0 else 0.0
        )
        # Spread of the residual — this is what an honest "±" band on the
        # displayed ETA should be built from.
        self.residual_p90 = float(np.percentile(np.abs(y_val), 90))

        self.last_trained  = datetime.utcnow()
        self.training_rows = len(combined)

        logger.info(
            "Training complete  rows=%d  AI MAE=%.1fs  raw-LTA MAE=%.1fs  improvement=%+.1f%%",
            self.training_rows, self.mae, self.baseline_mae, self.improvement_pct,
        )
        self.save()

    def load_or_train(self, df: pd.DataFrame | None = None) -> None:
        """Load a saved model if available; otherwise train from scratch."""
        if not self.load():
            logger.info("No saved model found — training from scratch")
            self.train(df)
        self.refresh_empirical()

    def refresh_empirical(self) -> None:
        """Rebuild the per (stop, service, wait_band) median-residual table from
        the last 30 days of real observations. Cheap; called after every
        retrain.

        Banded by distance on purpose: a single median per route would mix
        readings taken 30 s out with ones taken 15 min out, and blending that
        average back over the model's prediction would undo the wait_min
        feature and flatten the output into a per-route constant again.
        """
        from database import SessionLocal, BusArrivalRecord

        db = SessionLocal()
        try:
            cutoff = datetime.utcnow() - timedelta(days=30)
            rows = (
                db.query(
                    BusArrivalRecord.bus_stop_code,
                    BusArrivalRecord.bus_service,
                    BusArrivalRecord.delay_seconds,
                    BusArrivalRecord.wait_seconds,
                )
                .filter(
                    BusArrivalRecord.delay_seconds.isnot(None),
                    BusArrivalRecord.collection_time >= cutoff,
                )
                .all()
            )
            groups: dict[tuple[str, str, int], list[float]] = defaultdict(list)
            for stop, svc, delay, wait in rows:
                band = _wait_band(float(wait or 0.0))
                groups[(str(stop), str(svc), band)].append(float(delay))
            self._empirical = {
                key: (float(np.median(vals)), len(vals))
                for key, vals in groups.items()
            }
            logger.info("Empirical table refreshed: %d (stop, service, band) keys "
                        "from %d observations", len(self._empirical), len(rows))
        except Exception as exc:
            logger.warning("Empirical refresh failed (non-fatal): %s", exc)
        finally:
            db.close()

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
                self.refresh_empirical()
                return

            now = datetime.utcnow()
            records = [
                {
                    **build_features(
                        r.hour_of_day,
                        r.day_of_week,
                        r.bus_load or "SEA",
                        r.bus_type or "SD",
                        r.bus_service,
                        r.bus_stop_code,
                        r.wait_seconds,
                    ),
                    "delay_seconds": r.delay_seconds,
                    "age_days": max(0.0, (now - r.collection_time).total_seconds() / 86400.0)
                                if r.collection_time else 0.0,
                }
                for r in rows
            ]
            self.train(pd.DataFrame(records))
            self.refresh_empirical()
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
        wait_sec: float = 300.0,
    ) -> float:
        """
        Return the predicted RESIDUAL slip in seconds — how much further this
        estimate is expected to move before the bus arrives. Add it to the LTA
        estimate to get the AI-corrected prediction.

        `wait_sec` (seconds until the current LTA estimate) matters a lot: slip
        accrues over the journey still ahead, so the same route predicts a big
        adjustment 12 min out and ~0 when the bus is pulling in.

        Two-layer prediction:
        1. GradientBoosting model (generalises across all routes/stops)
        2. Empirical median for this (stop, service, wait band), weighted by
           how many real observations back it up
        Returns 0 if the model is not ready.
        """
        if self._pipeline is None:
            return 0.0
        feats = build_features(hour, day_of_week, bus_load, bus_type,
                               service_no, stop_code, wait_sec)
        X = np.array([[feats[f] for f in FEATURES]])
        adj = float(self._pipeline.predict(X)[0])

        band = _wait_band(float(wait_sec or 0.0))
        med_n = self._empirical.get((str(stop_code), str(service_no), band))
        if med_n is not None and med_n[1] >= EMPIRICAL_MIN_N:
            median, n = med_n
            adj = (n * median + EMPIRICAL_PRIOR_K * adj) / (n + EMPIRICAL_PRIOR_K)

        # A bus can't slip further into the past than its own arrival, and the
        # remaining journey caps how much it can slip forward.
        adj = max(-float(wait_sec or 0.0), adj)
        return float(max(-MAX_ADJUSTMENT_SEC, min(MAX_ADJUSTMENT_SEC, adj)))

    def uncertainty_sec(self, stop_code: str = "0", service_no: str = "0") -> float | None:
        """Typical size of the error still left after adjustment — the number an
        honest "5 min ± 90s" band should be built from."""
        return self.residual_p90

    # ── Status ────────────────────────────────────────────────────────────────

    def status(self) -> dict[str, Any]:
        return {
            "trained":       self._pipeline is not None,
            "last_trained":  self.last_trained.isoformat() if self.last_trained else None,
            "training_rows": self.training_rows,
            "real_rows":     self.real_rows,
            "empirical_pairs": len(self._empirical),
            "mae_seconds":   round(self.mae, 1) if self.mae is not None else None,
            # Head-to-head on the same held-out rows. baseline = trusting the
            # raw LTA estimate as-is (zero adjustment); ai = after adjustment.
            # improvement_pct > 0 means the adjustment genuinely helps; if it
            # hovers around 0, stop showing the adjusted number and lead with
            # the uncertainty band instead.
            "baseline_mae_seconds": round(self.baseline_mae, 1) if self.baseline_mae is not None else None,
            "improvement_pct": round(self.improvement_pct, 1) if self.improvement_pct is not None else None,
            "residual_p90_seconds": round(self.residual_p90, 1) if self.residual_p90 is not None else None,
            "target":        "residual slip vs current LTA estimate",
            "algorithm":     "Gradient boosting + per-route empirical blend",
            "features":      FEATURES,
        }


# Singleton used by the rest of the application
model = BusDelayModel()
