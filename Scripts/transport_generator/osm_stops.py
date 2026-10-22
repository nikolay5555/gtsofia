"""OpenStreetMap stop-name enrichment, following Sofiatraffic-schedules semantics.

OSM is the preferred source for public-facing stop names and stop-specific
metadata. Official CGM GTFS remains the fallback and the source for routes,
trips, and timetable data. A checked-in cache keeps data generation resilient
when an Overpass instance is temporarily unavailable.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

from .common import ROOT, normalize, normalize_stop_id
from .stops import build_stop_index

OSM_NETWORK_NAME = "Градски транспорт София"
OSM_STOPS_TYPES = (
    ("subway", "station"),
    ("tram", "stop_position"),
    ("bus", "platform"),
    ("trolleybus", "platform"),
)
OVERPASS_ENDPOINTS = (
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
)
OSM_CACHE_FILE = ROOT / "config" / "osm-stops-cache.json"
OSM_REQUEST_TIMEOUT_SECONDS = 60

# Keep this transliteration compatible with Sofiatraffic-schedules.
_CYRILLIC = "А,Б,В,Г,Д,Е,Ж,З,И,Й,К,Л,М,Н,О,П,Р,С,Т,У,Ф,Х,Ц,Ч,Ш,Щ,Ъ,Ь,Ю,Я".split(",")
_LATIN = "A,B,V,G,D,E,ZH,Z,I,Y,K,L,M,N,O,P,R,S,T,U,F,H,TS,CH,SH,SHT,A,A,YU,YA".split(",")


def transliterate(text):
    """Transliterate Bulgarian text using the same mapping as Dimitar's app."""
    text = normalize(text)
    if len(_CYRILLIC) != len(_LATIN):
        raise RuntimeError("Cyrillic and Latin transliteration maps must have equal lengths")

    result = []
    for char in text:
        index = _CYRILLIC.index(char.upper()) if char.upper() in _CYRILLIC else -1
        if index < 0:
            result.append(char)
            continue
        latin_char = _LATIN[index]
        result.append(latin_char.lower() if char == char.lower() else latin_char)
    return "".join(result)


def normalize_osm_code(ref, is_subway=False):
    """Use the same stop-code convention as Sofiatraffic-schedules."""
    ref = normalize(ref)
    if not ref:
        return ""
    if is_subway:
        return f"M{ref}"
    return ref.zfill(4)


def gtfs_stop_code(stop):
    """Return the display code used to merge OSM refs with official GTFS stops."""
    stop_id = normalize(stop.get("stop_id"))
    if stop_id.upper().startswith("M"):
        return stop_id

    stop_code = normalize(stop.get("stop_code"))
    if stop_code:
        return stop_code.zfill(4)

    # A few GTFS rows have no stop_code. Retain the existing ID normalization
    # as the last resort rather than losing a possible match.
    return normalize_stop_id(stop_id)


def _overpass_query():
    elements = "".join(
        f'node[{tag}=yes][public_transport={public_transport}]'
        f'[ref][network="{OSM_NETWORK_NAME}"];'
        for tag, public_transport in OSM_STOPS_TYPES
    )
    return f"[out:json][timeout:45];({elements});out geom;"


def _record_from_element(element):
    tags = element.get("tags") or {}
    code = normalize_osm_code(
        tags.get("ref"),
        is_subway=normalize(tags.get("subway")).lower() == "yes",
    )
    bg_name = normalize(tags.get("name"))

    # A stop without a name must not replace a useful public-facing GTFS name.
    if not code or not bg_name:
        return None

    en_name = normalize(tags.get("name:en")) or transliterate(bg_name)
    record = {
        "code": code,
        "names": {
            "bg": bg_name,
            "en": en_name,
        },
        "osm_type": normalize(element.get("type")),
        "osm_id": element.get("id"),
        "_public_transport": normalize(tags.get("public_transport")),
    }

    for tag, field in (
        ("short_name:bg", "bg_short"),
        ("short_name:en", "en_short"),
        ("full_name:bg", "bg_full"),
        ("full_name:en", "en_full"),
    ):
        value = normalize(tags.get(tag))
        if value:
            record["names"][field] = value

    for tag, field in (
        ("local_ref", "local_ref"),
        ("local_ref:metro", "metro_ref"),
    ):
        value = normalize(tags.get(tag))
        if value:
            record[field] = value

    if normalize(tags.get("request_stop")).lower() == "yes":
        record["request_stop"] = True

    return record


def _deduplicate_osm_stops(records):
    """Prefer platform records on duplicate refs, matching the source project."""
    order = {"stop_position": 1, "platform": 2}
    records = sorted(
        records,
        key=lambda record: order.get(record.get("_public_transport", ""), 999),
    )
    by_code = {}
    for record in records:
        by_code[record["code"]] = record
    for record in by_code.values():
        record.pop("_public_transport", None)
    return list(by_code.values())


def parse_osm_response(payload):
    """Parse an Overpass JSON response into one preferred record per stop code."""
    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
        raise ValueError("Overpass response does not contain an elements array")
    if payload.get("remark"):
        raise ValueError(f"Overpass returned a partial/error response: {payload['remark']}")

    records = []
    for element in payload["elements"]:
        if not isinstance(element, dict):
            continue
        record = _record_from_element(element)
        if record:
            records.append(record)

    records = _deduplicate_osm_stops(records)
    if not records:
        raise ValueError("Overpass returned no usable named stops")
    return records


