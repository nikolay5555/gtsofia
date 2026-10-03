#!/usr/bin/env python3

import json

from lib.common import DATA_DIR, write_json, normalize
from lib.shapes import load_shapes


def main():
    realtime_trips = json.loads(
        (DATA_DIR / "realtime-trips.json").read_text(encoding="utf-8")
    )

    shape_ids = {
        normalize(trip.get("shape_id"))
        for trip in realtime_trips
        if normalize(trip.get("shape_id"))
    }

    shapes = load_shapes(shape_ids)
    write_json(DATA_DIR / "shapes.json", shapes)
    print(f"Shapes: {len(shapes)}")


if __name__ == "__main__":
    main()
