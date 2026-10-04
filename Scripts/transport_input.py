from __future__ import annotations

import io
import json
import shutil
import urllib.request
import zipfile
from pathlib import Path

from transport_common import normalize, parse_date

GTFS_URL = "https://gtfs.sofiatraffic.bg/api/v1/static"


def download_gtfs(gtfs_dir: Path):
    print(f"Downloading official GTFS: {GTFS_URL}")
    request = urllib.request.Request(GTFS_URL, headers={"User-Agent": "GTSofia/1.0"})
    with urllib.request.urlopen(request, timeout=600) as response:
        payload = response.read()
    if not payload.startswith(b"PK"):
        raise RuntimeError("GTFS endpoint did not return a ZIP archive.")

    if gtfs_dir.exists():
        shutil.rmtree(gtfs_dir)
    gtfs_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = {Path(name).name for name in archive.namelist()}
        required = {"routes.txt", "stops.txt", "trips.txt", "stop_times.txt"}
        missing = required - names
        if missing:
            raise RuntimeError("GTFS archive is missing required files: " + ", ".join(sorted(missing)))
        if "calendar.txt" not in names and "calendar_dates.txt" not in names:
            raise RuntimeError("GTFS archive must contain calendar.txt or calendar_dates.txt.")
        archive.extractall(gtfs_dir)


def read_csv(gtfs_dir: Path, filename: str):
    import csv
    path = gtfs_dir / filename
    if not path.exists():
        raise FileNotFoundError(f"Missing GTFS file: {path}")
    with path.open("r", encoding="utf-8-sig", newline="") as file:
        return list(csv.DictReader(file))


def load_config(path: Path, default):
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as file:
        data = json.load(file)
    if not isinstance(data, type(default)):
        raise ValueError(f"Invalid JSON structure in {path}")
    return data


def load_line_overrides(path: Path):
    data = load_config(path, [])
    if not isinstance(data, list):
        raise ValueError("config/line-overrides.json must contain an array.")
    return data


def load_calendar_config(path: Path):
    data = load_config(path, {"dateOverrides": {}})
    if not isinstance(data, dict):
        raise ValueError("Calendar config must be a JSON object.")
    overrides = data.get("dateOverrides", {})
    if not isinstance(overrides, dict):
        raise ValueError("calendar.json dateOverrides must be an object.")
    normalized = {}
    for raw_date, raw_day_type in overrides.items():
        date_value = parse_date(str(raw_date).replace("-", ""))
        if date_value is None:
            raise ValueError(f"Invalid calendar override date: {raw_date}")
        day_type = normalize(raw_day_type).lower()
        if day_type not in {"weekday", "weekend"}:
            raise ValueError(f"Invalid calendar override type for {raw_date}: {raw_day_type}")
        normalized[date_value.isoformat()] = day_type
    return {"dateOverrides": normalized}
