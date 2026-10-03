import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "Scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from lib.osm import _build_model_stop, _osm_code
from lib.routes import (
    determine_model_route_ref,
    determine_model_route_subtype,
    determine_model_route_type,
)


class NormalizationTests(unittest.TestCase):
    def test_route_hierarchy(self):
        self.assertEqual(determine_model_route_ref("N1"), "N1")
        self.assertEqual(determine_model_route_type("N1", "3"), "bus")
        self.assertEqual(determine_model_route_subtype("N1", "bus"), "night")

        self.assertEqual(determine_model_route_ref("Y12"), "У12")
        self.assertEqual(determine_model_route_subtype("У12", "bus"), "school")

        self.assertEqual(determine_model_route_ref("20TM"), "20ТМ")
        self.assertEqual(determine_model_route_type("20ТМ", "3"), "bus")
        self.assertEqual(determine_model_route_subtype("20ТМ", "bus"), "temporary")

        self.assertEqual(determine_model_route_type("55", "11"), "bus")
        self.assertEqual(determine_model_route_type("3", "11"), "trolley")

    def test_explicit_override_can_suppress_subtype(self):
        from lib.routes import build_model_routes

        routes = [{
            "route_id": "TB35",
            "route_short_name": "60",
            "route_type": "3",
        }]

        result = build_model_routes(
            routes,
            {"TB35"},
            [{
                "cgm_id": "TB35",
                "type": "bus",
                "subtype": None,
            }],
        )

        self.assertEqual(result[0]["type"], "bus")
        self.assertNotIn("subtype", result[0])

    def test_osm_code_preserves_metro_prefix(self):
        self.assertEqual(_osm_code({"ref": "1", "subway": "yes"}), "M1")
        self.assertEqual(_osm_code({"ref": "123"}), "0123")

    def test_osm_stop_prefers_names_and_optional_fields(self):
        element = {
            "lat": 42.7357,
            "lon": 23.30533,
            "tags": {
                "ref": "123",
                "name": "Тестова спирка",
                "short_name:bg": "Тест.",
                "local_ref": "L1",
                "request_stop": "yes",
            },
        }

        stop = _build_model_stop(element)

        self.assertEqual(stop["code"], "0123")
        self.assertEqual(stop["coords"], [42.7357, 23.30533])
        self.assertEqual(stop["names"]["bg"], "Тестова спирка")
        self.assertTrue(stop["names"]["en"])
        self.assertEqual(stop["names"]["bg_short"], "Тест.")
        self.assertEqual(stop["local_ref"], "L1")
        self.assertTrue(stop["request_stop"])


if __name__ == "__main__":
    unittest.main()
