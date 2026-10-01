#!/usr/bin/env python3

"""Generate Sofia public-transport data from official GTFS plus OSM stops.

The orchestration stays deliberately small; domain logic lives in the
Scripts/transport package so each data source/model can be tested separately.
"""

import shutil
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from transport.calendar import build_calendar_context, load_calendar_config
from transport.directions import (
    build_output_directions,
    build_reference_directions,
    merge_logical_trips,
    merge_partial_directions,
)
from transport.gtfs import download_gtfs, read_csv
from transport.normalized import build_normalized_data
from transport.osm import fetch_osm_stops, merge_osm_stop_names
from transport.routes import normalize_route_record
from transport.schedules import build_schedules
from transport.settings import DATA_DIR, GTFS_DIR
from transport.stops import build_stop_index, build_stops
from transport.trips import build_stop_times, build_trips
from transport.utils import (
    get_today,
    normalize,
    normalize_route_ref,
    normalize_stop_code,
    normalize_stop_id,
    parse_date,
    parse_time,
    round_coordinate,
    transliterate,
)
from transport.writer import write_transport_parts
from transport.utils import load_line_overrides


def main():

    print(
        "=== Sofia GTFS transport generator ==="
    )

    download_gtfs()

    try:

        # --------------------------------------------------------
        # Read GTFS
        # --------------------------------------------------------

        routes_data = read_csv(
            "routes.txt"
        )

        stops_data = read_csv(
            "stops.txt"
        )

        trips_data = read_csv(
            "trips.txt"
        )

        stop_times_data = read_csv(
            "stop_times.txt"
        )

        calendar = (
            read_csv("calendar.txt")
            if (GTFS_DIR / "calendar.txt").exists()
            else []
        )

        calendar_dates = (
            read_csv("calendar_dates.txt")
            if (GTFS_DIR / "calendar_dates.txt").exists()
            else []
        )

        today = get_today()
        line_overrides = load_line_overrides()

        print(
            f"Service reference date: {today}"
        )

        # --------------------------------------------------------
        # Active services
        # --------------------------------------------------------

        calendar_config = load_calendar_config()

        (
            service_day_types,
            calendar_result
        ) = build_calendar_context(
            calendar,
            calendar_dates,
            today,
            calendar_config=calendar_config
        )

        # --------------------------------------------------------
        # GTFS stops
        # --------------------------------------------------------

        output_stops, stops_by_id = (
            build_stops(
                stops_data
            )
        )

        # --------------------------------------------------------
        # OSM stop metadata
        #
        # OSM is the canonical naming/metadata source, following the same
        # strategy as Dimitar5555. GTFS/SUMC remains the fallback and also
        # supplies stops that are absent from OSM.
        # --------------------------------------------------------

        print(
            ""
        )

        print(
            "Fetching OSM stop names..."
        )

        osm_stops = (
            fetch_osm_stops()
        )

        output_stops = (
            merge_osm_stop_names(
                output_stops,
                osm_stops
            )
        )

        # Rebuild the stop index after
        # updating names.
        stops_by_id = build_stop_index(
            output_stops
        )

        print(
            "Stops after OSM merge: "
            f"{len(output_stops)}"
        )

        # --------------------------------------------------------
        # Trips
        # --------------------------------------------------------

        trips_by_id = build_trips(
            trips_data,
            service_day_types
        )

        # --------------------------------------------------------
        # Stop times
        # --------------------------------------------------------

        stop_times_by_trip = (
            build_stop_times(
                stop_times_data,
                trips_by_id
            )
        )

        print(
            "Active trips: "
            f"{len(trips_by_id)}"
        )

        print(
            "Trips with stop times: "
            f"{len(stop_times_by_trip)}"
        )

        # --------------------------------------------------------
        # Directions
        # --------------------------------------------------------

        (
            directions,
            logical_trips,
            logical_stop_times
        ) = build_reference_directions(
            trips_by_id,
            stop_times_by_trip
        )

        print(
            "Initial directions: "
            f"{len(directions)}"
        )

        # --------------------------------------------------------
        # Partial directions
        # --------------------------------------------------------

        merge_partial_directions(
            routes_data,
            directions,
            logical_trips,
            logical_stop_times
        )

        print(
            "Directions after partial merge: "
            f"{len(directions)}"
        )

        # --------------------------------------------------------
        # Logical trips
        # --------------------------------------------------------

        merge_logical_trips(
            routes_data,
            logical_trips,
            logical_stop_times
        )

        print(
            "Logical trips after merge: "
            f"{len(logical_trips)}"
        )

        # --------------------------------------------------------
        # Output directions
        # --------------------------------------------------------

        directions_result = (
            build_output_directions(
                routes_data,
                directions,
                logical_trips,
                trips_by_id,
                stop_times_by_trip,
                stops_by_id
            )
        )

        # --------------------------------------------------------
        # Schedules
        # --------------------------------------------------------

        schedules_result = (
            build_schedules(
                directions_result,
                logical_trips,
                logical_stop_times
            )
        )

        # --------------------------------------------------------
        # Shapes
        # --------------------------------------------------------

        selected_shape_ids = set()

        for route_directions in (
            directions_result.values()
        ):

            for direction in (
                route_directions.values()
            ):

                shape_id = normalize(
                    direction.get(
                        "shape_id"
                    )
                )

                if shape_id:

                    selected_shape_ids.add(
                        shape_id
                    )

        shapes_result = load_shapes(
            selected_shape_ids
        )

        # --------------------------------------------------------
        # Final output
        # --------------------------------------------------------

        normalized_result = build_normalized_data(
            routes_data,
            output_stops,
            directions,
            logical_trips,
            logical_stop_times,
            directions_result,
            line_overrides,
        )

        normalization = {
            "route": "Dimitar5555-compatible route_ref/type/subtype normalization",
            "stops": "OSM-first names and stop metadata with GTFS/SUMC fallback",
            "stop_times": "minutes from midnight",
            "compatibility": "legacy frontend data model is preserved through split JSON parts",
        }

        write_transport_parts(
            DATA_DIR,
            updated_at=today.isoformat(),
            source="CGM Sofia official GTFS",
            line_overrides=line_overrides,
            calendar=calendar_result,
            routes=[
                {
                    **dict(row),
                    "normalized": normalize_route_record(row, line_overrides),
                }
                for row in routes_data
            ],
            stops=output_stops,
            trips=[dict(row) for row in trips_data],
            directions=directions_result,
            shapes=shapes_result,
            schedules=schedules_result,
            normalized=normalized_result,
            normalization=normalization,
            osm_stops=osm_stops,
        )

        print("")
        print("=== Data parts written ===")
        print("  data/transport.json (manifest)")
        print("  data/routes.json")
        print("  data/stops.json")
        print("  data/trips.json")
        print("  data/directions.json")
        print("  data/shapes.json")
        print("  data/schedules.json")
        print("  data/calendar.json")
        print("  data/normalized/*.json")
        print("  data/osm/stops.json")

        # --------------------------------------------------------
        # Diagnostics
        # --------------------------------------------------------

        print(
            ""
        )

        print(
            "=== Direction diagnostics ==="
        )

        for route in routes_data:

            route_id = normalize(
                route.get(
                    "route_id"
                )
            )

            short_name = normalize(
                route.get(
                    "route_short_name"
                )
            )

            route_directions = (
                directions_result.get(
                    route_id,
                    {}
                )
            )

            if not route_directions:
                continue

            print(
                f"\n{short_name}:"
            )

            for key, direction in (
                route_directions.items()
            ):

                schedule = (
                    schedules_result
                    .get(
                        route_id,
                        {}
                    )
                    .get(
                        key,
                        {}
                    )
                )

                print(
                    "  "
                    f"{key}: "
                    f"{direction['headsign']} | "
                    f"stops={len(direction['stops'])} | "
                    f"weekday={len(schedule.get('weekday', []))} | "
                    f"weekend={len(schedule.get('weekend', []))}"
                )

        print(
            ""
        )

        print("Written: data/transport.json + data/*.json")

    finally:

        if GTFS_DIR.exists():

            shutil.rmtree(
                GTFS_DIR
            )

        print(
            "Temporary GTFS files removed."
        )