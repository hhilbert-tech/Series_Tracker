"""Paths and environment. Secrets (HARDCOVER_TOKEN, SMTP_*) are read from env only."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("TRACKER_DB", ROOT / "data" / "tracker.db"))
COVERS_DIR = Path(os.environ.get("TRACKER_COVERS", ROOT / "data" / "covers"))


def base_url() -> str:
    return os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
