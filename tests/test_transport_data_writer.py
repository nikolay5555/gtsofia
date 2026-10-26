import json
from pathlib import Path
import tempfile
import unittest

from Scripts.transport_data_writer import write_transport_data


class TransportDataWriterTests(unittest.TestCase):
    def test_writes_independent_files_and_lazy_route_schedules(self):
        core = {
            "updatedAt": "2026-10-26",
            "source": "test",
            "routes": [{"route_id": "R/1"}, {"route_id": "R2"}],
            "stops": [{"stop_id": "S1"}],
            "trips": [{"trip_id": "T1", "route_id": "R/1"}],
            "directions": {"R/1": {"D1": {"pattern": ["S1"]}}},
            "lineOverrides": [],
        }
        calendar = {"serviceIdsByDate": {"2026-10-26": ["SVC"]}, "exceptions": []}
        schedules = {"R/1": {"D1": {"weekday": [{"trip_id": "T1"}], "weekend": []}}}
        shapes = {"SH1": [{"lat": 42.0, "lon": 23.0}]}

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "data"
            data_dir.mkdir(parents=True)
            (data_dir / "transport.json").write_text("{}", encoding="utf-8")
            manifest = write_transport_data(data_dir, core, calendar, schedules, shapes)

            self.assertEqual(manifest["schemaVersion"], 3)
            self.assertFalse((data_dir / "transport.json").exists())
            self.assertTrue((data_dir / "routes.json").exists())
            self.assertTrue((data_dir / "trips.json").exists())
            self.assertTrue((data_dir / "directions.json").exists())
            self.assertTrue((data_dir / "calendar.json").exists())
            self.assertTrue((data_dir / "shapes.json").exists())

            route_schedule_path = data_dir / manifest["scheduleFiles"]["R/1"]
            self.assertTrue(route_schedule_path.exists())
            self.assertEqual(json.loads(route_schedule_path.read_text(encoding="utf-8")), schedules["R/1"])
            self.assertEqual(json.loads((data_dir / manifest["scheduleFiles"]["R2"]).read_text(encoding="utf-8")), {})


if __name__ == "__main__":
    unittest.main()
