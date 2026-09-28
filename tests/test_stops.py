import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "Scripts" / "generate_transport_data.py"
spec = importlib.util.spec_from_file_location("generate_transport_data", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StopIndexTests(unittest.TestCase):
    def test_duplicate_stop_id_prefers_named_public_stop(self):
        stops = [
            {
                "stop_id": "0024",
                "stop_code": "0024",
                "stop_name": "28-МИ ДКЦ",
                "location_type": "0",
            },
            {
                "stop_id": "0024",
                "stop_code": "",
                "stop_name": "",
                "location_type": "3",
                "parent_station": "OMSt",
            },
        ]

        index = module.build_stop_index(stops)

        self.assertEqual(index["0024"]["stop_name"], "28-МИ ДКЦ")
        self.assertEqual(index["0024"]["stop_code"], "0024")

    def test_build_stops_deduplicates_normalized_ids(self):
        output, index = module.build_stops([
            {
                "stop_id": "24",
                "stop_code": "24",
                "stop_name": "28-МИ ДКЦ",
                "location_type": "0",
            },
            {
                "stop_id": "0024",
                "stop_code": "",
                "stop_name": "",
                "location_type": "3",
            },
        ])

        self.assertEqual(len(output), 1)
        self.assertEqual(output[0]["stop_id"], "0024")
        self.assertEqual(index["0024"]["stop_name"], "28-МИ ДКЦ")


if __name__ == "__main__":
    unittest.main()
