"""Project-wide paths and constants for the GTFS generator."""

import json
from pathlib import Path

GTFS_URL = "https://gtfs.sofiatraffic.bg/api/v1/static"

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
GTFS_DIR = ROOT / ".gtfs"
OUTPUT_MANIFEST_FILE = DATA_DIR / "manifest.json"

CORE_OUTPUT_FILES = {
    "meta": DATA_DIR / "meta.json",
    "calendar": DATA_DIR / "calendar.json",
    "routes": DATA_DIR / "routes.json",
    "stops": DATA_DIR / "stops.json",
    "trips": DATA_DIR / "trips.json",
    "directions": DATA_DIR / "directions.json",
}

SHAPES_OUTPUT_PREFIX = "shapes"
SCHEDULES_OUTPUT_PREFIX = "schedules"
OUTPUT_CHUNK_COUNT = 4

CALENDAR_CONFIG_FILE = ROOT / "config" / "calendar.json"
LINE_OVERRIDES_CONFIG_FILE = ROOT / "config" / "line-overrides.json"

OSM_NETWORK_NAME = "Градски транспорт София"

OSM_STOPS_TYPES = [
    {"type": "subway", "public_transport": "station"},
    {"type": "tram", "public_transport": "stop_position"},
    {"type": "bus", "public_transport": "platform"},
    {"type": "trolleybus", "public_transport": "platform"},
]

SOFIA_TIME_ZONE_NAME = "Europe/Sofia"

GTFS_WEEKDAY_FIELDS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)


def load_line_overrides():
    if not LINE_OVERRIDES_CONFIG_FILE.exists():
        return []

    with LINE_OVERRIDES_CONFIG_FILE.open("r", encoding="utf-8") as file:
        data = json.load(file)

    if not isinstance(data, list):
        raise ValueError("config/line-overrides.json must contain an array.")

    return data
