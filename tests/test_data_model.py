from __future__ import annotations

import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"


def load(name):
    with (DATA / f"{name}.json").open("r", encoding="utf-8") as fh:
        return json.load(fh)


class CanonicalDataModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.routes = load("routes")
        cls.stops = load("stops")
        cls.directions = load("directions")
        cls.trips = load("trips")
        cls.stop_times = load("stop_times")
        cls.realtime = load("realtime-trip-map")

        cls.route_by_id = {str(item["cgm_id"]): item for item in cls.routes}
        cls.stop_by_code = {str(item["code"]): item for item in cls.stops}
        cls.direction_by_code = {str(item["code"]): item for item in cls.directions}
        cls.trip_by_id = {str(item["id"]): item for item in cls.trips}

    def test_snapshot_contains_canonical_schedule_tables(self):
        self.assertGreater(len(self.routes), 0)
        self.assertGreater(len(self.stops), 0)
        self.assertGreater(len(self.directions), 0)
        self.assertGreater(len(self.trips), 0)
        self.assertGreater(len(self.stop_times), 0)
        self.assertGreater(len(self.realtime), 0)

    def test_primary_keys_are_unique(self):
        self.assertEqual(len(self.routes), len(self.route_by_id))
        self.assertEqual(len(self.stops), len(self.stop_by_code))
        self.assertEqual(len(self.directions), len(self.direction_by_code))
        self.assertEqual(len(self.trips), len(self.trip_by_id))

    def test_route_refs_are_unique_per_transport_type(self):
        keys = {(str(item.get("type")), str(item.get("route_ref"))) for item in self.routes}
        self.assertEqual(len(self.routes), len(keys))

    def test_direction_stops_exist(self):
        missing = [
            (direction["code"], stop_code)
            for direction in self.directions
            for stop_code in direction.get("stops", [])
            if str(stop_code) not in self.stop_by_code
        ]
        self.assertEqual(missing, [])

    def test_trips_reference_existing_routes_and_directions(self):
        missing = []
        for trip in self.trips:
            if str(trip["cgm_id"]) not in self.route_by_id:
                missing.append((trip["id"], "route", trip["cgm_id"]))
            if str(trip["direction"]) not in self.direction_by_code:
                missing.append((trip["id"], "direction", trip["direction"]))
        self.assertEqual(missing, [])

    def test_stop_times_reference_existing_trip_and_direction_shape(self):
        errors = []
        for row in self.stop_times:
            trip_id = str(row["trip"])
            trip = self.trip_by_id.get(trip_id)
            if not trip:
                errors.append((trip_id, "missing trip"))
                continue
            direction = self.direction_by_code.get(str(trip["direction"]))
            if not direction:
                errors.append((trip_id, "missing direction"))
                continue
            if len(row.get("times", [])) != len(direction.get("stops", [])):
                errors.append((trip_id, "times length mismatch"))
        self.assertEqual(errors, [])

    def test_realtime_trip_map_resolves_static_schedule(self):
        errors = []
        for raw_id, item in self.realtime.items():
            if str(item.get("route_id")) not in self.route_by_id:
                errors.append((raw_id, "route"))
            if str(item.get("direction_code")) not in self.direction_by_code:
                errors.append((raw_id, "direction"))
            if str(item.get("logical_trip_id")) not in self.trip_by_id:
                errors.append((raw_id, "logical trip"))
        self.assertEqual(errors, [])

    def test_metro_routes_keep_canonical_m_prefix(self):
        metros = [route for route in self.routes if route["type"] == "metro"]
        self.assertGreaterEqual(len(metros), 1)
        self.assertTrue(all(str(route["route_ref"]).startswith("M") for route in metros))
        self.assertTrue(all(str(route["cgm_id"]).startswith("M") for route in metros))


if __name__ == "__main__":
    unittest.main()
