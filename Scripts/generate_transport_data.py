#!/usr/bin/env python3
"""Generate GTSofia's canonical schedule data.

The schedule pipeline follows the data model and transformation order used by
Dimitar5555's sofiatraffic-schedules project:

GTFS/OSM -> routes/stops -> unique directions -> logical trips -> stop_times.

The only application-specific addition is realtime-trip-map.json, which keeps
an exact mapping from the original GTFS trip_id to the logical trip/direction
used by the frontend virtual board.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import shutil
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
GTFS_DIR = ROOT / ".gtfs"
DATA_DIR = ROOT / "data"
CONFIG_DIR = ROOT / "config"
GTFS_URL = "https://gtfs.sofiatraffic.bg/api/v1/static"
OVERPASS_URL = "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
OSM_NETWORK_NAME = "Градски транспорт София"
SOFIA_TZ = ZoneInfo("Europe/Sofia")
APP_VERSION = datetime.now(ZoneInfo("Europe/Sofia")).date().isoformat()

OSM_STOP_TYPES = [
    {"type": "subway", "public_transport": "station"},
    {"type": "tram", "public_transport": "stop_position"},
    {"type": "bus", "public_transport": "platform"},
    {"type": "trolleybus", "public_transport": "platform"},
]

TYPE_MAPPING = {
    "0": "tram",
    "1": "metro",
    "3": "bus",
    "11": "trolley",
}

GTFS_WEEKDAY_FIELDS = (
    "monday", "tuesday", "wednesday", "thursday",
    "friday", "saturday", "sunday",
)

HOLIDAY_MM_DD = {
    "01-01", "03-03", "05-01", "05-06", "05-24",
    "09-06", "09-22", "11-01", "12-24", "12-25", "12-26",
}


def normalize(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def parse_date(value: str) -> date | None:
    value = normalize(value)
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y%m%d").date()
    except ValueError:
        return None


def parse_time(value: str) -> int | None:
    value = normalize(value)
    if not value:
        return None
    try:
        h, m, s = [int(part) for part in value.split(":")]
        return h * 3600 + m * 60 + s
    except (TypeError, ValueError):
        return None


def pad_stop_id(value: Any) -> str:
    """Dimitar-compatible stop identifier normalization.

    This is deliberately applied to the *application stop code* layer, not
    exposed as a GTFS feed rewrite. Metro IDs keep their M-prefix; surface
    stop identifiers become four-digit public codes.
    """
    raw = normalize(value)
    if not raw:
        return ""
    if raw.startswith("M"):
        return raw
    digits = "".join(ch for ch in raw if ch.isdigit())
    return digits.zfill(4) if digits else ""


def current_date() -> date:
    return datetime.now(SOFIA_TZ).date()


def date_iso(value: date) -> str:
    return value.isoformat()


def load_calendar_config() -> dict[str, Any]:
    path = CONFIG_DIR / "calendar.json"
    if not path.exists():
        return {"dateOverrides": {}}
    with path.open("r", encoding="utf-8") as fh:
        config = json.load(fh)
    if not isinstance(config, dict):
        raise ValueError("config/calendar.json must contain an object")
    overrides = config.get("dateOverrides", {})
    if not isinstance(overrides, dict):
        raise ValueError("config/calendar.json dateOverrides must be an object")
    normalized: dict[str, str] = {}
    for raw_key, raw_value in overrides.items():
        try:
            key = datetime.strptime(str(raw_key), "%Y-%m-%d").date().isoformat()
        except ValueError as exc:
            raise ValueError(f"Invalid calendar override date: {raw_key}") from exc
        value = normalize(raw_value).lower()
        if value not in {"weekday", "weekend"}:
            raise ValueError(f"Invalid calendar override type for {raw_key}: {raw_value}")
        normalized[key] = value
    return {"dateOverrides": normalized}


def is_weekend(day: date, config: dict[str, Any]) -> bool:
    if day.weekday() >= 5:
        result = True
    else:
        result = day.strftime("%m-%d") in HOLIDAY_MM_DD
    override = config.get("dateOverrides", {}).get(day.isoformat())
    if override == "weekday":
        return False
    if override == "weekend":
        return True
    return result


def reset_output_dirs() -> None:
    for folder in (GTFS_DIR, DATA_DIR):
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir(parents=True, exist_ok=True)


def download_gtfs() -> None:
    request = urllib.request.Request(
        GTFS_URL,
        headers={"User-Agent": "GTSofia/2.0"},
    )
    print(f"Downloading GTFS: {GTFS_URL}")
    with urllib.request.urlopen(request, timeout=600) as response:
        payload = response.read()
    if not payload.startswith(b"PK"):
        raise RuntimeError("GTFS endpoint did not return a ZIP archive")
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        archive.extractall(GTFS_DIR)
    print(f"GTFS downloaded: {len(payload) / 1024 / 1024:.2f} MB")


def read_csv(filename: str) -> list[dict[str, str]]:
    path = GTFS_DIR / filename
    if not path.exists():
        raise FileNotFoundError(path)
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def get_active_service_ids(calendar_dates: list[dict[str, str]], config: dict[str, Any]) -> dict[str, bool]:
    """Mirror Dimitar's next-15-day active-service classification."""
    today = current_date()
    end = today + timedelta(days=15)
    buckets: dict[str, dict[str, int]] = defaultdict(lambda: {"weekday": 0, "weekend": 0})

    if calendar_dates:
        for row in calendar_dates:
            if normalize(row.get("exception_type")) != "1":
                continue
            day = parse_date(row.get("date", ""))
            if day is None or not today <= day <= end:
                continue
            service_id = normalize(row.get("service_id"))
            if not service_id:
                continue
            day_type = "weekend" if is_weekend(day, config) else "weekday"
            buckets[service_id][day_type] += 1

    # A feed is allowed to rely on calendar.txt without calendar_dates.txt.
    # Keep the same two-bucket application model in that case.
    if not buckets:
        calendar = read_csv("calendar.txt") if (GTFS_DIR / "calendar.txt").exists() else []
        current = today
        while current <= end:
            field = GTFS_WEEKDAY_FIELDS[current.weekday()]
            day_type = "weekend" if is_weekend(current, config) else "weekday"
            for row in calendar:
                start = parse_date(row.get("start_date", ""))
                finish = parse_date(row.get("end_date", ""))
                if start is None or finish is None or not start <= current <= finish:
                    continue
                if normalize(row.get(field)) == "1":
                    service_id = normalize(row.get("service_id"))
                    if service_id:
                        buckets[service_id][day_type] += 1
            current += timedelta(days=1)

    result = {}
    for service_id, counts in buckets.items():
        result[service_id] = counts["weekend"] >= counts["weekday"]
    return result


