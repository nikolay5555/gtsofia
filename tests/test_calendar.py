import importlib.util
from datetime import date
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "Scripts" / "generate_transport_data.py"
spec = importlib.util.spec_from_file_location("generate_transport_data", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CalendarTests(unittest.TestCase):
    def setUp(self):
        self.calendar = [
            {
                "service_id": "WD",
                "monday": "1", "tuesday": "1", "wednesday": "1",
                "thursday": "1", "friday": "1", "saturday": "0", "sunday": "0",
                "start_date": "20260901", "end_date": "20260930",
            },
            {
                "service_id": "WE",
                "monday": "0", "tuesday": "0", "wednesday": "0",
                "thursday": "0", "friday": "0", "saturday": "1", "sunday": "1",
                "start_date": "20260901", "end_date": "20260930",
            },
        ]
        self.calendar_dates = [
            {"service_id": "WD", "date": "20260922", "exception_type": "2"},
            {"service_id": "WE", "date": "20260922", "exception_type": "1"},
        ]

    def test_gtfs_exception_does_not_define_ui_day_type(self):
        service_types, calendar_result = module.build_calendar_context(
            self.calendar,
            self.calendar_dates,
            date(2026, 9, 22),
            horizon_days=0,
        )

        self.assertEqual(
            calendar_result["dateTypes"]["2026-09-22"],
            "weekday",
        )
        self.assertEqual(
            calendar_result["serviceIdsByDate"]["2026-09-22"],
            ["WE"],
        )
        self.assertNotIn("WD", service_types)
        self.assertEqual(service_types["WE"], ["weekday"])

    def test_central_calendar_override_defines_ui_day_type(self):
        service_types, calendar_result = module.build_calendar_context(
            self.calendar,
            self.calendar_dates,
            date(2026, 9, 22),
            horizon_days=0,
            calendar_config={
                "dateOverrides": {
                    "2026-09-22": "weekend",
                },
            },
        )

        self.assertEqual(
            calendar_result["dateTypes"]["2026-09-22"],
            "weekend",
        )
        self.assertNotIn("WD", service_types)
        self.assertEqual(service_types["WE"], ["weekend"])

    def test_service_operating_in_both_buckets_is_preserved(self):
        daily = [
            {
                "service_id": "DAILY",
                "monday": "1", "tuesday": "1", "wednesday": "1",
                "thursday": "1", "friday": "1", "saturday": "1", "sunday": "1",
                "start_date": "20260901", "end_date": "20260930",
            }
        ]

        service_types, _ = module.build_calendar_context(
            daily,
            [],
            date(2026, 9, 21),
            horizon_days=6,
        )

        self.assertEqual(service_types["DAILY"], ["weekday", "weekend"])

    def test_trip_available_in_both_buckets_is_written_to_both_schedules(self):
        directions = {
            "R1": {
                "D1": {
                    "code": "1",
                }
            }
        }
        logical_trips = [
            {
                "id": 1,
                "route_id": "R1",
                "direction_code": "1",
                "day_types": ["weekday", "weekend"],
                "is_deleted": False,
            }
        ]
        logical_stop_times = [
            {
                "trip": 1,
                "times": [330],
                "car": "",
            }
        ]

        result = module.build_schedules(
            directions,
            logical_trips,
            logical_stop_times,
        )

        self.assertEqual(len(result["R1"]["D1"]["weekday"]), 1)
        self.assertEqual(len(result["R1"]["D1"]["weekend"]), 1)

    def test_calendar_dates_only_feed_uses_explicit_service_dates(self):
        dates_only = [
            {"service_id": "A", "date": "20260921", "exception_type": "1"},
            {"service_id": "A", "date": "20260926", "exception_type": "1"},
        ]

        service_types, calendar_result = module.build_calendar_context(
            [],
            dates_only,
            date(2026, 9, 21),
            horizon_days=5,
        )

        self.assertEqual(
            calendar_result["dateTypes"]["2026-09-21"],
            "weekday",
        )
        self.assertEqual(
            calendar_result["dateTypes"]["2026-09-26"],
            "weekend",
        )
        self.assertEqual(service_types["A"], ["weekday", "weekend"])



class OSMStopNameTests(unittest.TestCase):
    def test_transliteration_matches_reference_mapping(self):
        self.assertEqual(module.transliterate("София"), "Sofiya")
        self.assertEqual(module.transliterate("Ж.к. Изток"), "Zh.k. Iztok")

    def test_osm_names_override_gtfs_and_preserve_local_references(self):
        gtfs_stops = [
            {
                "stop_id": "0012",
                "stop_code": "12",
                "stop_name": "Старо GTFS име",
                "stop_lat": "42.0",
                "stop_lon": "23.0",
            }
        ]
        osm_stops = [
            {
                "type": "node",
                "id": 123,
                "lat": 42.1,
                "lon": 23.1,
                "tags": {
                    "bus": "yes",
                    "public_transport": "platform",
                    "ref": "12",
                    "name": "Ново OSM име",
                    "name:en": "New OSM name",
                    "short_name:bg": "Ново",
                    "full_name:bg": "Пълно ново OSM име",
                    "local_ref": "3",
                    "local_ref:metro": "2",
                },
            }
        ]

        stops, by_id = module.build_stops(gtfs_stops, osm_stops)
        stop = stops[0]

        self.assertEqual(stop["stop_name"], "Ново OSM име")
        self.assertEqual(stop["names"]["bg"], "Ново OSM име")
        self.assertEqual(stop["names"]["en"], "New OSM name")
        self.assertEqual(stop["names"]["bg_short"], "Ново")
        self.assertEqual(stop["names"]["bg_full"], "Пълно ново OSM име")
        self.assertEqual(stop["local_ref"], "3")
        self.assertEqual(stop["metro_ref"], "2")
        self.assertIs(by_id["0012"], stop)

    def test_missing_english_osm_name_is_transliterated(self):
        gtfs_stops = [
            {"stop_id": "7", "stop_code": "7", "stop_name": "GTFS name"}
        ]
        osm_stops = [
            {
                "type": "node",
                "id": 7,
                "tags": {
                    "bus": "yes",
                    "public_transport": "platform",
                    "ref": "7",
                    "name": "Спирка София",
                },
            }
        ]

        stops, _ = module.build_stops(gtfs_stops, osm_stops)
        self.assertEqual(stops[0]["stop_name"], "Спирка София")
        self.assertEqual(stops[0]["names"]["en"], "Spirka Sofiya")

    def test_platform_wins_when_osm_codes_are_duplicated(self):
        gtfs_stops = [
            {"stop_id": "2", "stop_code": "2", "stop_name": "GTFS name"}
        ]
        osm_stops = [
            {
                "type": "node",
                "id": 20,
                "tags": {
                    "tram": "yes",
                    "public_transport": "stop_position",
                    "ref": "2",
                    "name": "Име от stop_position",
                },
            },
            {
                "type": "node",
                "id": 21,
                "tags": {
                    "bus": "yes",
                    "public_transport": "platform",
                    "ref": "2",
                    "name": "Име от platform",
                },
            },
        ]

        stops, _ = module.build_stops(gtfs_stops, osm_stops)
        self.assertEqual(stops[0]["stop_name"], "Име от platform")

    def test_gtfs_name_is_fallback_when_osm_name_is_missing(self):
        gtfs_stops = [
            {"stop_id": "3", "stop_code": "3", "stop_name": "Запазено GTFS име"}
        ]
        osm_stops = [
            {
                "type": "node",
                "id": 30,
                "tags": {
                    "bus": "yes",
                    "public_transport": "platform",
                    "ref": "3",
                },
            }
        ]

        stops, _ = module.build_stops(gtfs_stops, osm_stops)
        self.assertEqual(stops[0]["stop_name"], "Запазено GTFS име")
        self.assertEqual(stops[0]["names"]["bg"], "Запазено GTFS име")


if __name__ == "__main__":
    unittest.main()
