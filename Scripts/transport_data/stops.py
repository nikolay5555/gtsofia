"""GTFS/OSM stop merging, using OSM names with GTFS fallback."""
import json
import urllib.parse
import urllib.request
from .common import (
    OSM_STOPS_CACHE_FILE, get_today, normalize, normalize_stop_id, write_json,
)


def stop_preference_score(stop):
    """Prefer public-facing, coded stop records and physical stops."""
    stop_name = normalize(stop.get("stop_name"))
    stop_code = normalize(stop.get("stop_code"))
    location_type = normalize(stop.get("location_type"))
    return (bool(stop_name), bool(stop_code), location_type == "0")


def build_stop_index(stops):
    """Build a stop_id index without overwriting a better duplicate."""
    by_id = {}
    for stop in stops:
        stop_id = normalize(stop.get("stop_id"))
        if not stop_id:
            continue
        current = by_id.get(stop_id)
        if current is None or stop_preference_score(stop) > stop_preference_score(current):
            by_id[stop_id] = stop
    return by_id


def _osm_code(tags):
    ref = normalize(tags.get("ref"))
    if not ref:
        return ""
    if tags.get("subway") == "yes":
        return normalize_stop_id(f"M{ref}")
    return normalize_stop_id(ref)


def load_osm_stop_name_cache(path=OSM_STOPS_CACHE_FILE):
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as file:
        raw = json.load(file)
    stops = raw.get("stops", raw) if isinstance(raw, dict) else raw
    names = {}
    if isinstance(stops, dict):
        iterable = stops.items()
        for code, name in iterable:
            normalized_code = normalize_stop_id(code)
            normalized_name = normalize(name)
            if normalized_code and normalized_name:
                names[normalized_code] = normalized_name
    elif isinstance(stops, list):
        for stop in stops:
            if not isinstance(stop, dict):
                continue
            code = normalize_stop_id(stop.get("code") or stop.get("stop_id"))
            name = normalize(stop.get("name") or stop.get("stop_name"))
            if code and name:
                names[code] = name
    return names


def _fetch_osm_stop_names():
    osm_stops_types = [
        ("subway", "station"),
        ("tram", "stop_position"),
        ("bus", "platform"),
        ("trolleybus", "platform"),
    ]
    elements = "".join(
        f'node[{stop_type}=yes][public_transport={public_transport}][ref][network="Градски транспорт София"];'
        for stop_type, public_transport in osm_stops_types
    )
    query = '[out:json][timeout:25];(' + elements + ');out geom;'
    payload = urllib.parse.urlencode({"data": query}).encode("utf-8")
    request = urllib.request.Request(
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
        data=payload,
        headers={
            "User-Agent": "github/GTSofia/gtsofia",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        raw = json.loads(response.read().decode("utf-8"))

    elements = raw.get("elements", [])
    if not elements:
        raise RuntimeError("OSM Overpass returned no stop elements")

    # Follow the reference project's duplicate ordering: stop_position first,
    # platforms after it, then station records. Only named OSM objects override
    # a GTFS name; an unnamed OSM object must not erase a usable name.
    osm_order = {"stop_position": 1, "platform": 2}
    rows = []
    for element in elements:
        tags = element.get("tags") or {}
        code = _osm_code(tags)
        name = normalize(tags.get("name"))
        if not code or not name:
            continue
        rows.append({
            "code": code,
            "name": name,
            "public_transport": normalize(tags.get("public_transport")),
        })
    rows.sort(key=lambda item: osm_order.get(item["public_transport"], 999))
    names = {}
    for row in rows:
        names[row["code"]] = row["name"]

    if len(names) < 100:
        raise RuntimeError(f"OSM Overpass returned too few named stops: {len(names)}")
    return names


def fetch_osm_stop_names(cache_file=OSM_STOPS_CACHE_FILE):
    """Refresh OSM names; fall back to the last known merged name cache offline."""
    try:
        names = _fetch_osm_stop_names()
        write_json(cache_file, {
            "source": "OpenStreetMap Overpass API",
            "updatedAt": get_today().isoformat(),
            "stops": names,
        })
        print(f"OSM named stops: {len(names)} (live refresh)")
        return names
    except Exception as error:
        cached_names = load_osm_stop_name_cache(cache_file)
        if cached_names:
            print(
                "Warning: OSM refresh failed; using cached stop names "
                f"({len(cached_names)} entries): {error}"
            )
            return cached_names
        print(f"Warning: OSM unavailable and no name cache exists: {error}")
        return {}


def build_stops(stops_data, osm_stop_names=None):
    """Normalize stop IDs and apply OSM name by code, falling back to GTFS."""
    osm_stop_names = osm_stop_names or {}
    result = []
    for row in stops_data:
        original_id = normalize(row.get("stop_id"))
        normalized_id = normalize_stop_id(original_id)
        if not normalized_id:
            continue
        stop = dict(row)
        stop["stop_id"] = normalized_id
        osm_name = normalize(osm_stop_names.get(normalized_id))
        if osm_name:
            stop["stop_name"] = osm_name
        result.append(stop)
    return result, build_stop_index(result)
