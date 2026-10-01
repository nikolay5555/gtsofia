import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"


class DataLayoutTests(unittest.TestCase):
    def test_transport_manifest_references_split_parts(self):
        manifest_path = DATA / "transport.json"
        self.assertLess(manifest_path.stat().st_size, 100_000)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        for path in manifest["files"].values():
            if isinstance(path, dict):
                values = path.values()
            else:
                values = [path]
            for relative in values:
                self.assertTrue((DATA / relative).is_file(), relative)

    def test_stops_expose_name_provenance(self):
        stops = json.loads((DATA / "stops.json").read_text(encoding="utf-8"))
        self.assertTrue(stops)
        self.assertTrue(all(stop.get("name_source") in {"osm", "gtfs"} for stop in stops))


if __name__ == "__main__":
    unittest.main()
