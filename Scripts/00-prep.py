#!/usr/bin/env python3

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
GTFS_DIR = ROOT / ".gtfs"

GENERATED_FILES = {
    "routes.json",
    "stops.json",
    "trips.json",
    "directions.json",
    "stop_times.json",
    "active_service_ids.json",
    "shapes.json",
    "realtime-trips.json",
    "calendar.json",
    "line-overrides.json",
    "metadata.json",
    "manifest.json",
    "transport.json",
}

def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    for filename in GENERATED_FILES:
        path = DATA_DIR / filename
        if path.exists():
            path.unlink()

    if GTFS_DIR.exists():
        shutil.rmtree(GTFS_DIR)

    print("Prepared transport data directories.")

if __name__ == "__main__":
    main()
