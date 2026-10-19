#!/usr/bin/env python3
"""Build the static GTSofia transport data from CGM GTFS and OSM.

The entry point coordinates focused pipeline modules. Generated data is
written into small, purpose-specific JSON files instead of one large blob.
"""

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import (  # noqa: E402 - sys.path is configured above
    DATA_DIR, GTFS_DIR, ROOT, get_today, load_line_overrides, normalize,
)
from lib.gtfs import download_gtfs, read_csv  # noqa: E402
from lib.calendar import build_calendar_context, load_calendar_config  # noqa: E402
from lib.stops import build_stops  # noqa: E402
from lib.trips import build_trips, build_stop_times  # noqa: E402
from lib.directions import (  # noqa: E402
    build_reference_directions, merge_partial_directions, merge_logical_trips,
    build_output_directions, build_schedules,
)

OUTPUT_FILES = {
    "metadata": DATA_DIR / "metadata.json",
    "calendar": DATA_DIR / "calendar.json",
    "calendar_exceptions": DATA_DIR / "calendar-exceptions.json",
    "routes": DATA_DIR / "routes.json",
    "stops": DATA_DIR / "stops.json",
    "trips": DATA_DIR / "trips.json",
    "directions": DATA_DIR / "directions.json",
    "shapes": DATA_DIR / "shapes.json",
    "schedules": DATA_DIR / "schedules.json",
}

def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, separators=(",", ":"))
        file.write("\n")
    temporary.replace(path)

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
        print(f"Service reference date: {today}")

        service_day_types, calendar_result = build_calendar_context(
            calendar, calendar_dates, today, calendar_config=load_calendar_config()
        )
        calendar_exceptions = {"exceptionsByDate": calendar_result.pop("exceptionsByDate", {})}
        # The file is deliberately separate: large GTFS exception sets are
        # more compact grouped by service date than serialized row-by-row.
        output_stops, stops_by_id = build_stops(stops_data)
        trips_by_id = build_trips(trips_data, service_day_types)
        stop_times_by_trip = build_stop_times(stop_times_data, trips_by_id)

        print(f"Active trips: {len(trips_by_id)}")
        print(f"Trips with stop times: {len(stop_times_by_trip)}")

        directions, logical_trips, logical_stop_times = build_reference_directions(
            trips_by_id, stop_times_by_trip
        )
        print(f"Initial directions: {len(directions)}")
        merge_partial_directions(routes_data, directions, logical_trips, logical_stop_times)
        print(f"Directions after partial merge: {len(directions)}")
        merge_logical_trips(routes_data, logical_trips, logical_stop_times)
        print(f"Logical trips after merge: {len(logical_trips)}")

        directions_result = build_output_directions(
            routes_data, directions, logical_trips, trips_by_id, stop_times_by_trip, stops_by_id
        )
        schedules_result = build_schedules(directions_result, logical_trips, logical_stop_times)

        # Geometry remains a separate optional artifact. The current site uses
        # shape IDs for trip matching but does not draw the shape coordinates.
        # Keep generating shapes.json for consumers that need route geometry.
        from lib.shapes import load_shapes
        selected_shape_ids = {
            normalize(direction.get("shape_id"))
            for route_directions in directions_result.values()
            for direction in route_directions.values()
            if normalize(direction.get("shape_id"))
        }
        shapes_result = load_shapes(selected_shape_ids)

        outputs = {
            "metadata": {
                "updatedAt": today.isoformat(),
                "source": "CGM Sofia official GTFS + OpenStreetMap stop names",
                "lineOverrides": line_overrides,
            },
            "calendar": calendar_result,
            "calendar_exceptions": calendar_exceptions,
            "routes": [dict(row) for row in routes_data],
            "stops": output_stops,
            # Only retain trips whose service is active in the current/future
            # calendar window, using the normalized fields consumed by the site.
            "trips": list(trips_by_id.values()),
            "directions": directions_result,
            "shapes": shapes_result,
            "schedules": schedules_result,
        }
        for name, value in outputs.items():
            write_json(OUTPUT_FILES[name], value)

        # Remove the deprecated single-file export after every replacement is
        # written successfully. The browser loader still exposes the legacy
        # in-memory `window.transportData` object to existing app code.
        legacy_file = DATA_DIR / "transport.json"
        if legacy_file.exists():
            legacy_file.unlink()

        print("\n=== Generation summary ===")
        print(f"Routes: {len(routes_data)}")
        print(f"Stops: {len(output_stops)}")
        print(f"Directions: {sum(len(value) for value in directions_result.values())}")
        print(f"Schedule routes: {len(schedules_result)}")
        print(f"Shapes: {len(shapes_result)}")
        print("\nGenerated files:")
        for path in OUTPUT_FILES.values():
            print(f" - {path.relative_to(ROOT)} ({path.stat().st_size / 1024 / 1024:.2f} MB)")

    finally:
        # The feed archive is temporary; downloaded CSVs should not be part of
        # the published project. Keep generated JSON even when cleanup fails.
        if GTFS_DIR.exists():
            import shutil
            shutil.rmtree(GTFS_DIR, ignore_errors=True)

if __name__ == "__main__":
    main()
