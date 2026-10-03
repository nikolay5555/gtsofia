import json
import urllib.parse
import urllib.request

from .common import normalize
from .stops import round_coordinate, transliterate_bulgarian


OSM_ENDPOINTS = (
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
)
OSM_NETWORK_NAME = "Градски транспорт София"
OSM_STOP_TYPES = (
    ("subway", "station"),
    ("tram", "stop_position"),
    ("bus", "platform"),
    ("trolleybus", "platform"),
)


def build_osm_query():
    elements = "".join(
        f'node[{transport_type}=yes][public_transport={public_transport}]'
        f'[ref][network="{OSM_NETWORK_NAME}"];'
        for transport_type, public_transport in OSM_STOP_TYPES
    )
    return f'[out:json][timeout:60];({elements});out geom;'


def _osm_code(tags):
    raw_ref = normalize(tags.get("ref"))
    if not raw_ref:
        return ""

    if normalize(tags.get("subway")).lower() == "yes":
        # Preserve the current M-prefixed metro identifiers exactly.
        return f"M{raw_ref}"

    return raw_ref.zfill(4)


def _build_model_stop(element):
    tags = element.get("tags") or {}
    code = _osm_code(tags)
    if not code:
        return None

    lat = round_coordinate(element.get("lat"))
    lon = round_coordinate(element.get("lon"))
    if lat is None or lon is None:
        return None

    bg_name = normalize(tags.get("name"))
    en_name = normalize(tags.get("name:en")) or transliterate_bulgarian(bg_name)

    stop = {
        "code": code,
        "coords": [lat, lon],
        "names": {
            "bg": bg_name,
            "en": en_name,
        },
    }

    if normalize(tags.get("short_name:bg")):
        stop["names"]["bg_short"] = normalize(tags["short_name:bg"])
    if normalize(tags.get("short_name:en")):
        stop["names"]["en_short"] = normalize(tags["short_name:en"])
    if normalize(tags.get("full_name:bg")):
        stop["names"]["bg_full"] = normalize(tags["full_name:bg"])
    if normalize(tags.get("full_name:en")):
        stop["names"]["en_full"] = normalize(tags["full_name:en"])
    if normalize(tags.get("request_stop")).lower() == "yes":
        stop["request_stop"] = True
    if normalize(tags.get("local_ref")):
        stop["local_ref"] = normalize(tags["local_ref"])
    if normalize(tags.get("local_ref:metro")):
        stop["metro_ref"] = normalize(tags["local_ref:metro"])

    return stop


def fetch_osm_stops():
    query = build_osm_query()
    payload = urllib.parse.urlencode({"data": query}).encode("utf-8")
    request = urllib.request.Request(
        OSM_ENDPOINT,
        data=payload,
        headers={
            "User-Agent": "github/nikolay5555/gtsofia",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )

    last_error = None

    for endpoint in OSM_ENDPOINTS:
        try:
            request = urllib.request.Request(
                endpoint,
                data=payload,
                headers={
                    "User-Agent": "github/nikolay5555/gtsofia",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
            )

            print(f"Fetching OSM stops from {endpoint}...")
            with urllib.request.urlopen(request, timeout=90) as response:
                data = json.load(response)
            break
        except Exception as exc:
            last_error = exc
            print(f"Warning: OSM endpoint failed: {endpoint}: {exc}")
    else:
        raise RuntimeError(
            f"All OSM endpoints failed; last error: {last_error}"
        )

    elements = data.get("elements", [])

    # Match Dimitar's deterministic duplicate handling:
    # stop_position first, platform second, so platform wins when both
    # describe the same public stop code.
    osm_order = {
        "stop_position": 1,
        "platform": 2,
    }
    elements.sort(
        key=lambda element: osm_order.get(
            normalize((element.get("tags") or {}).get("public_transport")),
            999,
        )
    )

    stops = []

    for element in elements:
        stop = _build_model_stop(element)
        if stop is not None:
            stops.append(stop)

    print(f"OSM stops: {len(stops)}")
    return stops


def merge_stops(osm_stops, gtfs_stops):
    merged = {}

    # OSM is authoritative for matching codes. GTFS fills gaps that
    # are not represented in OpenStreetMap.
    for stop in osm_stops:
        merged[normalize(stop.get("code"))] = stop

    for stop in gtfs_stops:
        code = normalize(stop.get("code"))
        if code and code not in merged:
            merged[code] = stop

    return list(merged.values())
