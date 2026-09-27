import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "Scripts"
sys.path.insert(0, str(SCRIPTS))

import generate_transport_data as generator  # noqa: E402


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class OSMStopTests(unittest.TestCase):
    def test_build_osm_query_covers_supported_stop_tags(self):
        query = generator.build_osm_query()

        self.assertIn("[network=\"Градски транспорт София\"]", query)
        self.assertIn("[network:wikidata=\"Q124360139\"]", query)
        self.assertIn("[public_transport~\"^(platform|stop_position|station)$\"]", query)
        self.assertIn("[highway=\"bus_stop\"]", query)
        self.assertIn("[railway=\"tram_stop\"]", query)
        self.assertIn("out center tags;", query)

    def test_parse_osm_stops_normalizes_codes_and_uses_english_name(self):
        payload = {
            "elements": [
                {
                    "type": "node",
                    "id": 1,
                    "lat": 42.698,
                    "lon": 23.309,
                    "tags": {
                        "network": "Градски транспорт София",
                        "public_transport": "platform",
                        "ref": "0283",
                        "name": "бул. Ал. Стамболийски",
                        "name:en": "Aleksander Stamboliyski Blvd.",
                    },
                },
                {
                    "type": "node",
                    "id": 2,
                    "lat": 42.70,
                    "lon": 23.31,
                    "tags": {
                        "network": "Градски транспорт София",
                        "public_transport": "platform",
                        "ref": "350",
                        "name": "бул. Никола Петков",
                    },
                },
                {
                    "type": "node",
                    "id": 3,
                    "lat": 42.69,
                    "lon": 23.33,
                    "tags": {
                        "network": "Градски транспорт София",
                        "public_transport": "station",
                        "subway": "yes",
                        "ref": "1",
                        "name": "СЛИВНИЦА",
                    },
                },
            ]
        }

        result = generator.parse_osm_stops(payload)

        self.assertIn("0283", result)
        self.assertIn("0350", result)
        self.assertIn("M1", result)
        self.assertEqual(result["0283"]["name_en"], "Aleksander Stamboliyski Blvd.")
        self.assertTrue(result["0350"]["name_en"])
        self.assertEqual(result["M1"]["name"], "СЛИВНИЦА")

    def test_parse_osm_stops_supports_way_center(self):
        payload = {
            "elements": [
                {
                    "type": "way",
                    "id": 10,
                    "center": {"lat": 42.70, "lon": 23.32},
                    "tags": {
                        "network:wikidata": "Q124360139",
                        "public_transport": "platform",
                        "ref": "123",
                        "name": "Централна гара",
                    },
                }
            ]
        }

        result = generator.parse_osm_stops(payload)

        self.assertEqual(result["0123"]["lat"], 42.7)
        self.assertEqual(result["0123"]["lon"], 23.32)

    def test_merge_prefers_osm_and_keeps_gtfs_fallback(self):
        stops = [
            {"stop_id": "0283", "stop_name": "GTFS име A"},
            {"stop_id": "123", "stop_name": "GTFS име B"},
            {"stop_id": "9999", "stop_name": "GTFS име C"},
        ]
        osm_stops = {
            "0283": {
                "name": "OSM име A",
                "name_en": "OSM Name A",
            },
            "0123": {
                "name": "OSM име B",
                "name_en": "OSM Name B",
            },
        }

        merged = generator.merge_osm_stop_names(stops, osm_stops)

        self.assertEqual(merged[0]["stop_name"], "OSM име A")
        self.assertEqual(merged[0]["stop_name_en"], "OSM Name A")
        self.assertEqual(merged[1]["stop_name"], "OSM име B")
        self.assertEqual(merged[2]["stop_name"], "GTFS име C")
        self.assertNotIn("stop_name_en", merged[2])

    def test_fetch_osm_stops_falls_back_to_second_endpoint(self):
        payload = {
            "elements": [
                {
                    "type": "node",
                    "id": 1,
                    "lat": 42.7,
                    "lon": 23.3,
                    "tags": {
                        "network": "Градски транспорт София",
                        "public_transport": "platform",
                        "ref": "0283",
                        "name": "OSM спирка",
                    },
                }
            ]
        }

        def fake_urlopen(request, timeout):
            if request.full_url == generator.OSM_OVERPASS_ENDPOINTS[0]:
                raise RuntimeError("temporary Overpass failure")
            return FakeResponse(payload)

        with patch.object(generator.urllib.request, "urlopen", side_effect=fake_urlopen):
            result = generator.fetch_osm_stops()

        self.assertEqual(result["0283"]["name"], "OSM спирка")


if __name__ == "__main__":
    unittest.main()
