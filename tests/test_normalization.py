import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "Scripts" / "generate_transport_data.py"
spec = importlib.util.spec_from_file_location("generate_transport_data", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NormalizationTests(unittest.TestCase):
    def test_route_ref_matches_dimitar_rules(self):
        cases = {
            "E186": "186",
            "Е186": "186",
            "N1": "N1",
            "n2": "N2",
            "Y43": "У43",
            "У43": "У43",
            "20TM": "20ТМ",
            "20ТМ": "20ТМ",
            "45TB": "45ТБ",
            "45ТБ": "45ТБ",
            "8": "8",
        }

        for source, expected in cases.items():
            with self.subTest(source=source):
                self.assertEqual(module.normalize_route_ref(source), expected)

    def test_stop_code_prefers_stop_id_for_metro_and_stop_code_otherwise(self):
        self.assertEqual(module.normalize_stop_code("M3", "0003"), "M3")
        self.assertEqual(module.normalize_stop_code("A123", "123"), "0123")
        self.assertEqual(module.normalize_stop_code("A", ""), "")

    def test_osm_names_win_and_optional_metadata_is_preserved(self):
        gtfs_stops = [
            {
                "stop_id": "123",
                "stop_code": "123",
                "stop_name": "СТАРО ИМЕ",
                "stop_lat": "42.70000",
                "stop_lon": "23.30000",
                "location_type": "0",
            },
            {
                "stop_id": "999",
                "stop_code": "999",
                "stop_name": "GTFS ONLY",
                "stop_lat": "42.71000",
                "stop_lon": "23.31000",
                "location_type": "0",
            },
        ]
        osm_stops = {
            "0123": {
                "code": "0123",
                "coords": [42.70123, 23.30123],
                "names": {
                    "bg": "ОСМ ИМЕ",
                    "en": "OSM NAME",
                    "bg_short": "ОСМ",
                    "en_full": "OSM NAME FULL",
                },
                "request_stop": True,
                "local_ref": "L-123",
                "metro_ref": "M-123",
                "_osm_public_transport": "platform",
                "_osm_priority": 2,
            }
        }

        merged = module.merge_osm_stop_names(gtfs_stops, osm_stops)
        by_id = {stop["stop_id"]: stop for stop in merged}

        self.assertEqual(by_id["0123"]["stop_name"], "ОСМ ИМЕ")
        self.assertEqual(by_id["0123"]["stop_name_en"], "OSM NAME")
        self.assertEqual(by_id["0123"]["names"]["bg_short"], "ОСМ")
        self.assertEqual(by_id["0123"]["name_source"], "osm")
        self.assertEqual(by_id["0999"]["name_source"], "gtfs")
        self.assertTrue(by_id["0123"]["request_stop"])
        self.assertEqual(by_id["0123"]["local_ref"], "L-123")
        self.assertEqual(by_id["0123"]["metro_ref"], "M-123")
        self.assertEqual(by_id["0123"]["stop_lat"], "42.70123")
        self.assertEqual(by_id["0999"]["stop_name"], "GTFS ONLY")

    def test_normalized_route_record_adds_subtype(self):
        route = {
            "route_id": "TB1",
            "route_short_name": "N1",
            "route_type": "3",
        }
        normalized = module.normalize_route_record(route)
        self.assertEqual(normalized["cgm_id"], "TB1")
        self.assertEqual(normalized["route_ref"], "N1")
        self.assertEqual(normalized["type"], "bus")
        self.assertEqual(normalized["subtype"], "night")


if __name__ == "__main__":
    unittest.main()
