# SG Bus AI — Real-time Arrivals & Predictions

A full-stack web application that shows real-time Singapore bus arrivals from the
LTA Datamall API and augments each arrival with an **AI-predicted adjustment**
computed by a Gradient Boosting model trained on historical delay patterns.

---

## How the AI prediction works

```
LTA API estimate  +  model_adjustment  =  AI predicted arrival
```

The model predicts *how many seconds* the next bus will arrive earlier (−) or
later (+) than the API claims, based on:

| Feature | Why |
|---|---|
| `hour_sin / hour_cos` | Cyclical time-of-day (midnight wraps to 1 am) |
| `dow_sin / dow_cos` | Cyclical day-of-week |
| `is_peak` | Mon–Fri 7–9 am or 5–7 pm flag |
| `is_weekend` | Sat/Sun flag |
| `load_code` | Bus crowding level (SEA/SDA/LSD) |
| `type_code` | Single-deck / double-deck / bendy |
| `service_hash` | Stable numeric proxy for service number |
| `stop_hash` | Stable numeric proxy for stop code |

**Ground-truth derivation** — the background collector tracks each bus across
successive API polls. When it disappears (arrived), we compute:
`delay = last_estimate − first_estimate`. These rows continuously retrain the
model (default: hourly).

**Bootstrap** — on first run (no data), the model trains on ~5 000 synthetic
rows encoding known SG patterns (peak-hour congestion, late-night reliability,
etc.). Real data is blended in with 3× weight as it accumulates.

---

## Project structure

```
bus-ai-project/
├── backend/
│   ├── main.py            FastAPI app; startup + static file serving
│   ├── api_routes.py      /api/* endpoints
│   ├── ml_model.py        GradientBoostingRegressor wrapper
│   ├── data_collector.py  Async background LTA API poller
│   ├── database.py        SQLAlchemy models + session helpers
│   └── config.py          Env-var configuration
├── frontend/
│   ├── index.html         Single-page UI
│   ├── styles.css         Mobile-first stylesheet
│   └── app.js             Vanilla JS (no build step)
├── database/
│   └── schema.sql         Schema documentation
├── models/                Saved ML model (auto-created)
├── requirements.txt
├── .env.example
└── README.md
```

---

## Local setup

### 1. Get an LTA API key

Register at <https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html>.
The key arrives by e-mail within 1–3 business days.

### 2. Clone / copy the project

```bash
cd bus-ai-project
```

### 3. Python environment

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 4. Environment variables

```bash
cp .env.example .env
# Edit .env and set LTA_API_KEY=your_key_here
```

### 5. Run

```bash
cd backend
python main.py
```

Open <http://localhost:8000> in a browser.

The app will:
1. Create `bus_data.db` (SQLite) automatically.
2. Train the ML model from synthetic data (takes ~5 s on first run; saved to `models/`).
3. Start the background collector for the stops in `MONITORED_STOPS`.

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `LTA_API_KEY` | *(required)* | Your LTA Datamall account key |
| `DATABASE_URL` | `sqlite:///./bus_data.db` | SQLAlchemy DB URL |
| `COLLECTION_INTERVAL_MINUTES` | `5` | How often to poll LTA API |
| `MODEL_RETRAIN_INTERVAL_HOURS` | `1` | How often to retrain the model |
| `MONITORED_STOPS` | `83139,83141,…` | Comma-separated stops to collect data for |

---

## API reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/arrivals/{stop_code}` | Real-time arrivals + AI predictions |
| `GET` | `/api/stats/{stop_code}` | Delay stats for charts (last 30 days) |
| `GET` | `/api/model/status` | Model metadata (MAE, training rows, etc.) |
| `POST` | `/api/model/retrain` | Trigger immediate model retrain |
| `GET` | `/api/monitor` | List monitored stops |
| `POST` | `/api/monitor/{stop_code}` | Add stop to collector |
| `DELETE` | `/api/monitor/{stop_code}` | Remove stop from collector |

Interactive docs: <http://localhost:8000/docs>

---

## Deploying to a server (e.g. Ubuntu VPS / Render / Railway)

### Option A — Bare server

```bash
# Install Python 3.11+
pip install -r requirements.txt
# Set env vars (LTA_API_KEY, DATABASE_URL, etc.)
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000
```

For production add a reverse proxy (nginx/caddy) with HTTPS.

### Option B — Docker

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -r requirements.txt
EXPOSE 8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```bash
docker build -t sg-bus-ai .
docker run -p 8000:8000 -e LTA_API_KEY=xxx sg-bus-ai
```

### Option C — Render / Railway (PaaS)

1. Push to GitHub.
2. Create a new Web Service; set **Start Command** to:
   `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
3. Add `LTA_API_KEY` as an environment variable in the dashboard.
4. For persistence, switch `DATABASE_URL` to a managed PostgreSQL URL.

---

## Using PostgreSQL instead of SQLite

```
DATABASE_URL=postgresql://user:password@host:5432/busai
```

The SQLAlchemy models are DB-agnostic; no code changes required.
Install the driver: `pip install psycopg2-binary`

---

## Improving model accuracy over time

The model improves automatically as the collector accumulates data:

1. **Day 1** — boots with synthetic data; predictions reflect general SG patterns.
2. **Week 1** — first real delay rows appear; model blends real + synthetic.
3. **Month 1+** — hundreds of ground-truth samples per monitored stop/service;
   MAE (mean-absolute-error) should drop below the synthetic baseline.

You can force an immediate retrain via the API:
```bash
curl -X POST http://localhost:8000/api/model/retrain
```

Or add more stops to the collector to gather data faster:
```bash
curl -X POST http://localhost:8000/api/monitor/84009
```
