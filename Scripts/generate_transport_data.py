#!/usr/bin/env python3
"""Generate split, compact transport data files from CGM GTFS and OSM."""
import json
import shutil
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from transport_data.common import (
    DATA_DIR, GTFS_DIR, get_today, download_gtfs, read_csv,
    load_line_overrides, normalize, write_json,
)
from transport_data.calendar import build_calendar_context, load_calendar_config
from transport_data.stops import build_stops, fetch_osm_stop_names
from transport_data.trips import build_trips, build_stop_times
from transport_data.directions import (
    build_reference_directions, merge_partial_directions,
    merge_logical_trips, build_output_directions,
)
from transport_data.schedules import build_schedules
from transport_data.shapes import load_shapes


def main():
    print("=== GTSofia transport data generator ===")
    download_gtfs()
    try:
        routes_data = read_csv("routes.txt")
        stops_data = read_csv("stops.txt")
        trips_data = read_csv("trips.txt")
        stop_times_data = read_csv("stop_times.txt")
        calendar = read_csv("calendar.txt") if (GTFS_DIR / "calendar.txt").exists() else []
        calendar_dates = read_csv("calendar_dates.txt") if (GTFS_DIR / "calendar_dates.txt").exists() else []

        today = get_today()
        line_overrides = load_line_overrides()
        calendar_config = load_calendar_config()
        print(f"Service reference date: {today}")
        service_day_types, calendar_result = build_calendar_context(
            calendar,
            calendar_dates,
            today,
            calendar_config=calendar_config,
        )

        osm_stop_names = fetch_osm_stop_names()
        output_stops, stops_by_id = build_stops(stops_data, osm_stop_names)

        trips_by_id = build_trips(trips_data, service_day_types)
        stop_times_by_trip = build_stop_times(stop_times_data, trips_by_id)
        print(f"Active trips: {len(trips_by_id)}")
        print(f"Trips with stop times: {len(stop_times_by_trip)}")

        directions, logical_trips, logical_stop_times = build_reference_directions(
            trips_by_id,
            stop_times_by_trip,
        )
        print(f"Initial directions: {len(directions)}")
        merge_partial_directions(routes_data, directions, logical_trips, logical_stop_times)
        print(f"Directions after partial merge: {len(directions)}")
        merge_logical_trips(routes_data, logical_trips, logical_stop_times)
        print(f"Logical trips after merge: {len(logical_trips)}")

        directions_result = build_output_directions(
            routes_data,
            directions,
            logical_trips,
            trips_by_id,
            stop_times_by_trip,
            stops_by_id,
        )
        schedules_result = build_schedules(
            directions_result,
            logical_trips,
            logical_stop_times,
        )
        published_route_ids = set(schedules_result)
        published_routes = [
            dict(row) for row in routes_data
            if normalize(row.get("route_id")) in published_route_ids
        ]

        selected_shape_ids = {
            normalize(direction.get("shape_id"))
            for route_directions in directions_result.values()
            for direction in route_directions.values()
            if normalize(direction.get("shape_id"))
        }
        shapes_result = load_shapes(selected_shape_ids)

        # Like the reference project's 05-filter-stops.js, retain only stops
        # used by a published direction and keep one best record per stop ID.
        used_stop_ids = {
            normalize(stop.get("stop_id"))
            for route_directions in directions_result.values()
            for direction in route_directions.values()
            for stop in direction.get("stops", [])
            if normalize(stop.get("stop_id"))
        }
        output_stops = [
            stop for stop_id, stop in stops_by_id.items()
            if stop_id in used_stop_ids
        ]

        # The runtime needs metadata for trips represented in the generated
        # weekday/weekend schedules, not every inactive trip in the source feed.
        trip_output_fields = (
            "trip_id", "route_id", "service_id",
            "trip_headsign", "direction_id", "shape_id",
        )
        active_trips = [
            {
                field: normalize(row.get(field))
                for field in trip_output_fields
                if normalize(row.get(field))
            }
            for row in trips_data
            if normalize(row.get("service_id")) in service_day_types
        ]

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        files = {
            "metadata.json": {
                "updatedAt": today.isoformat(),
                "source": "CGM Sofia official GTFS + OpenStreetMap stop names",
                "formatVersion": 2,
                "counts": {
                    "routes": len(published_routes),
                    "stops": len(output_stops),
                    "trips": len(active_trips),
                    "directions": sum(len(value) for value in directions_result.values()),
                    "shapes": len(shapes_result),
                },
            },
            "line-overrides.json": line_overrides,
            "calendar.json": calendar_result,
            "routes.json": published_routes,
            "stops.json": output_stops,
            "trips.json": active_trips,
            "directions.json": directions_result,
            "shapes.json": shapes_result,
            "schedules.json": schedules_result,
        }
        for filename, payload in files.items():
            write_json(DATA_DIR / filename, payload)

        legacy_file = DATA_DIR / "transport.json"
        if legacy_file.exists():
            legacy_file.unlink()

        print("\n=== Generation summary ===")
        for filename in files:
            print(f"{filename}: {len((DATA_DIR / filename).read_bytes()) / 1024 / 1024:.2f} MiB")
        print(f"Stops retained: {len(output_stops)} / {len(stops_data)} GTFS records")
        osm_names_applied = sum(
            1 for stop in output_stops
            if normalize(osm_stop_names.get(normalize(stop.get("stop_id"))))
        )
        print(f"OSM names applied: {osm_names_applied} / {len(output_stops)} retained stops")
        print(f"Written split data files in {DATA_DIR}")
    finally:
        if GTFS_DIR.exists():
            shutil.rmtree(GTFS_DIR)
        print("Temporary GTFS files removed.")


if __name__ == "__main__":
    main()
