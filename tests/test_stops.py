import importlib.util
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).resolve().parents[1] / "Scripts" / "generate_transport_data.py"
spec = importlib.util.spec_from_file_location("generate_transport_data", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StopFilteringTests(unittest.TestCase):
    def test_keeps_direction_stops_parent_stations_and_duplicate_records(self):
        stops = [
            {"stop_id": "001", "parent_station": "P1", "name": "platform A"},
            {"stop_id": "001", "parent_station": "P1", "name": "platform A duplicate"},
            {"stop_id": "P1", "parent_station": "", "name": "parent station"},
            {"stop_id": "002", "parent_station": "", "name": "unused stop"},
        ]
        directions = {
            "R1": {
                "D1": {
                    "pattern": ["001"],
                    "stops": [{"stop_id": "001"}],
                }
            }
        }

        filtered = module.filter_stops_for_directions(stops, directions)
        self.assertEqual([stop["name"] for stop in filtered], [
            "platform A", "platform A duplicate", "parent station"
        ])

    def test_preserves_stops_referenced_only_by_pattern(self):
        stops = [{"stop_id": "001", "parent_station": ""}]
        directions = {"R1": {"D1": {"pattern": ["001"], "stops": []}}}
        self.assertEqual(module.filter_stops_for_directions(stops, directions), stops)


if __name__ == "__main__":
    unittest.main()
