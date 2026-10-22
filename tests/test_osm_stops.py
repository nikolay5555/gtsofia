import unittest
from unittest.mock import patch

from Scripts.transport_generator.osm_stops import (
    apply_osm_stop_names,
    normalize_osm_code,
    parse_osm_response,
    transliterate,
    get_osm_stop_data,
)


class OSMStopTests(unittest.TestCase):
    def test_code_normalization_matches_sofiatraffic_schedules(self):
        self.assertEqual(normalize_osm_code("302", is_subway=True), "M302")
        self.assertEqual(normalize_osm_code("302"), "0302")
        self.assertEqual(normalize_osm_code("8"), "0008")
        self.assertEqual(normalize_osm_code(""), "")

    def test_transliteration_matches_source_project(self):
        self.assertEqual(transliterate("Зала Фестивална"), "Zala Festivalna")
        self.assertEqual(transliterate("ул. Йосиф Щросмайер"), "ul. Yosif SHTrosmayer")

    def test_osm_response_uses_language_names_and_stop_metadata(self):
        records = parse_osm_response({
            "elements": [{
                "type": "node",
                "id": 123,
                "lat": 42.7,
                "lon": 23.3,
                "tags": {
                    "subway": "yes",
                    "public_transport": "station",
                    "ref": "302",
                    "name": "Ген. Владимир Вазов",
                    "name:en": "General Vladimir Vazov",
                    "local_ref": "2",
                    "local_ref:metro": "B",
                    "short_name:bg": "Ген. Вазов",
                    "full_name:en": "General Vladimir Vazov Metro Station",
                },
            }]
        })

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["code"], "M302")
        self.assertEqual(records[0]["names"]["bg"], "Ген. Владимир Вазов")
        self.assertEqual(records[0]["names"]["en"], "General Vladimir Vazov")
        self.assertEqual(records[0]["names"]["bg_short"], "Ген. Вазов")
        self.assertEqual(records[0]["names"]["en_full"], "General Vladimir Vazov Metro Station")
        self.assertEqual(records[0]["local_ref"], "2")
        self.assertEqual(records[0]["metro_ref"], "B")

    def test_osm_name_replaces_gtfs_name_for_all_matching_rows(self):
        gtfs_stops = [
            {
                "stop_id": "1234",
                "stop_code": "1234",
                "stop_name": "СПИРКА ПО GTFS",
                "location_type": "0",
            },
            {
                "stop_id": "1234",
                "stop_code": "1234",
                "stop_name": "СПИРКА ПО GTFS",
                "location_type": "0",
            },
            {
                "stop_id": "9999",
                "stop_code": "9999",
                "stop_name": "ДРУГА СПИРКА",
                "location_type": "0",
            },
        ]
        osm_records = [{
            "code": "1234",
            "names": {
                "bg": "Спирка от OpenStreetMap",
                "en": "OSM Stop",
            },
            "local_ref": "1",
            "metro_ref": "A",
        }]

        stops, stops_by_id, stats = apply_osm_stop_names(gtfs_stops, osm_records)

        self.assertEqual(stops[0]["stop_name"], "Спирка от OpenStreetMap")
        self.assertEqual(stops[1]["stop_name"], "Спирка от OpenStreetMap")
        self.assertEqual(stops[0]["names"]["en"], "OSM Stop")
        self.assertEqual(stops[0]["local_ref"], "1")
        self.assertEqual(stops[0]["metro_ref"], "A")
        self.assertEqual(stops[2]["stop_name"], "ДРУГА СПИРКА")
        self.assertEqual(stops[2]["names"]["en"], transliterate("ДРУГА СПИРКА"))
        self.assertEqual(stops_by_id["1234"]["stop_name"], "Спирка от OpenStreetMap")
        self.assertEqual(stats["matches"], 2)
        self.assertEqual(stats["renamed"], 2)

    def test_platform_name_wins_when_osm_refs_are_duplicated(self):
        records = parse_osm_response({
            "elements": [
                {
                    "type": "node", "id": 1,
                    "tags": {
                        "ref": "0123", "name": "Предишно име",
                        "public_transport": "stop_position",
                    },
                },
                {
                    "type": "node", "id": 2,
                    "tags": {
                        "ref": "0123", "name": "Име от платформа",
                        "public_transport": "platform",
                    },
                },
            ]
        })
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["names"]["bg"], "Име от платформа")

    def test_osm_outage_uses_cache_instead_of_breaking_generation(self):
        cached = [{"code": "0123", "names": {"bg": "Кеширана спирка", "en": "Cached stop"}}]
        with patch("Scripts.transport_generator.osm_stops.fetch_osm_stops", side_effect=RuntimeError("offline")), \
             patch("Scripts.transport_generator.osm_stops.load_osm_stop_cache", return_value=cached):
            records, source = get_osm_stop_data()
        self.assertEqual(source, "cache")
        self.assertEqual(records, cached)


if __name__ == "__main__":
    unittest.main()
