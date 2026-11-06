"""
AI delay-prediction model.

Architecture
------------
Algorithm : HistGradientBoostingRegressor (scikit-learn), absolute-error loss
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
  wait_min              – minutes until the CURRENT estimate. Essential: slip
                          accumulates over the journey still to come, so a bus
                          12 min out has room to drift while one 30 s out does
                          not.
  svc_cat / stop_cat    – service and stop as true categories (the most
                          common MAX_CATEGORIES of each; the rest are
                          "unknown"). Hashing them into one numeric column
                          made the trees memorise arbitrary number ranges.

Training data and the "only when it helps" gate
-----------------------------------------------
Real labels only (label_v = 2, see data_collector), no synthetic bootstrap:
the old synthetic rows assumed buses always run late and pushed every
estimate ~45 s later. Validation is a TIME split — train on older days,
score on the most recent ones — because a random split leaks the same buses
into both halves and flatters the model.

The adjustment is applied per wait band only where it beat raw LTA on that
held-out period by at least MIN_GAIN_PCT. Everywhere else (and until there
are MIN_REAL_ROWS labels) predict() returns 0, i.e. the plain LTA estimate.
"""

import logging
import math
import os
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

LOAD_MAP  = {"SEA": 0, "SDA": 1, "LSD": 2}
TYPE_MAP  = {"SD": 0, "DD": 1, "BD": 2}
NUMERIC_FEATURES = [
    "hour_sin", "hour_cos",
    "dow_sin",  "dow_cos",
    "is_peak", "is_weekend",
    "load_code", "type_code",
    "wait_min",
]
CATEGORICAL_FEATURES = ["svc_cat", "stop_cat"]
FEATURES = NUMERIC_FEATURES + CATEGORICAL_FEATURES

# HistGradientBoosting caps categories at 255 bins; keep headroom.
MAX_CATEGORIES = 250

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

# No model below this many real labels; the adjustment stays off (pure LTA).
MIN_REAL_ROWS = 2000
# Most recent share of the (time-ordered) labels held out for validation.
VAL_FRACTION = 0.2
# A wait band gets the adjustment only if it beat raw LTA there by this much
# on the held-out period, with at least MIN_BAND_VAL rows to judge by.
MIN_GAIN_PCT = 2.0
MIN_BAND_VAL = 200
# Training window and sample size (an even sample across the window).
TRAIN_DAYS = 28
TRAIN_SAMPLE = 250_000
# Only labels written by the fixed collector (see data_collector).
LABEL_VERSION = 2


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
    """Coarse bucket of how far out the bus is. The empirical table and the
    on/off gate are keyed on this: LTA is already within ~20 s when a bus is
    pulling in but over a minute off when it is 15+ min out."""
    if wait_sec < 120:
        return 0        # arriving imminently
    if wait_sec < 300:
        return 1        # a few stops away
    if wait_sec < 600:
        return 2
    if wait_sec < 900:
        return 3
    return 4            # far out


def build_features(
    hour: int,
    day_of_week: int,
    bus_load: str = "SEA",
    bus_type: str = "SD",
    wait_sec: float = 300.0,
) -> dict[str, float]:
    """Return the numeric features (categories are encoded by the model,
    which owns the service/stop vocabulary)."""
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
        "wait_min":     wait_min,
    }


def _vocab(values) -> dict[str, int]:
    """Most common MAX_CATEGORIES values → category codes."""
    return {v: i for i, (v, _n) in enumerate(Counter(values).most_common(MAX_CATEGORIES))}


def _matrix(df: pd.DataFrame, svc_vocab: dict[str, int], stop_vocab: dict[str, int]) -> np.ndarray:
    svc = df["svc"].map(svc_vocab).astype(float).values     # unseen → NaN (missing)
    stop = df["stop"].map(stop_vocab).astype(float).values
    return np.column_stack([df[NUMERIC_FEATURES].values, svc, stop])


def _empirical_table(df: pd.DataFrame) -> dict[tuple[str, str, int], tuple[float, int]]:
    groups = df.groupby(["stop", "svc", "band"])["delay_seconds"]
    return {key: (float(med), int(n)) for key, med, n in
            zip(groups.median().index, groups.median().values, groups.size().values)}


