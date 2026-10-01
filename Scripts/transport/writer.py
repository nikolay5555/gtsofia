"""Write transport data as small independently cacheable JSON parts."""

import json
from pathlib import Path


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, separators=(",", ":"))


def write_transport_parts(
    data_dir,
    *,
    updated_at,
    source,
    line_overrides,
    calendar,
    routes,
    stops,
    trips,
    directions,
    shapes,
    schedules,
    normalized,
    normalization,
    osm_stops,
):
    data_dir.mkdir(parents=True, exist_ok=True)

    _write_json(data_dir / "calendar.json", calendar)
    _write_json(data_dir / "routes.json", routes)
    _write_json(data_dir / "stops.json", stops)
    _write_json(data_dir / "trips.json", trips)
    _write_json(data_dir / "directions.json", directions)
    _write_json(data_dir / "shapes.json", shapes)
    _write_json(data_dir / "schedules.json", schedules)

    normalized_dir = data_dir / "normalized"
    _write_json(normalized_dir / "stops.json", normalized["stops"])
    _write_json(normalized_dir / "routes.json", normalized["routes"])
    _write_json(normalized_dir / "directions.json", normalized["directions"])
    _write_json(normalized_dir / "trips.json", normalized["trips"])
    _write_json(normalized_dir / "stop_times.json", normalized["stop_times"])

    osm_dir = data_dir / "osm"
    _write_json(osm_dir / "stops.json", list(osm_stops.values()))

    manifest = {
        "version": 2,
        "updatedAt": updated_at,
        "source": source,
        "lineOverrides": line_overrides,
        "normalization": normalization,
        "files": {
            "calendar": "calendar.json",
            "routes": "routes.json",
            "stops": "stops.json",
            "trips": "trips.json",
            "directions": "directions.json",
            "shapes": "shapes.json",
            "schedules": "schedules.json",
            "normalized": {
                "stops": "normalized/stops.json",
                "routes": "normalized/routes.json",
                "directions": "normalized/directions.json",
                "trips": "normalized/trips.json",
                "stop_times": "normalized/stop_times.json",
            },
        },
    }
    _write_json(data_dir / "transport.json", manifest)
    return manifest
