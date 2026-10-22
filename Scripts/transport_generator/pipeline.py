"""End-to-end generation of split, browser-facing transport data files."""

import json
import shutil

from .calendar import build_calendar_context, load_calendar_config
from .common import (
    DATA_DIR,
    GTFS_DIR,
    get_today,
    load_line_overrides,
    normalize,
    read_csv,
    iter_csv,
    download_gtfs,
)
from .direction_inference import build_reference_directions
from .direction_merging import merge_logical_trips, merge_partial_directions
from .direction_output import build_output_directions
from .schedules import build_schedules
from .shapes import load_shapes
from .stops import build_stops
from .trips import build_stop_times, build_trips


def write_json(path, value):
    """Write compact UTF-8 JSON, ending with a newline for clean diffs."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")

    with temporary.open("w", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, separators=(",", ":"))
        file.write("\n")

    temporary.replace(path)


def compact_calendar(calendar_result):
    """Only ship calendar information used by the current data coverage."""
    start_date = calendar_result["referenceDate"]
    end_date = calendar_result["endDate"]

    return {
        "referenceDate": start_date,
        "endDate": end_date,
        "coverageStartDate": start_date,
        "coverageEndDate": end_date,
        "serviceIdsByDate": calendar_result["serviceIdsByDate"],
        "dateTypes": calendar_result["dateTypes"],
        "config": calendar_result["config"],
    }


def main():
    print("=== Sofia GTFS transport generator ===")
    download_gtfs()

    try:
        routes_data = read_csv("routes.txt")
        stops_data = read_csv("stops.txt")
        trips_data = read_csv("trips.txt")
        stop_times_data = read_csv("stop_times.txt")

        calendar = (
            read_csv("calendar.txt")
            if (GTFS_DIR / "calendar.txt").exists()
            else []
        )
        calendar_dates = (
            iter_csv("calendar_dates.txt")
            if (GTFS_DIR / "calendar_dates.txt").exists()
            else []
        )

        today = get_today()
        # Validate the hand-maintained override config before publishing data.
        load_line_overrides()
        calendar_config = load_calendar_config()

        print(f"Service reference date: {today}")
        service_day_types, calendar_result = build_calendar_context(
            calendar,
            calendar_dates,
            today,
            calendar_config=calendar_config,
        )

        output_stops, stops_by_id = build_stops(stops_data)
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

        # Separate files reduce the payload for any single request and let
        # browsers cache unchanged parts independently. trips.json includes
        # only trips that have services during this generated date window.
        outputs = {
            "metadata.json": {
                "schemaVersion": 2,
                "updatedAt": today.isoformat(),
                "source": "CGM Sofia official GTFS",
            },
            "calendar.json": compact_calendar(calendar_result),
            "routes.json": [dict(row) for row in routes_data],
            "stops.json": output_stops,
            "trips.json": list(trips_by_id.values()),
            "directions.json": directions_result,
            "shapes.json": shapes_result,
            "schedules.json": schedules_result,
        }

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        for filename, value in outputs.items():
            write_json(DATA_DIR / filename, value)

        # Remove the previous monolithic file only after all replacement files
        # were written successfully. Workflow commits this deletion with the
        # new files, so there is no deployment in a half-migrated state.
        legacy_file = DATA_DIR / "transport.json"
        if legacy_file.exists():
            legacy_file.unlink()

        print("\n=== Generation summary ===")
        print(f"Routes: {len(routes_data)}")
        print(f"Stops: {len(output_stops)}")
        print(f"Active trips: {len(trips_by_id)}")
        print(f"Directions: {sum(len(value) for value in directions_result.values())}")
        print(f"Schedule routes: {len(schedules_result)}")
        print(f"Shapes: {len(shapes_result)}")
        print(f"Split data files written: {len(outputs)}")
        print(f"Data directory: {DATA_DIR}")

        print("\n=== Direction diagnostics ===")
        for route in routes_data:
            route_id = normalize(route.get("route_id"))
            short_name = normalize(route.get("route_short_name"))
            route_directions = directions_result.get(route_id, {})
            if not route_directions:
                continue

            print(f"\n{short_name}:")
            for key, direction in route_directions.items():
                schedule = schedules_result.get(route_id, {}).get(key, {})
                print(
                    f"  {key}: {direction['headsign']} | "
                    f"stops={len(direction['stops'])} | "
                    f"weekday={len(schedule.get('weekday', []))} | "
                    f"weekend={len(schedule.get('weekend', []))}"
                )

    finally:
        if GTFS_DIR.exists():
            shutil.rmtree(GTFS_DIR)
        print("Temporary GTFS files removed.")
