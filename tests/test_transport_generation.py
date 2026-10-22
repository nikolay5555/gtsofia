import importlib.util
from datetime import date
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "Scripts" / "generate_transport_data.py"
spec = importlib.util.spec_from_file_location("generate_transport_data", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

import sys
SCRIPTS_DIR = ROOT / "Scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
from transport_data.directions import choose_direction_name
from transport_data.stops import build_stops
from transport_data.calendar import build_calendar_context


class TransportGenerationTests(unittest.TestCase):
    def test_osm_name_overrides_gtfs_name_and_missing_osm_uses_gtfs(self):
        gtfs_stops = [
            {"stop_id": "0123", "stop_code": "0123", "stop_name": "GTFS NAME", "location_type": "0"},
            {"stop_id": "0456", "stop_code": "0456", "stop_name": "GTFS FALLBACK", "location_type": "0"},
        ]
        stops, by_id = build_stops(gtfs_stops, {"0123": "OSM Name"})
        self.assertEqual(by_id["0123"]["stop_name"], "OSM Name")
        self.assertEqual(by_id["0456"]["stop_name"], "GTFS FALLBACK")

    def test_direction_destination_uses_terminal_stop_name_before_gtfs_headsign(self):
        direction = {
            "stops": ["0001", "0002"],
            "headsigns": ["GTFS DESTINATION", "GTFS DESTINATION"],
        }
        stops_by_id = {
            "0001": {"stop_id": "0001", "stop_name": "First stop"},
            "0002": {"stop_id": "0002", "stop_name": "OSM terminal name"},
        }
        self.assertEqual(choose_direction_name(direction, stops_by_id), "OSM terminal name")

    def test_direction_destination_falls_back_to_gtfs_headsign_if_terminal_name_missing(self):
        direction = {"stops": ["0002"], "headsigns": ["GTFS DESTINATION"]}
        stops_by_id = {"0002": {"stop_id": "0002", "stop_name": ""}}
        self.assertEqual(choose_direction_name(direction, stops_by_id), "GTFS DESTINATION")

    def test_only_exception_rows_in_generated_date_window_are_output(self):
        calendar_dates = [
            {"service_id": "A", "date": "20260901", "exception_type": "1"},
            {"service_id": "A", "date": "20261022", "exception_type": "1"},
            {"service_id": "A", "date": "20261106", "exception_type": "1"},
            {"service_id": "A", "date": "20261107", "exception_type": "1"},
        ]
        _, calendar_result = build_calendar_context(
            [],
            calendar_dates,
            date(2026, 10, 22),
            horizon_days=15,
        )
        self.assertEqual(calendar_result["exceptions"], [])
        self.assertEqual(
            calendar_result["serviceIdsByDate"]["2026-10-22"],
            ["A"],
        )
        self.assertIn("2026-11-06", calendar_result["serviceIdsByDate"])
        self.assertNotIn("2026-11-07", calendar_result["serviceIdsByDate"])


if __name__ == "__main__":
    unittest.main()
