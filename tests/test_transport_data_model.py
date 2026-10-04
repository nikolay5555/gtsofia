from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
sys.path.insert(0, str(ROOT / "Scripts"))

from transport_common import normalize_display_name


def load(name: str):
    with (DATA / name).open("r", encoding="utf-8") as handle:
        return json.load(handle)


class TransportDataModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.routes = load("routes.json")
        cls.stops = load("stops.json")
        cls.directions = load("directions.json")
        cls.trips = load("trips.json")
        cls.stop_times = load("stop_times.json")
        cls.calendar = load("calendar.json")

    def test_split_files_exist_and_legacy_monolith_is_absent(self):
        for name in ("routes.json", "stops.json", "directions.json", "trips.json", "stop_times.json", "calendar.json"):
            self.assertTrue((DATA / name).is_file(), name)
        self.assertFalse((DATA / "transport.json").exists())

    def test_routes_use_type_and_optional_subtype(self):
        valid_types = {"metro", "tram", "trolley", "bus"}
        valid_subtypes = {"temporary", "school", "night"}
        for route in self.routes:
            route_id = route["cgm_id"]
            self.assertIn(route["type"], valid_types, route_id)
            if "subtype" in route:
                self.assertIn(route["subtype"], valid_subtypes, route_id)
        metro_numbers = sorted(route["route_ref"] for route in self.routes if route["type"] == "metro")
        self.assertEqual(metro_numbers, ["1", "2", "3", "4"])

    def test_direction_trip_stop_time_references_are_valid(self):
        direction_by_code = {str(item["code"]): item for item in self.directions}
        trip_by_id = {str(item["id"]): item for item in self.trips}
        stop_codes = {str(item["code"]) for item in self.stops}
        trip_ids = set(trip_by_id)
        for code, direction in direction_by_code.items():
            self.assertTrue(direction["stops"], code)
            self.assertTrue(set(map(str, direction["stops"])).issubset(stop_codes), code)
        for trip_id, trip in trip_by_id.items():
            self.assertIn(str(trip["direction"]), direction_by_code, trip_id)
            self.assertTrue(trip.get("source_trip_ids"), trip_id)
        for row in self.stop_times:
            self.assertIn(str(row["trip"]), trip_ids)
            self.assertIsInstance(row["times"], list)
            direction = direction_by_code[str(trip_by_id[str(row["trip"])] ["direction"])]
            self.assertEqual(len(row["times"]), len(direction["stops"]))
            self.assertTrue(all(value is None or isinstance(value, int) for value in row["times"]))

    def test_name_normalization_matches_public_examples(self):
        samples = {
            "БУЛ. К. ВЕЛИЧКОВ": "бул. К. Величков",
            "Ж.К. ЛЮЛИН-5": "ж.к. Люлин 5",
            "МЕТРОСТАНЦИЯ ДРУЖБА": "метростанция Дружба",
            "ПГД ЕЛИСАВЕТА ВАЗОВА": "ПГ по дизайн Елисавета Вазова",
            "28-МИ ДКЦ": "28-ми ДКЦ",
            "ЦЕНТРАЛНА ГАРА": "Централна гара",
            "СЕЛО ДОЛНИ ЛОЗЕН": "село Долни Лозен",
        }
        for raw, expected in samples.items():
            self.assertEqual(normalize_display_name(raw), expected)
        for expected in samples.values():
            self.assertEqual(normalize_display_name(expected), expected)

    def test_calendar_is_compact(self):
        self.assertIn("serviceIdsByDate", self.calendar)
        self.assertIn("dateTypes", self.calendar)
        self.assertNotIn("servicePatterns", self.calendar)
        self.assertNotIn("exceptions", self.calendar)


if __name__ == "__main__":
    unittest.main()
