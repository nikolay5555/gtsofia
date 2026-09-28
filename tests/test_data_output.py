import json
import tempfile
import unittest
from pathlib import Path
import importlib.util

MODULE_PATH = Path(__file__).resolve().parents[1] / "Scripts" / "generate_transport_data.py"
spec = importlib.util.spec_from_file_location("generate_transport_data", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublicDataOutputTests(unittest.TestCase):
    def test_public_calendar_is_compact(self):
        raw = {
            "referenceDate": "2026-09-28",
            "endDate": "2026-10-13",
            "servicePatterns": [{"service_id": "WD"}],
            "exceptions": [{"service_id": "WD", "date": "20260928"}],
            "serviceIdsByDate": {"2026-09-28": ["WD"]},
            "dateTypes": {"2026-09-28": "weekday"},
            "serviceDayTypes": {"WD": ["weekday"]},
            "config": {"dateOverrides": {}},
        }
        compact = module.build_public_calendar(raw)
        self.assertNotIn("exceptions", compact)
        self.assertNotIn("servicePatterns", compact)
        self.assertEqual(compact["dateTypes"]["2026-09-28"], "weekday")

    def test_split_writer_creates_manifest_and_chunks(self):
        result = {
            "updatedAt": "2026-09-28",
            "source": "CGM Sofia official GTFS",
            "lineOverrides": [],
            "calendar": {
                "referenceDate": "2026-09-28",
                "endDate": "2026-10-13",
                "servicePatterns": [],
                "exceptions": [],
                "serviceIdsByDate": {},
                "dateTypes": {},
                "serviceDayTypes": {},
                "config": {"dateOverrides": {}},
            },
            "routes": [{"route_id": "R1"}],
            "stops": [{"stop_id": "0024", "stop_name": "28-МИ ДКЦ"}],
            "trips": [{"trip_id": "T1", "route_id": "R1"}],
            "directions": {"R1": {"D1": {"stops": [{"stop_id": "0024"}]}}},
            "shapes": {"S1": [{"lat": 42.7, "lon": 23.3}]},
            "schedules": {"R1": {"D1": {"weekday": [{"times": [1]}]}}},
        }

        with tempfile.TemporaryDirectory() as directory:
            original = module.DATA_DIR
            original_manifest = module.OUTPUT_MANIFEST_FILE
            try:
                module.DATA_DIR = Path(directory)
                module.CORE_OUTPUT_FILES = {
                    "meta": module.DATA_DIR / "meta.json",
                    "calendar": module.DATA_DIR / "calendar.json",
                    "routes": module.DATA_DIR / "routes.json",
                    "stops": module.DATA_DIR / "stops.json",
                    "trips": module.DATA_DIR / "trips.json",
                    "directions": module.DATA_DIR / "directions.json",
                }
                module.OUTPUT_MANIFEST_FILE = module.DATA_DIR / "manifest.json"
                written = module.write_public_data(result)

                self.assertTrue(written["manifest"].exists())
                self.assertEqual(len(written["core"]), 6)
                self.assertTrue(all(path.exists() for path in written["core"]))
                self.assertEqual(len(written["shapes"]), 4)
                self.assertEqual(len(written["schedules"]), 4)

                manifest = json.loads(written["manifest"].read_text(encoding="utf-8"))
                self.assertEqual(manifest["version"], 2)
                self.assertIsNone(manifest["legacy"])

                stops = json.loads((module.DATA_DIR / "stops.json").read_text(encoding="utf-8"))
                calendar = json.loads((module.DATA_DIR / "calendar.json").read_text(encoding="utf-8"))
                self.assertEqual(stops[0]["stop_name"], "28-МИ ДКЦ")
                self.assertNotIn("exceptions", calendar)
            finally:
                module.DATA_DIR = original
                module.OUTPUT_MANIFEST_FILE = original_manifest


if __name__ == "__main__":
    unittest.main()
