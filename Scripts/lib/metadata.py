import hashlib

from .common import DATA_DIR, get_today, write_json


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


def write_metadata(source="CGM Sofia official GTFS"):
    hashes = {}
    for filename in GENERATED_FILES:
        path = DATA_DIR / filename
        if not path.exists():
            raise FileNotFoundError(f"Missing generated data file: {path}")
        hashes[path.stem] = hashlib.sha256(path.read_bytes()).hexdigest()

    metadata = {
        "app_version": "gtsofia-data-model-v4",
        "model_version": 4,
        "retrieval_date": get_today().isoformat(),
        "source": source,
        "files": list(GENERATED_FILES),
        "hashes": hashes,
        "route_hierarchy": {
            "type": ["metro", "tram", "trolley", "bus"],
            "subtype": ["temporary", "school", "night"],
        },
        "stop_names_source": "OpenStreetMap first, GTFS fallback",
    }
    write_json(DATA_DIR / "metadata.json", metadata)

    write_json(
        DATA_DIR / "manifest.json",
        {
            "version": 4,
            "metadata": "metadata.json",
            "files": list(GENERATED_FILES) + ["metadata.json", "manifest.json"],
        },
    )
    return metadata
