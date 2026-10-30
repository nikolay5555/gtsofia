"""OpenStreetMap stop-name enrichment."""
import json
import urllib.request
from urllib.parse import urlencode

from .config import (
    OSM_URL, OSM_NETWORK_NAME, OSM_STOP_TYPES,
    normalize, normalize_osm_stop_code, normalize_stop_id,
)

def fetch_osm_stops():
    """Fetch public transport stop names from OSM; GTFS remains the fallback."""

    elements = "".join(
        f'node[{transport_type}=yes][public_transport={public_transport}]'
        f'[ref][network="{OSM_NETWORK_NAME}"];'
        for transport_type, public_transport in OSM_STOP_TYPES
    )
    query = (
        "[out:json][timeout:50];"
        f"({elements});"
        "out body;"
    )
    request = urllib.request.Request(
        OSM_URL,
        data=urlencode({"data": query}).encode("utf-8"),
        headers={
            "User-Agent": "GTSofia transport data generator",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=70) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as error:
        # A temporary Overpass outage must not prevent the core GTFS data
        # from being generated. All display names will then fall back to GTFS.
        print(f"WARNING: Could not fetch OSM stop names: {error}")
        return {}

    elements = payload.get("elements", [])

    # Match Dimitar's preference for platform objects over stop positions
    # when both OSM objects share the same public stop code.
    priority = {
        "station": 0,
        "stop_position": 1,
        "platform": 2,
    }
    elements.sort(
        key=lambda element: priority.get(
            normalize((element.get("tags") or {}).get("public_transport")),
            99,
        )
    )

    result = {}

    for element in elements:
        tags = element.get("tags") or {}
        code = normalize_osm_stop_code(tags)

        if not code:
            continue

        name = normalize(tags.get("name") or tags.get("name:bg"))
        name_en = normalize(tags.get("name:en"))

        # Keep the record even if OSM has no name: a later GTFS fallback is
        # still possible and the extra OSM references can be useful metadata.
        result[code] = {
            "osm_stop_name": name,
            "osm_stop_name_en": name_en,
            "osm_short_name_bg": normalize(tags.get("short_name:bg")),
            "osm_short_name_en": normalize(tags.get("short_name:en")),
            "osm_full_name_bg": normalize(tags.get("full_name:bg")),
            "osm_full_name_en": normalize(tags.get("full_name:en")),
            "osm_local_ref": normalize(tags.get("local_ref")),
            "osm_metro_ref": normalize(tags.get("local_ref:metro")),
            "osm_request_stop": normalize(tags.get("request_stop")).lower() == "yes",
            "osm_type": normalize(element.get("type")),
            "osm_id": normalize(element.get("id")),
        }

    print(f"OSM stops with public refs: {len(result)}")
    return result


def enrich_stops_with_osm(stops_data, osm_stops):
    """Prefer OSM's public-facing Bulgarian name, preserving GTFS as fallback."""

    enriched = []

    for original in stops_data:
        row = dict(original)
        gtfs_name = normalize(row.get("stop_name"))
        row["gtfs_stop_name"] = gtfs_name

        stop_id = normalize_stop_id(row.get("stop_id"))
        stop_code = normalize_stop_id(row.get("stop_code"))
        osm = osm_stops.get(stop_id) or osm_stops.get(stop_code) or {}
        osm_name = normalize(osm.get("osm_stop_name"))

        row.update(osm)
        row["osm_stop_name"] = osm_name
        row["stop_name"] = osm_name or gtfs_name
        row["stop_name_source"] = "osm" if osm_name else "gtfs"

        enriched.append(row)

    return enriched

