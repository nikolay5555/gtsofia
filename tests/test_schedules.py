import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "Scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from lib.schedules import build_reference_directions, build_stop_times, build_trips


class ScheduleModelTests(unittest.TestCase):
    def test_preserves_arrival_and_departure_seconds(self):
        service_types = {"WEEKDAY": ["weekday"]}
        trips = build_trips(
            [{
                "trip_id": "TRIP-1",
                "route_id": "R1",
                "service_id": "WEEKDAY",
                "trip_headsign": "Terminal",
                "direction_id": "0",
                "shape_id": "SHAPE-1",
            }],
            service_types,
        )

        stop_times = build_stop_times(
            [{
                "trip_id": "TRIP-1",
                "stop_id": "S1",
                "stop_sequence": "1",
                "arrival_time": "08:01:30",
                "departure_time": "08:02:10",
            }],
            trips,
            {},
        )

        directions, logical_trips, logical_stop_times = build_reference_directions(
            trips,
            stop_times,
        )

        self.assertEqual(len(directions), 1)
        self.assertEqual(len(logical_trips), 1)
        self.assertEqual(len(logical_stop_times), 1)

        row = logical_stop_times[0]
        self.assertEqual(row["times"], [482])
        self.assertEqual(row["arrival_times"], [8 * 3600 + 1 * 60 + 30])
        self.assertEqual(row["departure_times"], [8 * 3600 + 2 * 60 + 10])
        self.assertEqual(row["stop_sequences"], [1])

    def test_missing_arrival_uses_departure_without_losing_exact_departure(self):
        service_types = {"WEEKDAY": ["weekday"]}
        trips = build_trips(
            [{
                "trip_id": "TRIP-2",
                "route_id": "R1",
                "service_id": "WEEKDAY",
                "direction_id": "0",
                "shape_id": "SHAPE-1",
            }],
            service_types,
        )

        stop_times = build_stop_times(
            [{
                "trip_id": "TRIP-2",
                "stop_id": "S1",
                "stop_sequence": "1",
                "arrival_time": "",
                "departure_time": "25:03:04",
            }],
            trips,
            {},
        )

        _, _, logical_stop_times = build_reference_directions(trips, stop_times)
        row = logical_stop_times[0]

        self.assertEqual(row["times"], [1503])
        self.assertEqual(row["arrival_times"], [None])
        self.assertEqual(row["departure_times"], [25 * 3600 + 3 * 60 + 4])


if __name__ == "__main__":
    unittest.main()