def _blend(adj: np.ndarray, df: pd.DataFrame,
           table: dict[tuple[str, str, int], tuple[float, int]]) -> np.ndarray:
    out = adj.copy()
    for i, key in enumerate(zip(df["stop"], df["svc"], df["band"])):
        med_n = table.get(key)
        if med_n is not None and med_n[1] >= EMPIRICAL_MIN_N:
            median, n = med_n
            out[i] = (n * median + EMPIRICAL_PRIOR_K * out[i]) / (n + EMPIRICAL_PRIOR_K)
    return out


def _new_regressor() -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(
        loss="absolute_error",      # MAE is what riders feel; robust to the odd mislabel
        max_iter=300,
        learning_rate=0.08,
        max_leaf_nodes=63,
        categorical_features=[FEATURES.index(c) for c in CATEGORICAL_FEATURES],
        random_state=42,
    )


# ── Model class ───────────────────────────────────────────────────────────────

class BusDelayModel:
    """
    Wraps a scikit-learn HistGradientBoostingRegressor.

    Usage
    -----
    model = BusDelayModel()
    model.load_or_train()              # call once at startup

    adjustment = model.predict(        # call per bus arrival
        hour=8, day_of_week=1,
        bus_load="SDA", bus_type="DD",
        service_no="65", stop_code="83139"
    )
    # adjustment is seconds to add to the LTA API estimate (0 = trust LTA)
    """

    def __init__(self, model_path: str | None = None) -> None:
        from config import MODEL_PATH
        self.model_path = model_path or MODEL_PATH
        self._pipeline: HistGradientBoostingRegressor | None = None
        self._svc_vocab: dict[str, int] = {}
        self._stop_vocab: dict[str, int] = {}
        self.last_trained: datetime | None = None
        self.training_rows: int = 0
        self.mae: float | None = None          # AI error on the validation set
        self.baseline_mae: float | None = None # raw-LTA error on the same rows
        self.improvement_pct: float | None = None
        self.residual_p90: float | None = None # for an honest "±" band
        # Wait bands where the adjustment beat raw LTA on held-out days, and
        # the per-band comparison behind that decision.
        self.enabled_bands: set[int] = set()
        self.band_report: dict[int, dict[str, float]] = {}
        # Per (stop, service, wait_band) empirical residual medians from real
        # observations. Blended with the ML output at inference time — routes
        # with real history lean on measured behaviour, unseen routes fall back
        # to the model's generalisation.
        self._empirical: dict[tuple[str, str, int], tuple[float, int]] = {}
        self.real_rows: int = 0

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
        joblib.dump(
            {
                "pipeline":       self._pipeline,
                "svc_vocab":      self._svc_vocab,
                "stop_vocab":     self._stop_vocab,
                "last_trained":   self.last_trained,
                "training_rows":  self.training_rows,
                "real_rows":      self.real_rows,
                "mae":            self.mae,
                "baseline_mae":   self.baseline_mae,
                "improvement_pct": self.improvement_pct,
                "residual_p90":   self.residual_p90,
                "enabled_bands":  sorted(self.enabled_bands),
                "band_report":    self.band_report,
                "features":       FEATURES,
                "label_version":  LABEL_VERSION,
            },
            self.model_path,
        )
        logger.info("Model saved → %s", self.model_path)

    def load(self) -> bool:
        if not os.path.exists(self.model_path):
            return False
        try:
            data = joblib.load(self.model_path)
            # A model trained on a different feature set or label version
            # can't be used — ignore it and retrain. This is what makes a
            # FEATURES change safe to deploy: the stale model on disk is
            # discarded automatically on the next start.
            if (list(data.get("features") or []) != FEATURES
                    or data.get("label_version") != LABEL_VERSION):
                logger.warning("Saved model uses an older feature set or labels — retraining.")
                return False
            self._pipeline    = data["pipeline"]
            self._svc_vocab   = data.get("svc_vocab", {})
            self._stop_vocab  = data.get("stop_vocab", {})
            self.last_trained = data["last_trained"]
        except Exception as exc:
            # A truncated/incompatible file (disk-full during save, sklearn
            # version bump) must not crash-loop the service at startup —
            # fall through to retraining from scratch instead.
            logger.error("Saved model unreadable (%s) — will retrain: %s",
                         self.model_path, exc)
            return False
        self.training_rows   = data.get("training_rows", 0)
        self.real_rows       = data.get("real_rows", 0)
        self.mae             = data.get("mae")
        self.baseline_mae    = data.get("baseline_mae")
        self.improvement_pct = data.get("improvement_pct")
        self.residual_p90    = data.get("residual_p90")
        self.enabled_bands   = set(data.get("enabled_bands") or [])
        self.band_report     = data.get("band_report") or {}
        logger.info("Model loaded  rows=%d  MAE=%.1fs  adjusting bands=%s",
                    self.training_rows, self.mae or 0, sorted(self.enabled_bands))
        return True

    # ── Training ──────────────────────────────────────────────────────────────

    def train(self, df: pd.DataFrame | None = None) -> None:
        """
        Train on *df*: real labelled rows with NUMERIC_FEATURES plus "svc",
        "stop", "collection_time" and "delay_seconds".

        1. Time split: the oldest 80% trains, the newest 20% validates.
        2. Per wait band, compare model+empirical blend against raw LTA (zero
           adjustment) on the validation rows; enable only the bands that win.
        3. Refit on everything for serving.
        """
        self.last_trained = datetime.utcnow()
        if df is None or len(df) < MIN_REAL_ROWS:
            n = 0 if df is None else len(df)
            self._pipeline = None
            self.enabled_bands = set()
            self.band_report = {}
            self.real_rows = self.training_rows = n
            self.mae = self.baseline_mae = self.improvement_pct = None
            logger.info("Only %d real labels (need %d) — no adjustment, showing raw LTA",
                        n, MIN_REAL_ROWS)
            self.save()
            return

        df = df.dropna(subset=NUMERIC_FEATURES + ["delay_seconds"])
        # Sort on the int64 view: pandas' datetime sort_values crashes under
        # this venv's numpy 1.26 on Python 3.14.
        t_ns = pd.to_datetime(df["collection_time"]).values.astype("datetime64[ns]").view("i8")
        df = df.iloc[np.argsort(t_ns, kind="stable")]
        df = df.assign(band=[_wait_band(w * 60.0) for w in df["wait_min"]])
        cut = int(len(df) * (1 - VAL_FRACTION))
        tr, va = df.iloc[:cut], df.iloc[cut:]

        svc_vocab, stop_vocab = _vocab(tr["svc"]), _vocab(tr["stop"])
        reg = _new_regressor().fit(_matrix(tr, svc_vocab, stop_vocab), tr["delay_seconds"].values)
        pred = _blend(reg.predict(_matrix(va, svc_vocab, stop_vocab)), va, _empirical_table(tr))
        pred = np.clip(np.maximum(pred, -va["wait_min"].values * 60.0),
                       -MAX_ADJUSTMENT_SEC, MAX_ADJUSTMENT_SEC)
        y = va["delay_seconds"].values

        # ── Head-to-head: raw LTA vs AI-adjusted, per wait band ─────────────
        # The target is the residual (actual − LTA estimate), so "trust LTA
        # exactly as-is" IS the zero-adjustment prediction.
        enabled, report = set(), {}
        bands = va["band"].values
        for b in range(5):
            m = bands == b
            if not m.any():
                continue
            lta = float(np.abs(y[m]).mean())
            ai = float(np.abs(y[m] - pred[m]).mean())
            gain = (lta - ai) / lta * 100.0 if lta > 0 else 0.0
            report[b] = {"rows": int(m.sum()), "lta_mae": round(lta, 1),
                         "ai_mae": round(ai, 1), "gain_pct": round(gain, 1)}
            if m.sum() >= MIN_BAND_VAL and gain >= MIN_GAIN_PCT:
                enabled.add(b)

        # What riders actually get: the adjustment where enabled, LTA elsewhere.
        served = np.where(np.isin(bands, list(enabled)), pred, 0.0)
        self.baseline_mae = float(np.abs(y).mean())
        self.mae = float(np.abs(y - served).mean())
        self.improvement_pct = (
            (self.baseline_mae - self.mae) / self.baseline_mae * 100.0 if self.baseline_mae > 0 else 0.0
        )
        # Spread of what's left — what an honest "±" band should be built from.
        self.residual_p90 = float(np.percentile(np.abs(y - served), 90))

        # Refit on all rows for serving. Fit into locals, then publish:
        # predict() runs concurrently from other threads.
        svc_vocab, stop_vocab = _vocab(df["svc"]), _vocab(df["stop"])
        reg = _new_regressor().fit(_matrix(df, svc_vocab, stop_vocab), df["delay_seconds"].values)
        self._svc_vocab, self._stop_vocab = svc_vocab, stop_vocab
        self._pipeline = reg
        self.enabled_bands, self.band_report = enabled, report
        self.real_rows = self.training_rows = len(df)

        logger.info(
            "Training complete  rows=%d  served MAE=%.1fs  raw-LTA MAE=%.1fs  improvement=%+.1f%%  "
            "adjusting bands=%s  per band=%s",
            self.training_rows, self.mae, self.baseline_mae, self.improvement_pct,
            sorted(enabled), report,
        )
        self.save()

    def load_or_train(self, df: pd.DataFrame | None = None) -> None:
        """Load a saved model if available; otherwise train from the DB."""
        if not self.load():
            logger.info("No usable saved model — training from the database")
            if df is not None:
                self.train(df)
            else:
                self.retrain_from_db()
                return
        self.refresh_empirical()

    def refresh_empirical(self) -> None:
        """Rebuild the per (stop, service, wait_band) median-residual table from
        the last 30 days of real observations. Cheap; called after every
        retrain."""
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
                    BusArrivalRecord.label_v == LABEL_VERSION,
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
        """Pull ground-truth rows from the DB and retrain.

        Takes an even sample of the last TRAIN_DAYS rather than the newest N
        rows: at ~90k labels a day, "newest 60k" would be under a day of data
        and miss weekday/weekend and peak patterns entirely."""
        from sqlalchemy import func
        from database import SessionLocal, BusArrivalRecord as R

        db = SessionLocal()
        try:
            labelled = (
                R.delay_seconds.isnot(None),
                R.label_v == LABEL_VERSION,
                R.collection_time >= datetime.utcnow() - timedelta(days=TRAIN_DAYS),
            )
            total = db.query(func.count(R.id)).filter(*labelled).scalar() or 0
            step = max(1, math.ceil(total / TRAIN_SAMPLE))
            rows = (
                db.query(R.hour_of_day, R.day_of_week, R.bus_load, R.bus_type, R.wait_seconds,
                         R.bus_service, R.bus_stop_code, R.collection_time, R.delay_seconds)
                .filter(*labelled, R.id % step == 0)
                .all()
            )
            records = [
                {
                    **build_features(hour, dow, load or "SEA", btype or "SD", wait),
                    "svc": str(svc),
                    "stop": str(stop),
                    "collection_time": t,
                    "delay_seconds": delay,
                }
                for hour, dow, load, btype, wait, svc, stop, t, delay in rows
            ]
        finally:
            db.close()
        self.train(pd.DataFrame(records) if records else None)
        self.refresh_empirical()

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

        Two-layer prediction:
        1. Gradient boosting model (generalises across all routes/stops)
        2. Empirical median for this (stop, service, wait band), weighted by
           how many real observations back it up
        Returns 0 (trust LTA) if there is no model or the adjustment did not
        beat LTA for this wait band on held-out days.
        """
        pipeline = self._pipeline
        band = _wait_band(float(wait_sec or 0.0))
        if pipeline is None or band not in self.enabled_bands:
            return 0.0
        feats = build_features(hour, day_of_week, bus_load, bus_type, wait_sec)
        X = np.array([[feats[f] for f in NUMERIC_FEATURES]
                      + [self._svc_vocab.get(str(service_no), np.nan),
                         self._stop_vocab.get(str(stop_code), np.nan)]], dtype=float)
        adj = float(pipeline.predict(X)[0])

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
            # Head-to-head on the same held-out (most recent) rows.
            # baseline = trusting the raw LTA estimate as-is; ai = what is
            # actually served (adjusted only in enabled bands).
            "baseline_mae_seconds": round(self.baseline_mae, 1) if self.baseline_mae is not None else None,
            "improvement_pct": round(self.improvement_pct, 1) if self.improvement_pct is not None else None,
            "residual_p90_seconds": round(self.residual_p90, 1) if self.residual_p90 is not None else None,
            "adjusting_wait_bands": sorted(self.enabled_bands),
            "band_report":   {str(k): v for k, v in self.band_report.items()},
            "target":        "residual slip vs current LTA estimate",
            "algorithm":     "Histogram gradient boosting + per-route empirical blend, time-split gated",
            "features":      FEATURES,
        }


# Singleton used by the rest of the application
model = BusDelayModel()
