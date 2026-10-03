#!/usr/bin/env python3

import json

from lib.common import DATA_DIR, write_json
from lib.gtfs import read_csv
from lib.stops import build_stop_code_map, build_stops
from lib.schedules import (
    build_compact_schedule_model,
    build_reference_directions,
    build_stop_times,
    build_trips,
    merge_logical_trips,
    merge_partial_directions,
)


def main():
    routes_data = read_csv("routes.txt")
    stops_data = read_csv("stops.txt")
    trips_data = read_csv("trips.txt")
    stop_times_data = read_csv("stop_times.txt")
    calendar_result = json.loads(
        (DATA_DIR / "calendar.json").read_text(encoding="utf-8")
    )

    service_day_types = calendar_result.get("serviceDayTypes", {})
    trips_by_id = build_trips(trips_data, service_day_types)

    stop_code_by_gtfs_id = build_stop_code_map(stops_data)
    stop_times_by_trip = build_stop_times(
        stop_times_data,
        trips_by_id,
        stop_code_by_gtfs_id,
    )

    _, stops_by_id = build_stops(stops_data)

    directions, logical_trips, logical_stop_times = build_reference_directions(
        trips_by_id,
        stop_times_by_trip,
    )

    merge_partial_directions(
        routes_data,
        directions,
        logical_trips,
        logical_stop_times,
    )

    merge_logical_trips(
        routes_data,
        logical_trips,
        logical_stop_times,
    )

    model = build_compact_schedule_model(
        directions,
        logical_trips,
        logical_stop_times,
        trips_by_id,
        calendar_result,
    )

    # Keep stops_by_id construction here as an intentional validation step:
    # every direction stop should resolve to a normalized GTFS stop.
    missing_stops = {
        stop_id
        for direction in model["directions"]
        for stop_id in direction["stops"]
        if stop_id not in stops_by_id
    }
    if missing_stops:
        raise RuntimeError(
            "Schedule directions reference unknown normalized stops: "
            + ", ".join(sorted(missing_stops)[:20])
        )

    write_json(DATA_DIR / "trips.json", model["trips"])
    write_json(DATA_DIR / "directions.json", model["directions"])
    write_json(DATA_DIR / "stop_times.json", model["stop_times"])
    write_json(DATA_DIR / "realtime-trips.json", model["realtime_trips"])

    print(
        "Schedules model: "
        f"trips={len(model['trips'])}, "
        f"directions={len(model['directions'])}, "
        f"stop_times={len(model['stop_times'])}, "
        f"realtime_trips={len(model['realtime_trips'])}"
    )


if __name__ == "__main__":
    main()