def fetch_osm_stops():
    """Query OSM via Overpass, retrying a second public instance if needed."""
    query = _overpass_query()
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    errors = []

    for endpoint in OVERPASS_ENDPOINTS:
        request = urllib.request.Request(
            endpoint,
            data=body,
            method="POST",
            headers={
                "User-Agent": "GTSofia/1.0 (+https://github.com/nikolay5555/gtsofia)",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            },
        )
        try:
            with urllib.request.urlopen(
                request,
                timeout=OSM_REQUEST_TIMEOUT_SECONDS,
            ) as response:
                payload = json.loads(response.read().decode("utf-8"))
            return parse_osm_response(payload)
        except (OSError, urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
            errors.append(f"{endpoint}: {error}")

    raise RuntimeError("All Overpass endpoints failed: " + " | ".join(errors))


def load_osm_stop_cache():
    """Read cached OSM names; invalid/missing cache behaves as an empty cache."""
    try:
        with OSM_CACHE_FILE.open("r", encoding="utf-8") as file:
            payload = json.load(file)
    except FileNotFoundError:
        return []
    except (OSError, json.JSONDecodeError) as error:
        print(f"WARNING: Could not read OSM stop-name cache: {error}")
        return []

    records = payload.get("stops") if isinstance(payload, dict) else None
    if not isinstance(records, list):
        print("WARNING: OSM stop-name cache has an invalid structure")
        return []

    # Cache entries intentionally only contain normalized names and metadata;
    # parse them through the same deduplicator for consistent matching.
    clean = []
    for record in records:
        if not isinstance(record, dict):
            continue
        code = normalize(record.get("code"))
        names = record.get("names")
        if not code or not isinstance(names, dict) or not normalize(names.get("bg")):
            continue
        entry = {
            "code": code,
            "names": {
                "bg": normalize(names.get("bg")),
                "en": normalize(names.get("en")) or transliterate(names.get("bg")),
            },
        }
        for field in ("bg_short", "en_short", "bg_full", "en_full"):
            value = normalize(names.get(field))
            if value:
                entry["names"][field] = value
        for field in ("local_ref", "metro_ref", "osm_type", "osm_id"):
            value = record.get(field)
            if value is not None and normalize(value) != "":
                entry[field] = value if field == "osm_id" else normalize(value)
        if record.get("request_stop") is True:
            entry["request_stop"] = True
        clean.append(entry)

    return _deduplicate_osm_stops(clean)


def save_osm_stop_cache(records, updated_at=None):
    """Persist a successful live OSM result as the next-run fallback cache."""
    OSM_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    serializable = []
    for record in records:
        clean = {key: value for key, value in record.items() if not key.startswith("_")}
        serializable.append(clean)

    payload = {
        "schemaVersion": 1,
        "source": "OpenStreetMap via Overpass API",
        "updatedAt": updated_at or date.today().isoformat(),
        "stops": serializable,
    }
    temporary = OSM_CACHE_FILE.with_suffix(OSM_CACHE_FILE.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, separators=(",", ":"))
        file.write("\n")
    temporary.replace(OSM_CACHE_FILE)


def get_osm_stop_data():
    """Get live OSM stop names or fall back to the last known cache."""
    try:
        records = fetch_osm_stops()
        # Guard against a nominally successful but suspiciously tiny response
        # (for example, a temporary Overpass partial result).
        if len(records) < 100:
            raise RuntimeError(f"Overpass returned only {len(records)} named stops")
        print(f"OpenStreetMap: fetched {len(records)} named stops from Overpass")
        return records, "live"
    except Exception as error:  # External data source must not break GTFS generation.
        print(f"WARNING: OpenStreetMap fetch failed; trying cached stop names: {error}")
        records = load_osm_stop_cache()
        if records:
            print(f"OpenStreetMap: using {len(records)} cached stop-name records")
            return records, "cache"
        print("WARNING: No OSM cache available; using official GTFS stop names")
        return [], "gtfs"


def apply_osm_stop_names(stops, osm_records):
    """Apply OSM names/metadata to GTFS rows and rebuild the ID index.

    The original GTFS fields remain present. `stop_name` becomes the preferred
    Bulgarian display name, while `names` stores Bulgarian/English and optional
    short/full variants for use across pages and future localization.
    """
    osm_by_code = {
        normalize(record.get("code")): record
        for record in osm_records
        if normalize(record.get("code"))
    }

    enriched = []
    osm_matches = 0
    renamed = 0
    for original in stops:
        stop = dict(original)
        official_name = normalize(stop.get("stop_name"))
        record = osm_by_code.get(gtfs_stop_code(stop))
        names = record.get("names", {}) if record else {}
        bg_name = normalize(names.get("bg")) or official_name
        en_name = normalize(names.get("en")) or transliterate(bg_name)

        stop["names"] = {
            "bg": bg_name,
            "en": en_name,
        }
        for field in ("bg_short", "en_short", "bg_full", "en_full"):
            value = normalize(names.get(field))
            if value:
                stop["names"][field] = value

        if bg_name:
            stop["stop_name"] = bg_name
        if record:
            osm_matches += 1
            if bg_name != official_name:
                renamed += 1
            for field in ("local_ref", "metro_ref", "osm_type", "osm_id"):
                value = record.get(field)
                if value is not None and normalize(value) != "":
                    stop[field] = value
            if record.get("request_stop") is True:
                stop["request_stop"] = True

        enriched.append(stop)

    return enriched, build_stop_index(enriched), {
        "matches": osm_matches,
        "renamed": renamed,
    }
