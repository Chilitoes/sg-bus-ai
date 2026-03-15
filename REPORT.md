# SG Bus AI — Technical Report

**Project:** Singapore AI Bus Arrival Prediction Web Application
**Stack:** Python · FastAPI · SQLite · scikit-learn · Vanilla JS · Chart.js
**Date:** March 2026

---

## 1. Executive Summary

SG Bus AI is a full-stack web application that combines real-time bus arrival data from the Land Transport Authority (LTA) DataMall API with a machine learning model to produce AI-adjusted arrival predictions. It also collects historical arrival data in the background to continuously improve the model's accuracy over time.

The system addresses a core limitation of the LTA API: its estimates become less accurate the further in the future they are. By learning systematic delay patterns (rush-hour congestion, service-specific reliability, time-of-day effects), the AI layer corrects for these biases before displaying the arrival time to the user.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          BROWSER                                │
│                                                                 │
│   index.html + styles.css + app.js                             │
│   ┌──────────────┐  ┌─────────────────┐  ┌──────────────────┐ │
│   │  Search Tab  │  │  Favourites Tab │  │  Chart.js Charts │ │
│   │  Autocomplete│  │  localStorage   │  │  Delay stats     │ │
│   └──────┬───────┘  └─────────────────┘  └──────────────────┘ │
│          │  fetch()                                             │
└──────────┼──────────────────────────────────────────────────────┘
           │ HTTP/JSON  (/api/*)
┌──────────▼──────────────────────────────────────────────────────┐
│                       FASTAPI BACKEND                           │
│                                                                 │
│   api_routes.py                                                 │
│   GET  /api/arrivals/{stop}    ←── LTA API + ML prediction     │
│   GET  /api/stats/{stop}       ←── SQLite aggregation          │
│   GET  /api/stops/search       ←── Bus stop name search        │
│   GET  /api/stops/{code}       ←── Single stop lookup          │
│   POST /api/stops/sync         ←── LTA BusStops sync           │
│   GET  /api/model/status       ←── Model metadata              │
│   POST /api/model/retrain      ←── On-demand retrain           │
│   POST /api/monitor/{stop}     ←── Add stop to collector       │
│                                                                 │
│   ml_model.py            data_collector.py                     │
│   GradientBoosting ───►  asyncio loop (every 5 min)           │
│   predict(features)      poll LTA → save records               │
│                          track buses → derive delay            │
└─────────────┬───────────────────────┬───────────────────────────┘
              │ SQLAlchemy ORM        │ httpx async
┌─────────────▼─────────┐   ┌────────▼────────────────────────────┐
│      SQLite DB        │   │        LTA DataMall API              │
│  bus_arrival_records  │   │                                      │
│  bus_tracking         │   │  /v3/BusArrival?BusStopCode=XXXXX   │
│  bus_stops            │   │  /BusStops?$skip=N                  │
│  monitored_stops      │   │  Header: AccountKey: <key>          │
└───────────────────────┘   └─────────────────────────────────────┘
```

---

## 3. Data Flow

### 3.1 Real-time Arrival Request

When a user searches for a bus stop:

```
User types stop code / name
         │
         ▼
Autocomplete: GET /api/stops/search?q=...
         │
         ▼ (user selects or submits)
GET /api/arrivals/{stop_code}
         │
         ├─► LTA API call (httpx async)
         │   Returns: ServiceNo, EstimatedArrival, Load, Type (per slot)
         │
         ├─► For each bus slot:
         │     adjustment = model.predict(hour, dow, load, type, service, stop)
         │     ai_arrival = lta_estimated_arrival + adjustment
         │
         └─► JSON response → frontend renders cards + countdown timer
```

### 3.2 Background Data Collection

Every 5 minutes, `data_collector.py` runs:

```
For each monitored stop:
    ├─► Call LTA /v3/BusArrival
    ├─► Save BusArrivalRecord rows (raw snapshot)
    └─► Update BusTracking:
            First sighting?  → open tracking row, record first_estimate
            Seen again?      → update last_estimate
            Disappeared?     → CLOSE row:
                               delay = last_estimate − first_estimate
                               back-fill BusArrivalRecord.delay_seconds
```

### 3.3 Model Retraining

Every hour (or on demand via `POST /api/model/retrain`):

```
1. Pull all BusArrivalRecord rows where delay_seconds IS NOT NULL
2. Combine with 5,000 synthetic bootstrap rows (3× real data weight)
3. Fit GradientBoostingRegressor on 8 features
4. Evaluate MAE on 15% validation split
5. Save model to models/delay_model.joblib
```

---

## 4. Machine Learning Model

### 4.1 Algorithm

**Gradient Boosting Regressor** (scikit-learn `GradientBoostingRegressor`)

| Hyperparameter | Value | Reason |
|---|---|---|
| `n_estimators` | 200 | Enough trees for tabular data without overfitting |
| `max_depth` | 4 | Limits complexity; avoids memorising noise |
| `learning_rate` | 0.05 | Low rate + more trees = better generalisation |
| `subsample` | 0.8 | Stochastic sampling reduces variance |

A `StandardScaler` is applied before the regressor (Pipeline) to normalise feature scales.

### 4.2 Features

| Feature | Encoding | Why |
|---|---|---|
| `hour_sin`, `hour_cos` | Cyclical (sin/cos of hour/24·2π) | Midnight wraps to 1 am naturally |
| `dow_sin`, `dow_cos` | Cyclical (day/7·2π) | Monday wraps to Sunday naturally |
| `is_peak` | Binary 0/1 | Mon–Fri 7–9 am and 5–7 pm flag |
| `is_weekend` | Binary 0/1 | Weekend vs weekday behaviour differs significantly |
| `load_code` | Ordinal (SEA=0, SDA=1, LSD=2) | Crowded buses tend to dwell longer at stops |
| `type_code` | Ordinal (SD=0, DD=1, BD=2) | Bus type affects boarding speed |
| `service_hash` | `hash(service_no) % 1000` | Stable numeric route proxy |
| `stop_hash` | `hash(stop_code) % 1000` | Stable numeric stop proxy |

**Why cyclical encoding?** If we used raw hour (0–23), the model would treat 23 and 0 as far apart. With sin/cos encoding, 23:00 and 00:00 are adjacent in feature space — essential for correct late-night modelling.

### 4.3 Target Variable

`delay_seconds` — the number of seconds the bus arrived later (positive) or earlier (negative) than the LTA API's first estimate.

Derived by tracking the same bus across API polls:
- `first_estimate`: what LTA said when the bus was first detected
- `last_estimate`: the final estimate before the bus disappeared (i.e., arrived)
- `delay = last_estimate − first_estimate`

### 4.4 Bootstrap Strategy

On day one there is no historical data. The model is pre-trained on **5,000 synthetic rows** encoding realistic Singapore delay patterns:

| Condition | Mean delay | Std dev |
|---|---|---|
| Weekday peak (7–9, 17–19) | +150 s | 90 s |
| Weekday off-peak | +40 s | 60 s |
| Weekend | +20 s | 50 s |
| Late night (22:00–06:00) | +10 s | 30 s |

As real data accumulates, it is given **3× weight** relative to synthetic data, so the model progressively shifts toward actual observed patterns.

### 4.5 Model Performance

| Stage | Expected MAE |
|---|---|
| Bootstrap only (day 1) | ~45–55 s |
| 1 week of data (~2,000 real rows) | ~35–45 s |
| 1 month of data (~10,000 real rows) | ~20–35 s |

*MAE = mean absolute error on a 15% held-out validation set.*

---

## 5. Backend Components

### `config.py`
Reads all configuration from environment variables via `python-dotenv`. Key variables: `LTA_API_KEY`, `DATABASE_URL`, `COLLECTION_INTERVAL_MINUTES`, `MODEL_RETRAIN_INTERVAL_HOURS`, `MONITORED_STOPS`.

### `database.py`
SQLAlchemy ORM with four tables:

| Table | Purpose |
|---|---|
| `bus_arrival_records` | Raw API snapshot per bus per collection cycle |
| `bus_tracking` | Tracks each bus across cycles to derive ground-truth delay |
| `bus_stops` | Full Singapore stop directory (synced from LTA on startup) |
| `monitored_stops` | Which stops the background collector polls |

### `ml_model.py`
`BusDelayModel` class encapsulates the sklearn Pipeline. Key methods:
- `load_or_train()` — loads saved model or trains from scratch
- `predict(hour, dow, load, type, service, stop)` → `float` seconds
- `retrain_from_db()` — pulls real data from SQLite, retrains, saves
- `status()` → dict with MAE, training rows, last-trained timestamp

### `data_collector.py`
Async `asyncio` loop. For each monitored stop each cycle:
1. Calls `fetch_arrivals()` via `httpx.AsyncClient`
2. Saves `BusArrivalRecord` rows
3. Calls `_upsert_tracking()` to open/update BusTracking rows
4. Calls `_close_stale_tracking()` to detect arrived buses and compute delay

### `api_routes.py`
FastAPI `APIRouter`. All endpoints prefixed `/api`. Uses SQLAlchemy `Depends(get_db)` pattern for connection lifecycle management.

### `main.py`
FastAPI `lifespan` context manager orchestrates startup: DB init → model load → bus stop sync → collector launch. The frontend is served as `StaticFiles` mounted at `/` after all API routes.

---

## 6. Frontend Components

### Architecture
Vanilla HTML/CSS/JavaScript — no build step or framework required. Chart.js is loaded from CDN.

### `index.html`
Two-tab layout:
- **Search tab** — search input, autocomplete dropdown, arrivals grid, charts, AI explainer
- **Favourites tab** — saved stops grid (persisted to `localStorage`)

### `styles.css`
Mobile-first CSS using custom properties (design tokens). Dark gradient header, white card surfaces, responsive grid layouts.

Key design decisions:
- 8 rotating card colour gradients to visually distinguish services
- Cyclical colour by service index (not service number) for visual variety
- Peak hours highlighted in amber on the hour chart

### `app.js`
Single-file vanilla JS with a `state` object as single source of truth. Key subsystems:

| Subsystem | Description |
|---|---|
| **Autocomplete** | Debounced (250 ms) `/api/stops/search` calls; click-outside dismissal |
| **Arrivals rendering** | `renderServiceCard()` + `renderBusRow()` produce HTML strings; injected via `innerHTML` |
| **Countdown ticker** | `setInterval` every 1 s; updates only `.countdown-val[data-ai-iso]` nodes — no full re-render |
| **Auto-refresh** | `setInterval` every 30 s; calls `refreshArrivals()` which replaces card content |
| **Favourites** | CRUD on `localStorage` key `sg_bus_ai_favourites`; synced to tab badge count |
| **Tab system** | Pure CSS + JS class toggling; no router needed |
| **Charts** | Destroyed and recreated on each stats load to avoid canvas state issues |

---

## 7. API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/arrivals/{stop_code}` | LTA real-time data + AI prediction per bus slot |
| `GET` | `/api/stats/{stop_code}` | Delay aggregates: by service, by hour, 14-day trend |
| `GET` | `/api/stops/search?q=` | Search stops by code prefix or partial name/road |
| `GET` | `/api/stops/{stop_code}` | Single stop lookup (name, road, coordinates) |
| `POST` | `/api/stops/sync` | Re-sync full bus stop directory from LTA |
| `GET` | `/api/model/status` | Model MAE, training rows, last-trained timestamp |
| `POST` | `/api/model/retrain` | Trigger immediate model retrain from DB data |
| `GET` | `/api/monitor` | List actively monitored stops |
| `POST` | `/api/monitor/{stop_code}` | Add stop to background collector |
| `DELETE` | `/api/monitor/{stop_code}` | Remove stop from collector |

Interactive Swagger docs: `http://localhost:8000/docs`

---

## 8. Data Accuracy & Limitations

**Ground-truth approximation** — Since the LTA API only provides estimates (not actual arrival times), true delay is approximated as the drift between first and last API estimates for a given bus. This is accurate when API estimates converge to reality but may be noisy for buses that make irregular updates.

**API estimate latency** — The LTA API updates every ~30 seconds. Between updates, estimates may be stale. The AI model cannot correct for information not yet published.

**Cold-start period** — In the first 1–2 weeks, predictions rely heavily on synthetic data. The model may over- or under-predict for specific routes not well-represented in the synthetic baseline.

**Coverage** — Only monitored stops accumulate training data. Add high-traffic stops to the monitor list to improve model coverage:
```bash
curl -X POST http://localhost:8000/api/monitor/83139
```

---

## 9. Deployment

### Local
```bash
cd bus-ai-project/backend
../.venv/bin/python main.py
# → http://localhost:8000
```

### Production (Ubuntu + nginx)
```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Run with uvicorn
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --workers 2

# 3. nginx reverse proxy with HTTPS (certbot)
```

### Docker
```bash
docker build -t sg-bus-ai .
docker run -p 8000:8000 -e LTA_API_KEY=xxx sg-bus-ai
```

### PaaS (Render / Railway)
Set start command: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
Add `LTA_API_KEY` as an environment variable.
Switch `DATABASE_URL` to a managed PostgreSQL for persistence.

---

## 10. File Structure

```
bus-ai-project/
├── backend/
│   ├── main.py              App entry point, lifespan, static serving
│   ├── api_routes.py        All /api/* endpoints
│   ├── ml_model.py          BusDelayModel (GBR wrapper)
│   ├── data_collector.py    Async LTA polling loop
│   ├── database.py          SQLAlchemy models + session helpers
│   └── config.py            Env-var configuration
├── frontend/
│   ├── index.html           Single-page UI (Search + Favourites tabs)
│   ├── styles.css           Mobile-first stylesheet
│   └── app.js               Vanilla JS (no build step)
├── database/
│   └── schema.sql           Schema documentation
├── models/                  Saved ML model (auto-created)
├── requirements.txt
├── .env                     Secrets (gitignored)
├── .env.example             Template
├── README.md                Setup & usage guide
└── REPORT.md                This document
```

---

*End of report.*
