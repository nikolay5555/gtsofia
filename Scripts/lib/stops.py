"""GTFS stops enriched from OpenStreetMap, with GTFS fallback."""

import json
import urllib.parse
import urllib.request

from .common import normalize, normalize_stop_id

OSM_NETWORK_NAME = "Градски транспорт София"
OSM_ENDPOINTS = (
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
)

def _normalize_osm_ref(value, is_subway=False):
    value = normalize(value)
    if not value:
        return ""
    if is_subway and not value.upper().startswith("M"):
        digits = "".join(char for char in value if char.isdigit())
        return f"M{digits}" if digits else ""
    return normalize_stop_id(value)


def transliterate(text):
    """Transliterate Bulgarian names the same way as the reference project."""
    cyrillic = "А,Б,В,Г,Д,Е,Ж,З,И,Й,К,Л,М,Н,О,П,Р,С,Т,У,Ф,Х,Ц,Ч,Ш,Щ,Ъ,Ь,Ю,Я".split(",")
    latin = "A,B,V,G,D,E,ZH,Z,I,Y,K,L,M,N,O,P,R,S,T,U,F,H,TS,CH,SH,SHT,A,A,YU,YA".split(",")
    mapping = dict(zip(cyrillic, latin))
    result = []
    for char in str(text or ""):
        converted = mapping.get(char.upper())
        if converted is None:
            result.append(char)
        else:
            result.append(converted.lower() if char.islower() else converted)
    return "".join(result)

def fetch_osm_stops(timeout=35):
    """Return stop data indexed by normalized code; return {} on OSM failure.

    Mirrors Dimitar's OSM selection (subway stations, tram stop positions and
    bus/trolleybus platforms). GTFS remains the fallback for every unmatched
    stop and when Overpass is temporarily unavailable.
    """
    selectors = (
        f'node[subway=yes][public_transport=station][ref][network="{OSM_NETWORK_NAME}"];',
        f'node[tram=yes][public_transport=stop_position][ref][network="{OSM_NETWORK_NAME}"];',
        f'node[bus=yes][public_transport=platform][ref][network="{OSM_NETWORK_NAME}"];',
        f'node[trolleybus=yes][public_transport=platform][ref][network="{OSM_NETWORK_NAME}"];',
    )
    query = '[out:json][timeout:30];(' + ''.join(selectors) + ');out body;'
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_error = None
    payload = None
    for endpoint in OSM_ENDPOINTS:
        try:
            request = urllib.request.Request(
                endpoint, data=body, method="POST",
                headers={"User-Agent": "GTSofia/1.0 (+https://github.com/)",
                         "Content-Type": "application/x-www-form-urlencoded"},
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
            break
        except Exception as error:  # Network failures must not break the GTFS update.
            last_error = error
            payload = None
    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
        print(f"Warning: OSM stops unavailable; using GTFS names/coordinates. ({last_error})")
        return {}

    # Match Dimitar's precedence for duplicate refs: stop_position is loaded
    # first, then platform; therefore platform wins when both have the same ref.
    rank = {"stop_position": 1, "platform": 2, "station": 3}
    elements = sorted(
        payload["elements"],
        key=lambda item: rank.get(
            item.get("tags", {}).get("public_transport", ""), 999
        ),
    )
    result = {}
    for element in elements:
        tags = element.get("tags") or {}
        code = _normalize_osm_ref(tags.get("ref"), tags.get("subway") == "yes")
        if not code:
            continue
        try:
            lat = float(element.get("lat"))
            lon = float(element.get("lon"))
        except (TypeError, ValueError):
            lat = lon = None
        name_bg = normalize(tags.get("name:bg") or tags.get("name"))
        name_en = normalize(tags.get("name:en")) or transliterate(name_bg)
        stop = {"stop_name": name_bg, "stop_name_en": name_en}
        if lat is not None and lon is not None:
            stop["stop_lat"] = f"{lat:.5f}"
            stop["stop_lon"] = f"{lon:.5f}"
        for source_key, output_key in (
            ("short_name:bg", "stop_name_bg_short"),
            ("short_name:en", "stop_name_en_short"),
            ("full_name:bg", "stop_name_bg_full"),
            ("full_name:en", "stop_name_en_full"),
            ("local_ref", "local_ref"),
            ("local_ref:metro", "metro_ref"),
        ):
            value = normalize(tags.get(source_key))
            if value:
                stop[output_key] = value
        if tags.get("request_stop") == "yes":
            stop["request_stop"] = True
        # Empty OSM names do not override a usable fallback.
        previous = result.get(code, {})
        result[code] = {**previous, **{k: v for k, v in stop.items() if v not in ("", None)}}
    print(f"OSM stops matched: {len(result)}")
    return result

def stop_preference_score(stop):
    """
    Score duplicate GTFS stop records for lookup by stop_id.

    GTFS feeds can contain more than one record with the same stop_id,
    especially when station/parent records are mixed with physical stops.
    For route display we prefer a record that has a real public-facing name
    and code. A physical stop (location_type=0) is preferred as a final
    tie-breaker.
    """

    stop_name = normalize(stop.get("stop_name"))
    stop_code = normalize(stop.get("stop_code"))
    location_type = normalize(stop.get("location_type"))

    return (
        bool(stop_name),
        bool(stop_code),
        location_type == "0",
    )

def build_stop_index(stops):
    """
    Build a stop_id -> stop lookup without letting a later duplicate
    overwrite a better record.
    """

    by_id = {}

    for stop in stops:
        stop_id = normalize(stop.get("stop_id"))

        if not stop_id:
            continue

        current = by_id.get(stop_id)

        if current is None or stop_preference_score(stop) > stop_preference_score(current):
            by_id[stop_id] = stop

    return by_id

def build_stops(
    stops_data,
    osm_stops=None
):
    """
    Preserve the GTFS schema and normalized IDs while enriching matched stops.

    OSM names, translated labels and coordinates take precedence wherever the
    normalized stop code matches. Any missing OSM value falls back to GTFS.
    Duplicate stop_ids remain in the output, while lookups prefer the most
    useful public stop record.
    """

    result = []
    osm_stops = osm_stops if osm_stops is not None else fetch_osm_stops()

    for row in stops_data:

        original_id = normalize(
            row.get(
                "stop_id"
            )
        )

        normalized_id = normalize_stop_id(
            original_id
        )

        if not normalized_id:
            continue

        stop = dict(
            row
        )

        stop[
            "stop_id"
        ] = normalized_id

        # OSM supplies the public-facing stop name and coordinates where a
        # stop code matches; all remaining fields and unmatched records fall
        # back to the official GTFS row.
        osm = osm_stops.get(normalized_id, {})
        for field in (
            "stop_name", "stop_name_en", "stop_name_bg_short",
            "stop_name_en_short", "stop_name_bg_full", "stop_name_en_full",
            "local_ref", "metro_ref", "request_stop", "stop_lat", "stop_lon",
        ):
            if osm.get(field) not in (None, ""):
                stop[field] = osm[field]
        if not normalize(stop.get("stop_name_en")) and normalize(stop.get("stop_name")):
            stop["stop_name_en"] = transliterate(stop["stop_name"])

        result.append(
            stop
        )

    return (
        result,
        build_stop_index(result)
    )
