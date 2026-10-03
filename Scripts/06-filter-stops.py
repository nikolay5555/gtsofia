#!/usr/bin/env python3

import json

from lib.common import DATA_DIR, write_json


def main():
    stops = json.loads(
        (DATA_DIR / "stops.json").read_text(encoding="utf-8")
    )
    directions = json.loads(
        (DATA_DIR / "directions.json").read_text(encoding="utf-8")
    )

    seen = {
        str(stop_id)
        for direction in directions
        for stop_id in direction.get("stops", [])
    }

    filtered = [
        stop
        for stop in stops
        if str(stop.get("code", "")) in seen
    ]

    write_json(DATA_DIR / "stops.json", filtered)
    print(f"Filtered stops: {len(filtered)} / {len(stops)}")


if __name__ == "__main__":
    main()
