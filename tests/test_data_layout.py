import json
from pathlib import Path
import unittest

from Scripts.transport_generator.pipeline import compact_calendar
from Scripts.transport_generator.stops import build_stop_index

ROOT = Path(__file__).resolve().parents[1]


class DataLayoutTests(unittest.TestCase):
    def test_browser_calendar_only_contains_declared_coverage(self):
        compact = compact_calendar({
            "referenceDate": "2026-10-22",
            "endDate": "2026-11-06",
            "serviceIdsByDate": {"2026-10-22": ["TODAY"]},
            "dateTypes": {"2026-10-22": "weekday"},
            "config": {"dateOverrides": {}},
            "servicePatterns": [{"service_id": "OLD"}],
            "exceptions": [{"service_id": "OLD", "date": "20200101"}],
            "serviceDayTypes": {"OLD": ["weekday"]},
        })

        self.assertEqual(compact["coverageStartDate"], "2026-10-22")
        self.assertEqual(compact["coverageEndDate"], "2026-11-06")
        self.assertEqual(compact["serviceIdsByDate"]["2026-10-22"], ["TODAY"])
        self.assertNotIn("exceptions", compact)
        self.assertNotIn("servicePatterns", compact)
        self.assertNotIn("serviceDayTypes", compact)

    def test_split_runtime_files_are_valid_json(self):
        names = [
            "metadata.json",
            "calendar.json",
            "routes.json",
            "stops.json",
            "trips.json",
            "directions.json",
            "shapes.json",
            "schedules.json",
        ]
        for name in names:
            with self.subTest(name=name):
                path = ROOT / "data" / name
                self.assertTrue(path.is_file())
                json.loads(path.read_text(encoding="utf-8"))

        self.assertFalse((ROOT / "data" / "transport.json").exists())

    def test_stop_names_use_the_resolved_display_name_everywhere(self):
        stops = json.loads((ROOT / "data" / "stops.json").read_text(encoding="utf-8"))
        directions = json.loads((ROOT / "data" / "directions.json").read_text(encoding="utf-8"))
        cache = json.loads((ROOT / "config" / "osm-stops-cache.json").read_text(encoding="utf-8"))

        self.assertTrue(cache.get("stops"))
        self.assertEqual(cache.get("schemaVersion"), 1)
        for stop in stops:
            self.assertIn("names", stop)
            self.assertEqual(stop.get("stop_name", ""), stop["names"].get("bg", ""))
        stops_by_id = build_stop_index(stops)

        for route_directions in directions.values():
            for direction in route_directions.values():
                for direction_stop in direction.get("stops", []):
                    stop_id = str(direction_stop.get("stop_id") or "").strip()
                    self.assertIn(stop_id, stops_by_id)
                    self.assertEqual(
                        direction_stop.get("name"),
                        stops_by_id[stop_id].get("stop_name"),
                    )
                if direction.get("stops"):
                    terminal_name = direction["stops"][-1].get("name", "")
                    self.assertEqual(direction.get("headsign"), terminal_name)
                    self.assertEqual(direction.get("destination"), terminal_name)
                self.assertIsInstance(direction.get("gtfs_headsigns"), list)


if __name__ == "__main__":
    unittest.main()
