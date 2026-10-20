import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "Scripts" / "generate_transport_data.py"
spec = importlib.util.spec_from_file_location("generate_transport_data_osm_tests", SCRIPT)
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)

from lib.stops import build_stops, transliterate  # noqa: E402
from lib.direction_output import choose_direction_name, build_output_directions  # noqa: E402


class OSMStopTests(unittest.TestCase):
    def test_osm_names_and_coordinates_override_gtfs_when_matched(self):
        gtfs_stops = [
            {"stop_id": "123", "stop_code": "123", "stop_name": "GTFS NAME", "stop_lat": "42.0", "stop_lon": "23.0"},
            {"stop_id": "456", "stop_code": "456", "stop_name": "GTFS FALLBACK", "stop_lat": "42.1", "stop_lon": "23.1"},
        ]
        osm_stops = {
            "0123": {"stop_name": "OSM NAME", "stop_name_en": "Osm name", "stop_lat": "42.20000", "stop_lon": "23.20000", "local_ref": "A"},
        }

        output, by_id = build_stops(gtfs_stops, osm_stops=osm_stops)

        self.assertEqual(by_id["0123"]["stop_name"], "OSM NAME")
        self.assertEqual(by_id["0123"]["stop_lat"], "42.20000")
        self.assertEqual(by_id["0123"]["local_ref"], "A")
        self.assertEqual(by_id["0456"]["stop_name"], "GTFS FALLBACK")
        self.assertEqual(len(output), 2)

    def test_names_without_english_tag_get_transliterated_fallback(self):
        self.assertEqual(transliterate("София"), "Sofiya")

    def test_subway_code_normalization_is_preserved(self):
        output, by_id = build_stops(
            [{"stop_id": "M1", "stop_name": "GTFS METRO"}],
            osm_stops={"M1": {"stop_name": "OSM METRO"}},
        )
        self.assertEqual(output[0]["stop_id"], "M1")
        self.assertEqual(by_id["M1"]["stop_name"], "OSM METRO")

    def test_destination_uses_terminal_osm_name_before_gtfs_headsign(self):
        direction = {"stops": ["0010", "0020"], "headsigns": ["GTFS DESTINATION"]}
        stops = {"0020": {"stop_name": "OSM TERMINAL"}}
        self.assertEqual(choose_direction_name(direction, stops), "OSM TERMINAL")

    def test_destination_falls_back_to_gtfs_headsign_without_osm_name(self):
        direction = {"stops": ["0010", "0020"], "headsigns": ["GTFS DESTINATION"]}
        stops = {"0020": {"stop_name": ""}}
        self.assertEqual(choose_direction_name(direction, stops), "GTFS DESTINATION")

    def test_output_direction_contains_all_original_trip_ids(self):
        routes = [{"route_id": "R1"}]
        source_direction = {
            "code": "DIR-1",
            "route_id": "R1",
            "stops": ["0010", "0020"],
            "headsigns": ["GTFS DESTINATION"],
            "trip_ids": ["TRIP-A", "TRIP-B"],
            "shape_ids": ["SHARED-SHAPE"],
        }
        logical_trips = [{
            "route_id": "R1",
            "direction_code": "DIR-1",
            "original_trip_ids": ["TRIP-A", "TRIP-B"],
            "is_deleted": False,
        }]
        trips_by_id = {
            "TRIP-A": {"trip_id": "TRIP-A", "direction_id": "", "service_id": "S1"},
            "TRIP-B": {"trip_id": "TRIP-B", "direction_id": "", "service_id": "S1"},
        }
        stops_by_id = {
            "0010": {"stop_id": "0010", "stop_name": "Начална спирка"},
            "0020": {"stop_id": "0020", "stop_name": "OSM крайна спирка"},
        }

        output = build_output_directions(
            routes,
            [source_direction],
            logical_trips,
            trips_by_id,
            {},
            stops_by_id,
        )

        self.assertEqual(
            output["R1"]["D1"]["trip_ids"],
            ["TRIP-A", "TRIP-B"],
        )
        self.assertEqual(output["R1"]["D1"]["destination"], "OSM крайна спирка")


if __name__ == "__main__":
    unittest.main()