def determine_route_ref(ref: str) -> str:
    ref = normalize(ref)
    number = "".join(ch for ch in ref if not (ch.isalpha() or ("А" <= ch <= "я")))
    upper = ref.upper()
    if upper.startswith(("E", "Е")):
        return number
    if upper.startswith("N"):
        return f"N{number}"
    if upper.startswith("Y"):
        return f"У{number}"
    if upper.endswith(("ТБ", "TB")):
        return f"{number}ТБ"
    if upper.endswith(("ТМ", "TM", "Т", "T")):
        return f"{number}ТМ"
    return upper


def determine_route_type(route_ref: str, route_type: str) -> str:
    if (
        route_ref.endswith(("ТБ", "ТМ"))
        or (route_ref.startswith("М") and route_type == "bus")
    ):
        return "bus"
    try:
        sort_ref = int("".join(ch for ch in route_ref if ch.isdigit()) or "0")
    except ValueError:
        sort_ref = 0
    if sort_ref >= 50 and route_type == "trolley":
        return "bus"
    return route_type


def build_routes(rows: list[dict[str, str]], active_service_ids: dict[str, bool]) -> list[dict[str, Any]]:
    all_routes = []
    for row in rows:
        route_ref = determine_route_ref(row.get("route_short_name", ""))
        route_type = TYPE_MAPPING.get(normalize(row.get("route_type")))
        if not route_type:
            continue
        route_type = determine_route_type(route_ref, route_type)
        route = {
            "cgm_id": normalize(row.get("route_id")),
            "route_ref": route_ref,
            "type": route_type,
        }
        if route_type == "metro":
            if normalize(row.get("route_text_color")):
                route["text_color"] = normalize(row.get("route_text_color"))
            if normalize(row.get("route_color")):
                route["bg_color"] = normalize(row.get("route_color"))
        all_routes.append(route)

    trips = read_csv("trips.txt")
    active_route_ids = {
        normalize(trip.get("route_id"))
        for trip in trips
        if normalize(trip.get("service_id")) in active_service_ids
    }
    return [route for route in all_routes if route["cgm_id"] in active_route_ids]


