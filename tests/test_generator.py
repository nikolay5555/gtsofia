from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).resolve().parents[1] / "Scripts" / "generate_transport_data.py"
spec = importlib.util.spec_from_file_location("generate_transport_data", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GeneratorTests(unittest.TestCase):
    def test_route_ref_normalization_matches_dimitar_model(self):
        cases = {
            "E27": "27",
            "N1": "N1",
            "Y1": "У1",
            "20TB": "20ТБ",
            "3TM": "3ТМ",
        }
        for source, expected in cases.items():
            self.assertEqual(module.determine_route_ref(source), expected)

    def test_stop_code_is_application_code_not_raw_gtfs_feed_id(self):
        self.assertEqual(module.pad_stop_id("328"), "0328")
        self.assertEqual(module.pad_stop_id("0328"), "0328")
        self.assertEqual(module.pad_stop_id("M18"), "M18")
        self.assertEqual(module.pad_stop_id("M18St"), "M18St")

    def test_weekend_holiday_classification(self):
        from datetime import date
        config = {"dateOverrides": {}}
        self.assertTrue(module.is_weekend(date(2026, 10, 3), config))
        self.assertFalse(module.is_weekend(date(2026, 10, 2), config))
        self.assertTrue(module.is_weekend(date(2026, 5, 1), config))

    def test_metro_route_ref_remains_canonical_for_data_layer(self):
        self.assertEqual(module.determine_route_ref("M1"), "M1")
        self.assertEqual(module.determine_route_ref("M4"), "M4")

    def test_route_type_mapping(self):
        self.assertEqual(module.determine_route_type("20ТМ", "bus"), "bus")
        self.assertEqual(module.determine_route_type("M1", "bus"), "bus")
        self.assertEqual(module.determine_route_type("20", "trolley"), "trolley")
        self.assertEqual(module.determine_route_type("50", "trolley"), "bus")


if __name__ == "__main__":
    unittest.main()
