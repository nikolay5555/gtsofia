"""High-level generator pipeline.

This module intentionally contains orchestration only. Data transformation lives
in the stage modules so each part can be tested independently.
"""

import shutil

from .calendar import build_calendar_context, load_calendar_config, apply_direction_overrides
from .config import GTFS_DIR, OUTPUT_MANIFEST_FILE, load_line_overrides
from .directions import (
    build_output_directions,
    build_reference_directions,
    merge_logical_trips,
    merge_partial_directions,
)
from .gtfs import download_gtfs, read_csv
from .output import (
    build_result,
    print_direction_diagnostics,
    print_generation_summary,
    write_public_data,
)
from .shapes import load_shapes
from .stops import (
    build_stop_index,
    build_stops,
    fetch_osm_stops,
    merge_osm_stop_names,
)
from .trips import build_stop_times, build_trips
from .utils import get_today, normalize
from .schedules import build_schedules


def load_gtfs_tables():
    """Load the GTFS tables needed by this generator."""
    return {
        "routes": read_csv("routes.txt"),
        "stops": read_csv("stops.txt"),
        "trips": read_csv("trips.txt"),
        "stop_times": read_csv("stop_times.txt"),
        "calendar": (
            read_csv("calendar.txt")
            if (GTFS_DIR / "calendar.txt").exists()
            else []
        ),
        "calendar_dates": (
            read_csv("calendar_dates.txt")
            if (GTFS_DIR / "calendar_dates.txt").exists()
            else []
        ),
    }


def generate():
    """Run one full GTFS generation cycle."""
    print("=== Sofia GTFS transport generator ===")
    download_gtfs()

    try:
        tables = load_gtfs_tables()
        routes_data = tables["routes"]
        stops_data = tables["stops"]
        trips_data = tables["trips"]
        stop_times_data = tables["stop_times"]
        calendar = tables["calendar"]
        calendar_dates = tables["calendar_dates"]

        today = get_today()
        line_overrides = load_line_overrides()

        print(f"Service reference date: {today}")

        calendar_config = load_calendar_config()
        service_day_types, calendar_result = build_calendar_context(
            calendar,
            calendar_dates,
            today,
            calendar_config=calendar_config,
        )

        output_stops, stops_by_id = build_stops(stops_data)

        print("")
        print("Fetching OSM stop names...")
        osm_stops = fetch_osm_stops()
        output_stops = merge_osm_stop_names(output_stops, osm_stops)
        stops_by_id = build_stop_index(output_stops)
        print(f"Stops after OSM merge: {len(output_stops)}")

        trips_by_id = build_trips(trips_data, service_day_types)
        stop_times_by_trip = build_stop_times(stop_times_data, trips_by_id)

        print(f"Active trips: {len(trips_by_id)}")
        print(f"Trips with stop times: {len(stop_times_by_trip)}")

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

        merge_logical_trips(
            routes_data,
            logical_trips,
            logical_stop_times,
        )
        print(f"Logical trips after merge: {len(logical_trips)}")

        directions_result = build_output_directions(
            routes_data,
            directions,
            logical_trips,
            trips_by_id,
            stop_times_by_trip,
            stops_by_id,
        )

        directions_result, applied_direction_overrides = apply_direction_overrides(
            directions_result,
            calendar_config,
            today,
        )

        if applied_direction_overrides:
            print(
                "Applied direction overrides: "
                f"{len(applied_direction_overrides)}"
            )

        schedules_result = build_schedules(
            directions_result,
            logical_trips,
            logical_stop_times,
        )

        selected_shape_ids = {
            normalize(direction.get("shape_id"))
            for route_directions in directions_result.values()
            for direction in route_directions.values()
            if normalize(direction.get("shape_id"))
        }
        shapes_result = load_shapes(selected_shape_ids)

        calendar_result["appliedDirectionOverrides"] = applied_direction_overrides

        result = build_result(
            today=today,
            line_overrides=line_overrides,
            calendar_result=calendar_result,
            routes_data=routes_data,
            output_stops=output_stops,
            trips_data=trips_data,
            directions_result=directions_result,
            shapes_result=shapes_result,
            schedules_result=schedules_result,
        )

        written = write_public_data(result)
        print_generation_summary(
            routes_data=routes_data,
            output_stops=output_stops,
            directions_result=directions_result,
            schedules_result=schedules_result,
            shapes_result=shapes_result,
            written=written,
            output_manifest_file=OUTPUT_MANIFEST_FILE,
        )
        print_direction_diagnostics(
            routes_data=routes_data,
            directions_result=directions_result,
            schedules_result=schedules_result,
            normalize_fn=normalize,
        )
        return result

    finally:
        if GTFS_DIR.exists():
            shutil.rmtree(GTFS_DIR)
        print("Temporary GTFS files removed.")
