import unittest

from Scripts.transport_generator.direction_output import (
    build_output_directions,
    choose_direction_name,
)


class DirectionOutputTests(unittest.TestCase):
    def test_destination_stop_name_takes_precedence_over_gtfs_headsign(self):
        direction = {
            "stops": ["0100", "0200"],
            "headsigns": ["СТАРО ИМЕ ОТ GTFS", "СТАРО ИМЕ ОТ GTFS"],
        }
        stops_by_id = {
            "0100": {"stop_id": "0100", "stop_name": "Начална спирка"},
            "0200": {"stop_id": "0200", "stop_name": "Крайна спирка от OSM"},
        }

        self.assertEqual(
            choose_direction_name(direction, stops_by_id),
            "Крайна спирка от OSM",
        )

    def test_gtfs_headsign_is_fallback_when_terminal_stop_is_missing(self):
        direction = {
            "stops": ["0100", "M404"],
            "headsigns": ["Резервно име", "Резервно име"],
        }
        stops_by_id = {
            "0100": {"stop_id": "0100", "stop_name": "Начална спирка"},
        }

        self.assertEqual(
            choose_direction_name(direction, stops_by_id),
            "Резервно име",
        )

    def test_empty_direction_returns_empty_name(self):
        self.assertEqual(choose_direction_name({"stops": []}, {}), "")

    def test_output_keeps_gtfs_headsign_alias_for_matching(self):
        output = build_output_directions(
            routes_data=[{"route_id": "R1"}],
            directions=[{
                "code": "1",
                "route_id": "R1",
                "stops": ["S1", "S2"],
                "headsigns": ["OLD GTFS NAME", "OLD GTFS NAME"],
                "shape_ids": [],
            }],
            logical_trips=[{
                "route_id": "R1",
                "direction_code": "1",
                "original_trip_ids": ["T1"],
                "is_deleted": False,
            }],
            trips_by_id={"T1": {
                "trip_id": "T1",
                "direction_id": "",
                "service_id": "SERVICE",
            }},
            stop_times_by_trip={},
            stops_by_id={
                "S1": {"stop_id": "S1", "stop_name": "Initial"},
                "S2": {"stop_id": "S2", "stop_name": "OSM Destination"},
            },
        )

        direction = output["R1"]["D1"]
        self.assertEqual(direction["headsign"], "OSM Destination")
        self.assertEqual(direction["destination"], "OSM Destination")
        self.assertEqual(direction["gtfs_headsigns"], ["OLD GTFS NAME"])


if __name__ == "__main__":
    unittest.main()