def round_coords(lat: Any, lon: Any) -> list[float]:
    return [round(float(lat), 5), round(float(lon), 5)]


def transliterate(text: str) -> str:
    cyrillic = "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯ"
    latin = "ABVGDEZHZIYKLMNOPRSTUFHTSCHSHSHTAAYUYA"
    mapping = dict(zip(cyrillic, latin))
    out = []
    for char in text:
        upper = char.upper()
        repl = mapping.get(upper)
        if repl is None:
            out.append(char)
        else:
            out.append(repl.lower() if char.islower() else repl)
    return "".join(out)


def overpass_query() -> str:
    elements = "".join(
        f'node[{item["type"]}=yes][public_transport={item["public_transport"]}][ref][network="{OSM_NETWORK_NAME}"];'
        for item in OSM_STOP_TYPES
    )
    return f"[out:json][timeout:25];({elements});out geom;"


def fetch_osm_stops() -> list[dict[str, Any]]:
    payload = urllib.parse.urlencode({"data": overpass_query()}).encode()
    request = urllib.request.Request(
        OVERPASS_URL,
        data=payload,
        headers={"User-Agent": "github/gtsofia"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        data = json.load(response)

    result = []
    for item in data.get("elements", []):
        tags = item.get("tags") or {}
        if not tags.get("ref"):
            continue
        code = str(tags["ref"])
        if tags.get("subway") == "yes":
            code = f"M{code}"
        else:
            code = code.zfill(4)
        result.append({
            "code": code,
            "coords": round_coords(item.get("lat"), item.get("lon")),
            "names": {
                "bg": normalize(tags.get("name")),
                "en": normalize(tags.get("name:en")) or transliterate(normalize(tags.get("name"))),
            },
            "_public_transport": normalize(tags.get("public_transport")),
            "_osm": f"{item.get('type','node')}/{item.get('id','')}",
            "_tags": tags,
        })
    return result


def fetch_gtfs_stops() -> list[dict[str, Any]]:
    result = []
    for row in read_csv("stops.txt"):
        stop_id = normalize(row.get("stop_id"))
        stop_code = normalize(row.get("stop_code"))
        code = stop_id if stop_id.startswith("M") else stop_code.zfill(4)
        if not code:
            continue
        result.append({
            "code": code,
            "coords": round_coords(row.get("stop_lat"), row.get("stop_lon")),
            "names": {
                "bg": normalize(row.get("stop_name")),
                "en": transliterate(normalize(row.get("stop_name"))),
            },
        })
    return result


def merge_stops(osm_stops: list[dict[str, Any]], gtfs_stops: list[dict[str, Any]]) -> list[dict[str, Any]]:
    order = {"stop_position": 1, "platform": 2}
    osm_stops.sort(key=lambda s: order.get(s.get("_public_transport", ""), 999))
    merged: dict[str, dict[str, Any]] = {}
    for stop in osm_stops:
        code = stop["code"]
        public = dict(stop)
        tags = public.pop("_tags", {})
        public.pop("_public_transport", None)
        public.pop("_osm", None)
        if tags.get("name:en"):
            public["names"]["en"] = tags["name:en"]
        if tags.get("short_name:bg"):
            public["names"]["bg_short"] = tags["short_name:bg"]
        if tags.get("short_name:en"):
            public["names"]["en_short"] = tags["short_name:en"]
        if tags.get("full_name:bg"):
            public["names"]["bg_full"] = tags["full_name:bg"]
        if tags.get("full_name:en"):
            public["names"]["en_full"] = tags["full_name:en"]
        if tags.get("request_stop") == "yes":
            public["request_stop"] = True
        if tags.get("local_ref"):
            public["local_ref"] = tags["local_ref"]
        if tags.get("local_ref:metro"):
            public["metro_ref"] = tags["local_ref:metro"]
        merged[code] = public

    for stop in gtfs_stops:
        if stop["code"] in merged:
            if not merged[stop["code"]]["names"].get("en"):
                merged[stop["code"]]["names"]["en"] = transliterate(merged[stop["code"]]["names"].get("bg", ""))
        else:
            merged[stop["code"]] = stop
    return list(merged.values())


def build_directions_and_schedules(
    routes: list[dict[str, Any]],
    trips_rows: list[dict[str, str]],
    stop_time_rows: list[dict[str, str]],
    active_service_ids: dict[str, bool],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, Any]]]:
    gtfs_trips = [
        row for row in trips_rows
        if normalize(row.get("service_id")) in active_service_ids
    ]
    active_trip_ids = {normalize(row.get("trip_id")) for row in gtfs_trips}

    stop_times_by_trip: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in stop_time_rows:
        trip_id = normalize(row.get("trip_id"))
        if not trip_id or trip_id not in active_trip_ids:
            continue
        stop_id = pad_stop_id(row.get("stop_id"))
        if not stop_id:
            continue
        try:
            sequence = int(normalize(row.get("stop_sequence")) or "0")
        except ValueError:
            sequence = 0
        stop_times_by_trip[trip_id].append({
            "stop_id": stop_id,
            "sequence": sequence,
            "arrival_time": normalize(row.get("arrival_time")),
            "departure_time": normalize(row.get("departure_time")),
        })
    for rows in stop_times_by_trip.values():
        rows.sort(key=lambda item: item["sequence"])

    directions: list[dict[str, Any]] = []
    route_direction_map: dict[str, set[int]] = defaultdict(set)
    logical_trips: list[dict[str, Any]] = []
    stop_times: list[dict[str, Any]] = []
    original_trip_meta: dict[str, dict[str, Any]] = {}

    for trip in gtfs_trips:
        trip_id = normalize(trip.get("trip_id"))
        route_id = normalize(trip.get("route_id"))
        service_id = normalize(trip.get("service_id"))
        trip_stops = stop_times_by_trip.get(trip_id, [])
        if not trip_id or not route_id or not trip_stops:
            continue
        stop_pattern = [item["stop_id"] for item in trip_stops]

        corresponding_direction = None
        for direction in directions:
            if direction["code"] not in route_direction_map[route_id]:
                continue
            if direction["stops"] == stop_pattern:
                corresponding_direction = direction
                break
        if corresponding_direction is None:
            corresponding_direction = {
                "code": len(directions) + 1,
                "stops": list(stop_pattern),
            }
            directions.append(corresponding_direction)
            route_direction_map[route_id].add(corresponding_direction["code"])

        direction_code = corresponding_direction["code"]
        is_weekend_trip = active_service_ids[service_id]
        matching_trip = next(
            (
                logical for logical in logical_trips
                if logical["cgm_id"] == route_id
                and logical["direction"] == direction_code
                and logical["is_weekend"] == is_weekend_trip
            ),
            None,
        )
        if matching_trip is None:
            matching_trip = {
                "id": len(logical_trips) + 1,
                "cgm_id": route_id,
                "direction": direction_code,
                "is_weekend": is_weekend_trip,
                "_original_trip_ids": [],
            }
            logical_trips.append(matching_trip)
        matching_trip["_original_trip_ids"].append(trip_id)

        car = ""
        pieces = trip_id.split("-")
        if trip_id.startswith("M"):
            if len(pieces) > 2:
                car = pieces[2]
        elif len(pieces) >= 3:
            car = pieces[-3]

        times: list[int | None] = []
        sequences: list[int] = []
        for item in trip_stops:
            parsed = parse_time(item.get("departure_time")) or parse_time(item.get("arrival_time"))
            times.append(None if parsed is None else parsed // 60)
            sequences.append(int(item["sequence"]))

        stop_times.append({
            "trip": matching_trip["id"],
            "times": times,
            "car": car,
        })
        original_trip_meta[trip_id] = {
            "route_id": route_id,
            "direction_id": normalize(trip.get("direction_id")),
            "service_id": service_id,
            "trip_headsign": normalize(trip.get("trip_headsign")),
            "shape_id": normalize(trip.get("shape_id")),
            "wheelchair_accessible": normalize(trip.get("wheelchair_accessible")),
            "bikes_allowed": normalize(trip.get("bikes_allowed")),
            "logical_trip": matching_trip,
            "original_direction_code": direction_code,
            "stop_sequences": sequences,
        }

    # Merge partial directions using Dimitar's original algorithm.
    for route in routes:
        route_id = route["cgm_id"]
        route_trips = [trip for trip in logical_trips if trip["cgm_id"] == route_id]
        direction_ids = {trip["direction"] for trip in route_trips}
        route_dirs = [d for d in directions if d["code"] in direction_ids]
        route_dirs.sort(key=lambda d: len(d["stops"]), reverse=True)
        deleted: set[int] = set()

        for index1, child in enumerate(route_dirs):
            if child["code"] in deleted:
                continue
            child_string = ",".join(child["stops"])
            parent = None
            for index2, candidate in enumerate(route_dirs):
                if index1 == index2 or candidate["code"] in deleted:
                    continue
                if child_string in ",".join(candidate["stops"]):
                    parent = candidate
                    break
            if parent is None:
                continue

            try:
                beg = parent["stops"].index(child["stops"][0])
            except (ValueError, IndexError):
                continue
            end = len(parent["stops"]) - beg - len(child["stops"])
            deleted.add(child["code"])

            for logical in logical_trips:
                if logical["direction"] != child["code"]:
                    continue
                for item in stop_times:
                    if item["trip"] != logical["id"]:
                        continue
                    item["times"] = [None] * beg + item["times"] + [None] * end
                logical["direction"] = parent["code"]

        directions[:] = [d for d in directions if d["code"] not in deleted]
        # Merge logical trips with the same route/direction/day bucket.
        route_trips_after = [trip for trip in logical_trips if trip["cgm_id"] == route_id]
        for index1, trip in enumerate(route_trips_after):
            if trip.get("_deleted"):
                continue
            same = None
            for index2, candidate in enumerate(route_trips_after):
                if index1 == index2 or candidate.get("_deleted"):
                    continue
                if candidate["direction"] != trip["direction"]:
                    continue
                if candidate["is_weekend"] != trip["is_weekend"]:
                    continue
                same = candidate
                break
            if same is None:
                continue
            for item in stop_times:
                if item["trip"] == trip["id"]:
                    item["trip"] = same["id"]
            same["_original_trip_ids"].extend(trip.get("_original_trip_ids", []))
            trip["_deleted"] = True

    logical_trips[:] = [trip for trip in logical_trips if not trip.get("_deleted")]

    # Re-resolve each raw trip to the final logical trip/direction.
    raw_to_logical: dict[str, dict[str, Any]] = {}
    for logical in logical_trips:
        for raw_id in logical.get("_original_trip_ids", []):
            meta = original_trip_meta.get(raw_id, {})
            raw_to_logical[raw_id] = {
                "route_id": meta.get("route_id", logical["cgm_id"]),
                "direction_code": logical["direction"],
                "logical_trip_id": logical["id"],
                "is_weekend": logical["is_weekend"],
                "service_id": meta.get("service_id", ""),
                "direction_id": meta.get("direction_id", ""),
                "trip_headsign": meta.get("trip_headsign", ""),
                "shape_id": meta.get("shape_id", ""),
                "wheelchair_accessible": meta.get("wheelchair_accessible", ""),
                "bikes_allowed": meta.get("bikes_allowed", ""),
                "stop_sequences": meta.get("stop_sequences", []),
            }

    for logical in logical_trips:
        logical.pop("_original_trip_ids", None)
        logical.pop("_deleted", None)

    return directions, logical_trips, stop_times, raw_to_logical


def build_calendar_output(active_service_ids: dict[str, bool], config: dict[str, Any], calendar_dates: list[dict[str, str]]) -> dict[str, Any]:
    today = current_date()
    end = today + timedelta(days=15)
    date_types: dict[str, str] = {}
    service_ids_by_date: dict[str, list[str]] = {}

    calendar = read_csv("calendar.txt") if (GTFS_DIR / "calendar.txt").exists() else []
    calendar_by_service = {normalize(row.get("service_id")): row for row in calendar if normalize(row.get("service_id"))}
    exceptions: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in calendar_dates:
        day = parse_date(row.get("date", ""))
        if day is not None and today <= day <= end:
            exceptions[date_iso(day)].append(dict(row))

    day = today
    while day <= end:
        date_key = date_iso(day)
        dtype = "weekend" if is_weekend(day, config) else "weekday"
        date_types[date_key] = dtype
        base = set()
        field = GTFS_WEEKDAY_FIELDS[day.weekday()]
        for sid, row in calendar_by_service.items():
            start = parse_date(row.get("start_date", ""))
            finish = parse_date(row.get("end_date", ""))
            if start is not None and finish is not None and start <= day <= finish and normalize(row.get(field)) == "1":
                base.add(sid)
        for row in exceptions.get(date_key, []):
            sid = normalize(row.get("service_id"))
            if normalize(row.get("exception_type")) == "1":
                base.add(sid)
            elif normalize(row.get("exception_type")) == "2":
                base.discard(sid)
        service_ids_by_date[date_key] = sorted(base)
        day += timedelta(days=1)

    return {
        "referenceDate": date_iso(today),
        "endDate": date_iso(end),
        "dateTypes": date_types,
        "serviceIdsByDate": service_ids_by_date,
        "config": config,
        "activeServiceIds": active_service_ids,
    }


def write_json(name: str, value: Any) -> None:
    (DATA_DIR / f"{name}.json").write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_metadata() -> None:
    hashes = {}
    for name in [
        "routes", "stops", "directions", "trips", "stop_times",
        "active_service_ids", "realtime-trip-map", "calendar", "shapes",
    ]:
        path = DATA_DIR / f"{name}.json"
        if path.exists():
            hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    write_json("metadata", {
        "app_version": APP_VERSION,
        "retrieval_date": date_iso(current_date()),
        "hashes": hashes,
    })


def run() -> None:
    reset_output_dirs()
    config = load_calendar_config()
    download_gtfs()

    calendar_dates = read_csv("calendar_dates.txt") if (GTFS_DIR / "calendar_dates.txt").exists() else []
    active_service_ids = get_active_service_ids(calendar_dates, config)
    write_json("active_service_ids", active_service_ids)

    route_rows = read_csv("routes.txt")
    routes = build_routes(route_rows, active_service_ids)

    print("Fetching OSM stops...")
    try:
        osm_stops = fetch_osm_stops()
        print(f"OSM stops: {len(osm_stops)}")
    except Exception as exc:
        print(f"WARNING: OSM stop import failed: {exc}")
        osm_stops = []
    gtfs_stops = fetch_gtfs_stops()
    stops = merge_stops(osm_stops, gtfs_stops)

    trips_rows = read_csv("trips.txt")
    stop_time_rows = read_csv("stop_times.txt")
    directions, trips, stop_times, realtime_trip_map = build_directions_and_schedules(
        routes, trips_rows, stop_time_rows, active_service_ids
    )

    # Only keep stops actually referenced by the surviving directions, exactly
    # like 05-filter-stops.js.
    used_codes = {code for direction in directions for code in direction["stops"]}
    stops = [stop for stop in stops if stop["code"] in used_codes]

    write_json("routes", routes)
    write_json("stops", stops)
    write_json("directions", directions)
    write_json("trips", trips)
    write_json("stop_times", stop_times)
    write_json("realtime-trip-map", realtime_trip_map)
    write_json("calendar", build_calendar_output(active_service_ids, config, calendar_dates))

    # Shapes are ancillary to the schedule engine, but keeping them available
    # preserves the older project's map-data capability without embedding them
    # into the main schedule bundle.
    shapes_path = GTFS_DIR / "shapes.txt"
    if shapes_path.exists():
        shape_rows = read_csv("shapes.txt")
        selected_shapes = {
            normalize(t.get("shape_id"))
            for t in trips_rows
            if normalize(t.get("service_id")) in active_service_ids
            and normalize(t.get("shape_id"))
        }
        shapes: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in shape_rows:
            sid = normalize(row.get("shape_id"))
            if sid not in selected_shapes:
                continue
            try:
                seq = int(normalize(row.get("shape_pt_sequence")) or "0")
                lat = float(row.get("shape_pt_lat"))
                lon = float(row.get("shape_pt_lon"))
            except (TypeError, ValueError):
                continue
            shapes[sid].append({"seq": seq, "lat": lat, "lon": lon})
        for value in shapes.values():
            value.sort(key=lambda item: item["seq"])
        write_json("shapes", shapes)
    else:
        write_json("shapes", {})

    write_metadata()
    print(
        "Generated: "
        f"{len(routes)} routes, {len(stops)} stops, "
        f"{len(directions)} directions, {len(trips)} logical trips, "
        f"{len(stop_times)} stop-time rows, {len(realtime_trip_map)} realtime trips"
    )


if __name__ == "__main__":
    run()
