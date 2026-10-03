#!/usr/bin/env python3

from lib.common import DATA_DIR, load_line_overrides, write_json
from lib.gtfs import read_csv
from lib.osm import fetch_osm_stops, merge_stops
from lib.stops import build_model_stops, build_stops


def main():
    stops_data = read_csv("stops.txt")
    gtfs_stops, _ = build_stops(stops_data)
    gtfs_model_stops = build_model_stops(gtfs_stops)

    try:
        osm_model_stops = fetch_osm_stops()
    except Exception as exc:
        # Keep the scheduled data update usable during a temporary OSM outage.
        # GTFS remains the fallback source for this run.
        print(f"Warning: OSM stop fetch failed: {exc}")
        osm_model_stops = []

    result = merge_stops(
        osm_model_stops,
        gtfs_model_stops,
    )

    write_json(DATA_DIR / "stops.json", result)
    print(
        f"Stops: {len(result)} "
        f"(OSM={len(osm_model_stops)}, GTFS fallback={len(gtfs_model_stops)})"
    )


if __name__ == "__main__":
    main()
