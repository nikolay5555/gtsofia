"""OpenStreetMap stop import and OSM-first stop merging."""

import json
import urllib.parse
import urllib.request

from transport.settings import (
    OSM_CACHE_FILE,
    OSM_ENDPOINTS,
    OSM_NETWORK_NAME,
    OSM_STOPS_TYPES,
)
from transport.utils import (
    normalize,
    normalize_stop_code,
    round_coordinate,
    transliterate,
)


def validate_osm_stop_names(tags, ref, element):
    """Mirror Dimitar's validation of OSM name tags."""
    if tags.get("short_name"):
        print(
            "WARNING: stop with ref "
            f"{ref} has an unqualified short_name tag "
            f"(node {element.get('id')})."
        )
    if tags.get("full_name"):
        print(
            "WARNING: stop with ref "
            f"{ref} has an unqualified full_name tag "
            f"(node {element.get('id')})."
        )

    supported_languages = {"bg", "en"}
    keys = set(tags)
    names = {key for key in keys if key == "name" or key.startswith("name:")}
    short_names = {key for key in keys if key.startswith("short_name:")}
    full_names = {key for key in keys if key.startswith("full_name:")}
    ignore_keys = {"int_name", "old_name", "noname"}
    other_names = {
        key for key in keys
        if (
            "name" in key
            and key not in short_names
            and key not in full_names
            and key not in names
            and key not in ignore_keys
        )
    }
    if other_names:
        print(
            "WARNING: stop with ref "
            f"{ref} has unsupported name tags: "
            f"{', '.join(sorted(other_names))}"
        )
    unsupported_languages = {
        (key.split(":", 1)[1] if ":" in key else "bg")
        for key in names | short_names | full_names
    } - supported_languages
    if unsupported_languages:
        print(
            "WARNING: stop with ref "
            f"{ref} has unsupported languages: "
            f"{', '.join(sorted(unsupported_languages))}"
        )


def _cache_osm_stops(stops):
    OSM_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with OSM_CACHE_FILE.open("w", encoding="utf-8") as file:
        json.dump(list(stops.values()), file, ensure_ascii=False, separators=(",", ":"))


def _load_cached_osm_stops():
    if not OSM_CACHE_FILE.exists():
        return {}
    try:
        with OSM_CACHE_FILE.open("r", encoding="utf-8") as file:
            rows = json.load(file)
    except (OSError, ValueError) as error:
        print(f"WARNING: OSM cache could not be read: {error}")
        return {}
    result = {}
    for row in rows if isinstance(rows, list) else []:
        code = normalize(row.get("code"))
        if code:
            result[code] = row
    return result


def _build_osm_query():
    elements = "".join(
        (
            f'node[{item["type"]}=yes]'
            f'[public_transport={item["public_transport"]}]'
            f'[ref]'
            f'[network="{OSM_NETWORK_NAME}"];'
        )
        for item in OSM_STOPS_TYPES
    )
    return "[out:json][timeout:25];" f"({elements});" "out geom;"


