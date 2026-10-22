import json
from pathlib import Path
import unittest

from Scripts.transport_generator.pipeline import compact_calendar

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


if __name__ == "__main__":
    unittest.main()
