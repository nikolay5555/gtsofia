"""Validate generated browser datasets before they are committed/deployed."""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DATASET_KEYS = ("calendar", "routes", "stops", "trips", "directions", "schedules")
WEEKDAY_NAMES = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


class ValidationError(Exception):
    pass


def fail(message: str) -> None:
    raise ValidationError(message)


def read_json(name: str):
    path = DATA / name
    if not path.is_file():
        fail(f"Missing required file: data/{name}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"Invalid JSON in data/{name}: {error}")


def validate_calendar(calendar: dict) -> None:
    reference = calendar.get("referenceDate")
    end = calendar.get("endDate")
    try:
        start_date = date.fromisoformat(reference)
        end_date = date.fromisoformat(end)
    except (TypeError, ValueError):
        fail("calendar.json must contain ISO referenceDate and endDate")
    if end_date < start_date:
        fail("calendar endDate is before referenceDate")

    baselines = calendar.get("serviceIdsByWeekday")
    deltas = calendar.get("serviceIdOverridesByDate")
    if not isinstance(baselines, dict) or set(baselines) != set(WEEKDAY_NAMES):
        fail("calendar.serviceIdsByWeekday must define all seven weekdays")
    if not isinstance(deltas, dict):
        fail("calendar.serviceIdOverridesByDate must be an object")

    normalized_baselines = {}
    for weekday in WEEKDAY_NAMES:
        values = baselines[weekday]
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            fail(f"Invalid service-ID baseline for {weekday}")
        if len(values) != len(set(values)):
            fail(f"Duplicate service ID in weekday baseline {weekday}")
        normalized_baselines[weekday] = set(values)

    expected_dates = set()
    current = start_date
    while current <= end_date:
        expected_dates.add(current.isoformat())
        current += timedelta(days=1)

    date_types = calendar.get("dateTypes", {})
    if set(date_types) != expected_dates:
        fail("calendar.dateTypes does not exactly cover referenceDate..endDate")

    for date_key, delta in deltas.items():
        if date_key not in expected_dates:
            fail(f"Calendar override date is outside coverage: {date_key}")
        if not isinstance(delta, dict):
            fail(f"Invalid calendar delta for {date_key}")
        additions, removals = delta.get("add", []), delta.get("remove", [])
        if not isinstance(additions, list) or not isinstance(removals, list):
            fail(f"Calendar add/remove must be arrays for {date_key}")
        if set(additions) & set(removals):
            fail(f"Calendar delta both adds and removes a service on {date_key}")
        current_services = normalized_baselines[WEEKDAY_NAMES[date.fromisoformat(date_key).weekday()]]
        # Verify both membership directions without building a huge date index.
        current_services = set(current_services)
        current_services.difference_update(removals)
        current_services.update(additions)
        if any(not isinstance(value, str) for value in current_services):
            fail(f"Invalid service IDs in calendar override {date_key}")


def validate() -> list[str]:
    metadata = read_json("metadata.json")
    loaded = {name: read_json(f"{name}.json") for name in DATASET_KEYS}
    if not isinstance(metadata, dict) or not isinstance(metadata.get("hashes"), dict):
        fail("metadata.json is missing the hashes manifest")

    expected_hash_names = set(DATASET_KEYS)
    if set(metadata["hashes"]) != expected_hash_names:
        fail("metadata hashes do not match the generated dataset files")

    for name in DATASET_KEYS:
        content = (DATA / f"{name}.json").read_bytes()
        actual_hash = hashlib.sha256(content).hexdigest()
        if metadata["hashes"].get(name) != actual_hash:
            fail(f"SHA-256 mismatch for data/{name}.json")

    if (DATA / "shapes.json").exists():
        fail("data/shapes.json is no longer used and should not be published")

    calendar = loaded["calendar"]
    routes = loaded["routes"]
    stops = loaded["stops"]
    trips = loaded["trips"]
    directions = loaded["directions"]
    schedules = loaded["schedules"]

    if not isinstance(calendar, dict):
        fail("calendar.json must be an object")
    validate_calendar(calendar)
    for key, value in (("routes", routes), ("stops", stops), ("trips", trips)):
        if not isinstance(value, list) or not value:
            fail(f"{key}.json must be a non-empty array")
    for key, value in (("directions", directions), ("schedules", schedules)):
        if not isinstance(value, dict) or not value:
            fail(f"{key}.json must be a non-empty object")

    route_ids = [str(row.get("route_id", "")).strip() for row in routes]
    stop_ids = [str(row.get("stop_id", "")).strip() for row in stops]
    if not all(route_ids) or len(route_ids) != len(set(route_ids)):
        fail("routes.json has blank or duplicate route_id values")
    if not all(stop_ids):
        fail("stops.json has blank stop_id values")
    # CGM includes repeated stop IDs for some platform/variant records; only
    # require IDs to be present, as the application intentionally normalizes
    # these records by ID at lookup time.
    route_id_set, stop_id_set = set(route_ids), set(stop_ids)

    trip_ids = set()
    for trip in trips:
        trip_id = str(trip.get("trip_id", "")).strip()
        route_id = str(trip.get("route_id", "")).strip()
        if not trip_id or not route_id:
            fail("trips.json contains a trip without trip_id/route_id")
        if route_id not in route_id_set:
            fail(f"Trip {trip_id} references unknown route {route_id}")
        trip_ids.add(trip_id)

    for route_id, route_directions in directions.items():
        if route_id not in route_id_set:
            fail(f"directions.json has unknown route {route_id}")
        if not isinstance(route_directions, dict):
            fail(f"Directions for route {route_id} must be an object")
        for direction_key, direction in route_directions.items():
            pattern = direction.get("pattern", [])
            if not isinstance(pattern, list):
                fail(f"Pattern {route_id}/{direction_key} must be an array")
            unknown = set(map(str, pattern)) - stop_id_set
            if unknown:
                fail(f"Direction {route_id}/{direction_key} has unknown stop IDs: {sorted(unknown)[:3]}")

    for route_id, route_schedules in schedules.items():
        if route_id not in route_id_set:
            fail(f"schedules.json has unknown route {route_id}")
        if route_id not in directions:
            fail(f"Schedules for {route_id} have no directions metadata")
        for direction_key, day_groups in route_schedules.items():
            if direction_key not in directions[route_id]:
                fail(f"Schedule {route_id}/{direction_key} has no direction metadata")
            if not isinstance(day_groups, dict):
                fail(f"Schedule day groups for {route_id}/{direction_key} must be an object")
            for day_type in ("weekday", "weekend"):
                rows = day_groups.get(day_type, [])
                if not isinstance(rows, list):
                    fail(f"Schedule {route_id}/{direction_key}/{day_type} must be an array")
                for row in rows:
                    times = row.get("times", [])
                    sequences = row.get("stop_sequences", [])
                    if not isinstance(times, list) or not isinstance(sequences, list) or len(times) != len(sequences):
                        fail(f"Mismatched times/stop_sequences in {route_id}/{direction_key}/{day_type}")
                    if not times:
                        fail(f"Empty trip schedule in {route_id}/{direction_key}/{day_type}")

    if not metadata.get("updatedAt") or not metadata.get("source"):
        fail("metadata.json is missing updatedAt/source")

    return [
        f"Routes: {len(routes)}",
        f"Stops: {len(stops)}",
        f"Trips: {len(trips)}",
        f"Directions: {sum(len(value) for value in directions.values())}",
        f"Schedule routes: {len(schedules)}",
        f"Calendar dates: {len(calendar.get('dateTypes', {}))}",
        "Dataset hashes and references: OK",
    ]


if __name__ == "__main__":
    try:
        for line in validate():
            print(line)
    except ValidationError as error:
        print(f"Transport data validation failed: {error}", file=sys.stderr)
        sys.exit(1)