def _request_osm(query):
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_error = None
    for endpoint in OSM_ENDPOINTS:
        request = urllib.request.Request(
            endpoint,
            data=body,
            method="POST",
            headers={
                "User-Agent": "github/nikolay5555/gtsofia",
                "Referer": "https://overpass-turbo.eu/",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                payload = response.read()
            data = json.loads(payload.decode("utf-8"))
            elements = data.get("elements")
            if not isinstance(elements, list):
                raise RuntimeError("Overpass response has no elements array")
            print(f"OSM source: {endpoint}")
            return elements
        except Exception as error:
            last_error = error
            print(f"WARNING: OSM endpoint failed: {endpoint}")
            print(f"  {error}")
    raise RuntimeError(f"All OSM endpoints failed: {last_error}")


def fetch_osm_stops():
    """Fetch stop metadata from OSM; use the saved OSM snapshot only on outage."""
    print("Fetching OSM stop names...")
    query = _build_osm_query()
    try:
        elements = _request_osm(query)
    except RuntimeError as error:
        cached = _load_cached_osm_stops()
        if cached:
            print(f"WARNING: using cached OSM stops: {len(cached)}")
            return cached
        raise RuntimeError(
            "OSM stop data is unavailable and no OSM cache exists. "
            "Refusing to silently replace OSM names with GTFS names."
        ) from error

    result = {}
    for element in elements:
        tags = element.get("tags", {})
        ref = normalize(tags.get("ref"))
        if not ref:
            continue
        validate_osm_stop_names(tags, ref, element)
        is_subway = tags.get("subway") == "yes"
        code = f"M{ref}" if is_subway else ref.zfill(4)
        name_bg = normalize(tags.get("name"))
        name_en = normalize(tags.get("name:en")) or transliterate(name_bg)
        names = {"bg": name_bg, "en": name_en}
        for target_key, source_key in (
            ("bg_short", "short_name:bg"),
            ("en_short", "short_name:en"),
            ("bg_full", "full_name:bg"),
            ("en_full", "full_name:en"),
        ):
            value = normalize(tags.get(source_key))
            if value:
                names[target_key] = value
        stop = {
            "code": code,
            "coords": [round_coordinate(element.get("lat")), round_coordinate(element.get("lon"))],
            "names": names,
            "_osm_public_transport": normalize(tags.get("public_transport")),
        }
        if tags.get("request_stop") == "yes":
            stop["request_stop"] = True
        if tags.get("local_ref"):
            stop["local_ref"] = normalize(tags.get("local_ref"))
        if tags.get("local_ref:metro"):
            stop["metro_ref"] = normalize(tags.get("local_ref:metro"))

        # Match Dimitar's duplicate resolution: stop_position < platform.
        priority = {"stop_position": 1, "platform": 2, "station": 3}.get(
            stop["_osm_public_transport"], 0
        )
        stop["_osm_priority"] = priority
        existing = result.get(code)
        if existing is None or priority >= existing.get("_osm_priority", -1):
            result[code] = stop

    _cache_osm_stops(result)
    print(f"OSM stops fetched: {len(result)}")
    return result


def _gtfs_stop_to_canonical(stop):
    stop_copy = dict(stop)
    code = normalize_stop_code(stop_copy.get("stop_id"), stop_copy.get("stop_code"))
    if not code:
        return None
    stop_copy["stop_id"] = code
    stop_copy["stop_code"] = code
    bg = normalize(stop_copy.get("stop_name"))
    en = normalize(stop_copy.get("stop_name_en")) or transliterate(bg)
    stop_copy["names"] = {"bg": bg, "en": en}
    if not normalize(stop_copy.get("stop_lat")) or not normalize(stop_copy.get("stop_lon")):
        stop_copy["_coords"] = None
    else:
        stop_copy["_coords"] = [round_coordinate(stop_copy.get("stop_lat")), round_coordinate(stop_copy.get("stop_lon"))]
    return stop_copy


def _stop_preference_score(stop):
    stop_name = normalize(stop.get("stop_name"))
    stop_code = normalize(stop.get("stop_code"))
    location_type = normalize(stop.get("location_type"))
    return (bool(stop_name), bool(stop_code), location_type == "0")


def merge_osm_stop_names(stops, osm_stops):
    """Apply Dimitar's OSM-first merge while retaining GTFS compatibility fields."""
    gtfs_by_code = {}
    for raw_stop in stops:
        stop = _gtfs_stop_to_canonical(raw_stop)
        if stop is None:
            continue
        code = stop["stop_id"]
        current = gtfs_by_code.get(code)
        if current is None or _stop_preference_score(stop) > _stop_preference_score(current):
            gtfs_by_code[code] = stop

    merged = []
    matched = 0
    osm_only = 0
    for code, osm_stop in osm_stops.items():
        existing = gtfs_by_code.pop(code, None)
        if existing is not None:
            matched += 1
            combined = dict(existing)
        else:
            osm_only += 1
            combined = {
                "stop_id": code,
                "stop_code": code,
                "stop_desc": "",
                "location_type": "1" if osm_stop.get("_osm_public_transport") == "station" else "0",
                "parent_station": "",
                "stop_timezone": "",
                "level_id": "",
            }

        osm_names = dict(osm_stop.get("names") or {})
        gtfs_names = combined.get("names") or {}
        if not osm_names.get("bg"):
            osm_names["bg"] = normalize(gtfs_names.get("bg"))
        if not osm_names.get("en"):
            osm_names["en"] = transliterate(osm_names.get("bg") or "")

        combined["names"] = osm_names
        combined["stop_name"] = osm_names.get("bg", "")
        combined["stop_name_en"] = osm_names.get("en", "")
        combined["name_source"] = "osm" if normalize(osm_stop.get("names", {}).get("bg")) else "gtfs"

        coords = osm_stop.get("coords")
        if coords and coords[0] is not None and coords[1] is not None:
            combined["stop_lat"] = str(coords[0])
            combined["stop_lon"] = str(coords[1])
            combined["_coords"] = list(coords)
        for key in ("request_stop", "local_ref", "metro_ref"):
            if key in osm_stop:
                combined[key] = osm_stop[key]
        combined.pop("_osm_priority", None)
        combined.pop("_osm_public_transport", None)
        merged.append(combined)

    for stop in gtfs_by_code.values():
        stop["name_source"] = "gtfs"
        merged.append(stop)

    print(f"GTFS stops matched with OSM: {matched}")
    print(f"OSM-only stops added: {osm_only}")
    print(f"Canonical stops after merge: {len(merged)}")
    return merged


# Backward-compatible public helper used by tests.
stop_preference_score = _stop_preference_score
