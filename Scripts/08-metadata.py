#!/usr/bin/env python3

import hashlib
import json

from lib.common import DATA_DIR, get_today, write_json


GENERATED_FILES = (
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
)


def main():
    hashes = {}

    for filename in GENERATED_FILES:
        path = DATA_DIR / filename
        if not path.exists():
            raise FileNotFoundError(f"Missing generated data file: {path}")
        hashes[path.stem] = hashlib.sha256(path.read_bytes()).hexdigest()

    metadata = {
        "app_version": "gtsofia-data-model-v3",
        "model_version": 3,
        "retrieval_date": get_today().isoformat(),
        "source": "CGM Sofia official GTFS",
        "files": list(GENERATED_FILES),
        "hashes": hashes,
    }

    write_json(DATA_DIR / "metadata.json", metadata)
    write_json(
        DATA_DIR / "manifest.json",
        {
            "version": 3,
            "metadata": "metadata.json",
            "files": list(GENERATED_FILES) + [
                "metadata.json",
                "manifest.json",
            ],
        },
    )

    # Remove the old 68 MB compatibility artifact only after every split
    # file has been generated and hashed successfully.
    legacy = DATA_DIR / "transport.json"
    if legacy.exists():
        legacy.unlink()

    print(f"Metadata hashes: {len(hashes)}")


if __name__ == "__main__":
    main()
