import os
from dotenv import load_dotenv

load_dotenv()

LTA_API_KEY: str = os.getenv("LTA_API_KEY", "")
LTA_BASE_URL: str = "https://datamall2.mytransport.sg/ltaodataservice"
LTA_ARRIVAL_ENDPOINT: str = f"{LTA_BASE_URL}/v3/BusArrival"
LTA_STOPS_ENDPOINT: str = f"{LTA_BASE_URL}/BusStops"

DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./bus_data.db")

COLLECTION_INTERVAL_MINUTES: int = int(os.getenv("COLLECTION_INTERVAL_MINUTES", "5"))
MODEL_RETRAIN_INTERVAL_HOURS: float = float(os.getenv("MODEL_RETRAIN_INTERVAL_HOURS", "0.5"))

# Extra stops sampled per collection cycle from the FULL stop directory
# (rotating cursor). Snapshot-only, no ground-truth tracking. 0 disables.
# At the default 20 stops / 5 min, all ~5,000 SG stops are sampled ~1x/day
# using ~6,000 LTA API calls/day.
ROTATION_BATCH_SIZE: int = int(os.getenv("ROTATION_BATCH_SIZE", "20"))

# Bus stops actively polled by the background collector
DEFAULT_MONITORED_STOPS: list[str] = [
    s.strip()
    for s in os.getenv("MONITORED_STOPS", "").split(",")
    if s.strip()
]

MODEL_PATH: str = os.path.join(os.path.dirname(__file__), "..", "models", "delay_model.joblib")
