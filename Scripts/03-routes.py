#!/usr/bin/env python3

import json

from lib.common import DATA_DIR, normalize, write_json
from lib.gtfs import read_csv
from lib.routes import build_model_routes


def main():
    routes = read_csv("routes.txt")
    trips = read_csv("trips.txt")
    with (DATA_DIR / "active_service_ids.json").open(
        "r",
        encoding="utf-8",
    ) as file:
        active_service_ids = dict(json.load(file))

    active_route_ids = {
        normalize(trip.get("route_id"))
        for trip in trips
        if normalize(trip.get("service_id")) in active_service_ids
    }

    result = build_model_routes(routes, active_route_ids)
    write_json(DATA_DIR / "routes.json", result)
    print(f"Normalized active routes: {len(result)}")


if __name__ == "__main__":
    main()
