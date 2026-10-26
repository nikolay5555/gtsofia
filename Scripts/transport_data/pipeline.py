"""Orchestrate the GTFS processing stages."""

import shutil

from .calendar import build_calendar_context, load_calendar_config
from .common import DATA_DIR, GTFS_DIR, get_today, load_line_overrides, normalize
from .direction_output import build_output_directions
from .directions_core import build_reference_directions
from .direction_merges import merge_logical_trips, merge_partial_directions
from .gtfs import download_gtfs, read_csv
from .output import write_output_files
from .schedules import build_schedules
from .shapes import load_shapes
from .stops import build_stops
from .trips import build_stop_times, build_trips


def main():
    print("=== Sofia GTFS transport generator ===")
    download_gtfs()

    try:
        # 00. Load the raw GTFS tables.
        routes_data = read_csv("routes.txt")
        stops_data = read_csv("stops.txt")
        trips_data = read_csv("trips.txt")
        stop_times_data = read_csv("stop_times.txt")
        calendar = read_csv("calendar.txt") if (GTFS_DIR / "calendar.txt").exists() else []
        calendar_dates = (
            read_csv("calendar_dates.txt")
            if (GTFS_DIR / "calendar_dates.txt").exists()
            else []
        )

        today = get_today()
        print(f"Service reference date: {today}")
        line_overrides = load_line_overrides()

        # 01. Calendar: resolve the active service IDs by date.
        service_day_types, calendar_result = build_calendar_context(
            calendar,
            calendar_dates,
            today,
            calendar_config=load_calendar_config(),
        )

        # 02. Stops.
        output_stops, stops_by_id = build_stops(stops_data)

        # 03. Trips and stop-time rows for services in the operational window.
        trips_by_id = build_trips(trips_data, service_day_types)
        stop_times_by_trip = build_stop_times(stop_times_data, trips_by_id)
        print(f"Active trips: {len(trips_by_id)}")
        print(f"Trips with stop times: {len(stop_times_by_trip)}")

        # 04. Directions, merging partial directions and logical trips.
        directions, logical_trips, logical_stop_times = build_reference_directions(
            trips_by_id,
            stop_times_by_trip,
        )
        print(f"Initial directions: {len(directions)}")
        merge_partial_directions(
            routes_data,
            directions,
            logical_trips,
            logical_stop_times,
        )
        print(f"Directions after partial merge: {len(directions)}")
        merge_logical_trips(routes_data, logical_trips, logical_stop_times)
        print(f"Logical trips after merge: {len(logical_trips)}")

        # 05. Build the public direction and schedule structures.
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

        # 06. Keep only shape geometry referenced by the public directions.
        selected_shape_ids = {
            normalize(direction.get("shape_id"))
            for route_directions in directions_result.values()
            for direction in route_directions.values()
            if normalize(direction.get("shape_id"))
        }
        shapes_result = load_shapes(selected_shape_ids)

        # 07. Serialize modular data files, preserving the old in-memory schema.
        result = {
            "updatedAt": today.isoformat(),
            "source": "CGM Sofia official GTFS",
            "lineOverrides": line_overrides,
            "calendar": calendar_result,
            "routes": [dict(row) for row in routes_data],
            "stops": output_stops,
            "trips": [dict(row) for row in trips_data],
            "directions": directions_result,
            "shapes": shapes_result,
            "schedules": schedules_result,
        }
        written_files = write_output_files(result)

        print("\n=== Generation summary ===")
        print(f"Routes: {len(routes_data)}")
        print(f"Stops: {len(output_stops)}")
        print(f"Directions: {sum(len(value) for value in directions_result.values())}")
        print(f"Schedule routes: {len(schedules_result)}")
        print(f"Shapes: {len(shapes_result)}")
        for path in written_files:
            print(f"Written: {path.relative_to(DATA_DIR.parent)}")

    finally:
        if GTFS_DIR.exists():
            shutil.rmtree(GTFS_DIR)
        print("Temporary GTFS files removed.")
