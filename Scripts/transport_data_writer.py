"""Write the generated transit dataset as small, independently cacheable files."""

import json
from pathlib import Path
from urllib.parse import quote


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(
            payload,
            handle,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    temporary.replace(path)


def _schedule_filename(route_id: str) -> str:
    # A GTFS route_id is arbitrary input. Percent-encode it so it cannot
    # escape data/schedules or introduce path separators.
    return quote(str(route_id), safe="-_.~") + ".json"


def write_transport_data(
    data_dir: Path,
    core: dict,
    calendar: dict,
    schedules: dict,
    shapes: dict,
) -> dict:
    """Write a core bundle plus lazy per-route schedules and optional shapes."""
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)

    calendar_filename = "calendar.json"
    shapes_filename = "shapes.json"
    schedules_dir_name = "schedules"
    schedules_dir = data_dir / schedules_dir_name
    schedules_dir.mkdir(parents=True, exist_ok=True)

    data_files = {
        "routes": "routes.json",
        "stops": "stops.json",
        "trips": "trips.json",
        "directions": "directions.json",
        "lineOverrides": "line-overrides.json",
    }
    for key, filename in data_files.items():
        _write_json(data_dir / filename, core.get(key, [] if key != "directions" else {}))

    _write_json(data_dir / calendar_filename, calendar)
    _write_json(data_dir / shapes_filename, shapes or {})

    schedule_files = {}
    valid_filenames = set()
    route_ids = sorted({
        str(route.get("route_id", "")).strip()
        for route in core.get("routes", [])
        if str(route.get("route_id", "")).strip()
    })

    for route_id in route_ids:
        filename = _schedule_filename(route_id)
        valid_filenames.add(filename)
        route_schedule = schedules.get(route_id, {})
        _write_json(schedules_dir / filename, route_schedule)
        schedule_files[route_id] = f"{schedules_dir_name}/{filename}"

    # Avoid leaving stale schedule files after routes disappear from the feed.
    for existing in schedules_dir.glob("*.json"):
        if existing.name not in valid_filenames:
            existing.unlink()
    for existing in schedules_dir.glob("*.json.tmp"):
        existing.unlink(missing_ok=True)

    manifest = {
        "schemaVersion": 3,
        "updatedAt": core.get("updatedAt", ""),
        "source": core.get("source", ""),
        "dataFiles": data_files,
        "calendarFile": calendar_filename,
        "shapesFile": shapes_filename,
        "schedulesDirectory": schedules_dir_name,
        "scheduleFiles": schedule_files,
    }
    _write_json(data_dir / "manifest.json", manifest)

    # Remove the old monolithic bundle so static-site visitors cannot
    # accidentally keep downloading it and future commits do not retain it.
    for obsolete_name in ("transport.json", "transport-core.json"):
        obsolete_file = data_dir / obsolete_name
        if obsolete_file.exists():
            obsolete_file.unlink()

    return manifest
