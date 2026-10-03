from datetime import datetime
import json
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT / "data"
GTFS_DIR = ROOT / ".gtfs"
CALENDAR_CONFIG_FILE = ROOT / "config" / "calendar.json"
LINE_OVERRIDES_CONFIG_FILE = ROOT / "config" / "line-overrides.json"

GTFS_URL = "https://gtfs.sofiatraffic.bg/api/v1/static"
SOFIA_TIME_ZONE = ZoneInfo("Europe/Sofia")

GTFS_WEEKDAY_FIELDS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)

def normalize(value):
    return str(value).strip() if value is not None else ""

def normalize_stop_id(value):
    value = normalize(value)
    if not value:
        return ""
    if value.startswith("M"):
        return value
    digits = "".join(char for char in value if char.isdigit())
    return digits.zfill(4)

def parse_date(value):
    value = normalize(value)
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y%m%d").date()
    except ValueError:
        return None

def parse_time(value):
    value = normalize(value)
    if not value:
        return None
    try:
        hours, minutes, seconds = map(int, value.split(":"))
        return hours * 3600 + minutes * 60 + seconds
    except (TypeError, ValueError):
        return None

def get_today():
    return datetime.now(SOFIA_TIME_ZONE).date()

def gtfs_date_string(current):
    return current.strftime("%Y%m%d")

def iso_date_string(current):
    return current.isoformat()

def load_line_overrides():
    if not LINE_OVERRIDES_CONFIG_FILE.exists():
        return []
    with LINE_OVERRIDES_CONFIG_FILE.open("r", encoding="utf-8") as file:
        data = json.load(file)
    if not isinstance(data, list):
        raise ValueError("config/line-overrides.json must contain an array.")
    return data

def load_calendar_config(path=CALENDAR_CONFIG_FILE):
    if not path.exists():
        return {"dateOverrides": {}}
    with path.open("r", encoding="utf-8") as file:
        raw = json.load(file)
    if not isinstance(raw, dict):
        raise ValueError("Calendar config must be a JSON object.")
    overrides = raw.get("dateOverrides", {})
    if not isinstance(overrides, dict):
        raise ValueError("calendar.json dateOverrides must be an object.")
    normalized_overrides = {}
    for raw_date, raw_day_type in overrides.items():
        date_value = parse_date(raw_date.replace("-", ""))
        if date_value is None:
            raise ValueError(f"Invalid calendar override date: {raw_date}")
        day_type = normalize(raw_day_type).lower()
        if day_type not in {"weekday", "weekend"}:
            raise ValueError(
                f"Invalid calendar override type for {raw_date}: {raw_day_type}"
            )
        normalized_overrides[iso_date_string(date_value)] = day_type
    return {"dateOverrides": normalized_overrides}

def write_json(path, data):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
        file.write("\n")
