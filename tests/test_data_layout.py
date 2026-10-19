import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"


class GeneratedDataLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = {
            name: json.loads((DATA / name).read_text(encoding="utf-8"))
            for name in (
                "metadata.json", "calendar.json", "calendar-exceptions.json",
                "routes.json", "stops.json", "trips.json", "directions.json",
                "schedules.json", "shapes.json",
            )
        }

    def test_legacy_monolithic_json_is_not_published(self):
        self.assertFalse((DATA / "transport.json").exists())

    def test_schedules_and_directions_are_split_by_route_and_key(self):
        schedules = self.files["schedules.json"]
        directions = self.files["directions.json"]
        self.assertTrue(directions)
        for route_id, route_directions in directions.items():
            self.assertIn(route_id, schedules)
            for direction_key in route_directions:
                self.assertIn(direction_key, schedules[route_id])

    def test_direction_stop_names_match_the_osm_first_stop_records(self):
        stops = {}
        def preference(row):
            return (
                bool(str(row.get("stop_name") or "").strip()),
                bool(str(row.get("stop_code") or "").strip()),
                str(row.get("location_type") or "") == "0",
            )
        for row in self.files["stops.json"]:
            key = str(row.get("stop_id"))
            if key not in stops or preference(row) > preference(stops[key]):
                stops[key] = row
        for route_directions in self.files["directions.json"].values():
            for direction in route_directions.values():
                for item in direction.get("stops", []):
                    stop = stops.get(str(item.get("stop_id")))
                    self.assertIsNotNone(stop)
                    if stop and stop.get("stop_name"):
                        self.assertEqual(item.get("name"), stop["stop_name"])

    def test_calendar_exceptions_are_grouped_by_future_date(self):
        reference = self.files["metadata.json"]["updatedAt"].replace("-", "")
        calendar = self.files["calendar.json"]
        exceptions = self.files["calendar-exceptions.json"]["exceptionsByDate"]
        self.assertEqual(calendar.get("exceptions"), [])
        self.assertTrue(exceptions)
        self.assertTrue(all(key >= reference for key in exceptions))
        for value in exceptions.values():
            self.assertIn("add", value)
            self.assertIn("remove", value)
            self.assertIsInstance(value["add"], list)
            self.assertIsInstance(value["remove"], list)

    def test_only_active_service_trips_are_kept(self):
        active_services = set(self.files["calendar.json"]["serviceDayTypes"])
        trips = self.files["trips.json"]
        self.assertTrue(trips)
        self.assertTrue(all(row["service_id"] in active_services for row in trips))
        self.assertTrue(all("block_id" not in row for row in trips))


if __name__ == "__main__":
    unittest.main()
