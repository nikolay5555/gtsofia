#!/usr/bin/env python3
"""Generate the compact Sofia transport data model used by the site.

The output follows the five-file core model used by Dimitar5555:
  stops.json, routes.json, directions.json, trips.json, stop_times.json

Calendar, shapes and build metadata remain separate auxiliary files because
those concerns are not part of the core schedule join.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT_DIR = ROOT / "Scripts"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from calendar_builder import build_calendar_context
from directions_builder import (
    build_dimitar_directions,
    build_dimitar_stop_times,
    build_dimitar_trips,
    build_direction_records,
    build_reference_directions,
    merge_logical_trips,
    merge_partial_directions,
)
from routes_builder import build_routes
from osm_stops import fetch_osm_stops
from shapes_builder import load_shapes
from stops_builder import build_public_stops, build_stops
from transport_common import get_today, normalize
from transport_input import (
    download_gtfs,
    load_calendar_config,
    load_line_overrides,
    read_csv,
)
from trip_builder import build_active_source_trips, build_stop_times

DATA_DIR = ROOT / "data"
GTFS_DIR = ROOT / ".gtfs"
CALENDAR_CONFIG_FILE = ROOT / "config" / "calendar.json"
LINE_OVERRIDES_CONFIG_FILE = ROOT / "config" / "line-overrides.json"
OUTPUT_FILES = (
    "meta.json",
    "calendar.json",
    "routes.json",
    "stops.json",
    "directions.json",
    "trips.json",
    "stop_times.json",
    "shapes.json",
)


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, separators=(",", ":"))


def build_transport_data(routes_data, stops_data, trips_data, stop_times_data, calendar, calendar_dates, today, line_overrides, calendar_config, gtfs_dir: Path, osm_stops=None):
    service_day_types, calendar_result = build_calendar_context(
        calendar,
        calendar_dates,
        today,
        calendar_config=calendar_config,
    )
    output_stops, stops_by_id = build_stops(stops_data, osm_stops=osm_stops)
    source_trips = build_active_source_trips(trips_data, service_day_types)
    source_stop_times = build_stop_times(stop_times_data, source_trips)

    directions, logical_trips, logical_stop_times = build_reference_directions(
        source_trips,
        source_stop_times,
    )
    merge_partial_directions(routes_data, directions, logical_trips, logical_stop_times)
    merge_logical_trips(routes_data, logical_trips, logical_stop_times)

    active_route_ids = {normalize(trip["route_id"]) for trip in logical_trips if not trip.get("is_deleted")}
    routes_result = build_routes(routes_data, line_overrides, active_route_ids)
    direction_metadata = build_direction_records(
        routes_data,
        directions,
        logical_trips,
        stops_by_id,
    )
    directions_result = build_dimitar_directions(directions, direction_metadata)
    trips_result = build_dimitar_trips(logical_trips)
    stop_times_result = build_dimitar_stop_times(logical_stop_times)

    selected_shape_ids = {
        normalize(item.get("shape_id"))
        for items in direction_metadata.values()
        for item in items
        if normalize(item.get("shape_id"))
    }
    shapes_result = load_shapes(gtfs_dir, selected_shape_ids)

    used_stop_ids = {
        normalize(stop_id)
        for direction in directions_result
        for stop_id in direction.get("stops", [])
        if normalize(stop_id)
    }
    public_stops = build_public_stops(output_stops, used_stop_ids=used_stop_ids)
    result = {
        "meta": {
            "schemaVersion": 2,
            "updatedAt": today.isoformat(),
            "source": "CGM Sofia official GTFS",
            "counts": {
                "routes": len(routes_result),
                "stops": len(public_stops),
                "directions": len(directions_result),
                "trips": len(trips_result),
                "stop_times": len(stop_times_result),
                "shapes": len(shapes_result),
            },
        },
        "calendar": calendar_result,
        "routes": routes_result,
        "stops": public_stops,
        "directions": directions_result,
        "trips": trips_result,
        "stop_times": stop_times_result,
        "shapes": shapes_result,
    }
    return result


def write_transport_data(data) -> None:
    for filename in OUTPUT_FILES:
        key = filename.removesuffix(".json")
        write_json(DATA_DIR / filename, data[key])


def remove_legacy_transport_json() -> None:
    legacy = DATA_DIR / "transport.json"
    if legacy.exists():
        legacy.unlink()


def main():
    print("=== Sofia GTFS transport generator ===")
    download_gtfs(GTFS_DIR)
    try:
        routes_data = read_csv(GTFS_DIR, "routes.txt")
        stops_data = read_csv(GTFS_DIR, "stops.txt")
        trips_data = read_csv(GTFS_DIR, "trips.txt")
        stop_times_data = read_csv(GTFS_DIR, "stop_times.txt")
        calendar = read_csv(GTFS_DIR, "calendar.txt") if (GTFS_DIR / "calendar.txt").exists() else []
        calendar_dates = read_csv(GTFS_DIR, "calendar_dates.txt") if (GTFS_DIR / "calendar_dates.txt").exists() else []

        today = get_today()
        line_overrides = load_line_overrides(LINE_OVERRIDES_CONFIG_FILE)
        calendar_config = load_calendar_config(CALENDAR_CONFIG_FILE)

        print("Fetching OSM stops and station names (Dimitar-compatible merge)...")
        osm_stops = fetch_osm_stops()

        data = build_transport_data(
            routes_data,
            stops_data,
            trips_data,
            stop_times_data,
            calendar,
            calendar_dates,
            today,
            line_overrides,
            calendar_config,
            GTFS_DIR,
            osm_stops=osm_stops,
        )
        write_transport_data(data)
        remove_legacy_transport_json()

        print("=== Generation summary ===")
        for key, value in data["meta"]["counts"].items():
            print(f"{key}: {value}")
        print(f"Updated: {data['meta']['updatedAt']}")
    finally:
        if GTFS_DIR.exists():
            shutil.rmtree(GTFS_DIR)
        print("Temporary GTFS files removed.")


if __name__ == "__main__":
    main()
