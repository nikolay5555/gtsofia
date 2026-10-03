#!/usr/bin/env python3

from lib.common import DATA_DIR, write_json
from lib.gtfs import read_csv
from lib.stops import build_model_stops, build_stops


def main():
    stops_data = read_csv("stops.txt")
    output_stops, _ = build_stops(stops_data)

    result = build_model_stops(output_stops)
    write_json(DATA_DIR / "stops.json", result)
    print(f"Normalized stops: {len(result)}")


if __name__ == "__main__":
    main()
