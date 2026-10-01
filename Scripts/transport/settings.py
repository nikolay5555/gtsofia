"""Static configuration for the GT Sofia data pipeline."""

from pathlib import Path

GTFS_URL = "https://gtfs.sofiatraffic.bg/api/v1/static"

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
GTFS_DIR = ROOT / ".gtfs"
CALENDAR_CONFIG_FILE = ROOT / "config" / "calendar.json"
LINE_OVERRIDES_CONFIG_FILE = ROOT / "config" / "line-overrides.json"

OSM_NETWORK_NAME = "Градски транспорт София"
OSM_CACHE_FILE = DATA_DIR / "osm" / "stops.json"
OSM_ENDPOINTS = (
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
)

OSM_STOPS_TYPES = [
    {"type": "subway", "public_transport": "station"},
    {"type": "tram", "public_transport": "stop_position"},
    {"type": "bus", "public_transport": "platform"},
    {"type": "trolleybus", "public_transport": "platform"},
]

GTFS_WEEKDAY_FIELDS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)
