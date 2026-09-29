"""GTFS + OSM stop normalization stage."""

import csv
import json
import urllib.parse
import urllib.request

from .config import GTFS_DIR, OSM_NETWORK_NAME, OSM_STOPS_TYPES
from .utils import (
    normalize,
    normalize_stop_id,
    round_coordinate,
    transliterate,
)

def fetch_osm_stops():
    """
    Python equivalent of Dimitar5555's fetch_osm_stops().

    OSM is used only to improve/complete stop metadata.
    It does NOT replace GTFS geometry or schedules.
    """

    elements = "".join(
        (
            f'node[{item["type"]}=yes]'
            f'[public_transport={item["public_transport"]}]'
            f'[ref]'
            f'[network="{OSM_NETWORK_NAME}"];'
        )
        for item in OSM_STOPS_TYPES
    )

    query = (
        "[out:json][timeout:25];"
        f"({elements});"
        "out geom;"
    )

    body = urllib.parse.urlencode(
        {
            "data": query
        }
    ).encode(
        "utf-8"
    )

    request = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=body,
        method="POST",
        headers={
            "Referer":
                "https://overpass-turbo.eu/",

            "User-Agent":
                "github/nikolay5555/gtsofia"
        }
    )

    try:

        with urllib.request.urlopen(
            request,
            timeout=90
        ) as response:

            payload = response.read()

        data = json.loads(
            payload.decode(
                "utf-8"
            )
        )

    except Exception as error:

        print(
            "WARNING: OSM stop fetch failed:"
        )

        print(
            f"  {error}"
        )

        print(
            "Continuing with GTFS stop names."
        )

        return {}

    elements_data = data.get(
        "elements",
        []
    )

    result = {}

    for element in elements_data:

        tags = element.get(
            "tags",
            {}
        )

        ref = normalize(
            tags.get(
                "ref"
            )
        )

        if not ref:
            continue

        if (
            tags.get(
                "subway"
            )
            == "yes"
        ):

            code = (
                "M"
                + ref
            )

        else:

            code = ref.zfill(
                4
            )

        name_bg = normalize(
            tags.get(
                "name"
            )
        )

        name_en = normalize(
            tags.get(
                "name:en"
            )
        )

        if not name_en:
            name_en = transliterate(
                name_bg
            )

        result[
            code
        ] = {
            "code":
                code,

            "name":
                name_bg,

            "name_en":
                name_en,

            "lat":
                round_coordinate(
                    element.get(
                        "lat"
                    )
                ),

            "lon":
                round_coordinate(
                    element.get(
                        "lon"
                    )
                ),
        }

    print(
        "OSM stops fetched: "
        f"{len(result)}"
    )

    return result

def merge_osm_stop_names(
    stops,
    osm_stops
):
    """
    Preserve the current transport.json structure.

    For matching stop codes:
        OSM name -> preferred
        GTFS name -> fallback

    The rest of the GTFS stop record remains unchanged.
    """

    if not osm_stops:
        return stops

    updated = []

    matched = 0

    for stop in stops:

        stop_copy = dict(
            stop
        )

        stop_id = normalize(
            stop_copy.get(
                "stop_id"
            )
        )

        osm_stop = osm_stops.get(
            stop_id
        )

        if osm_stop:

            matched += 1

            osm_name = normalize(
                osm_stop.get(
                    "name"
                )
            )

            if osm_name:
                stop_copy[
                    "stop_name"
                ] = osm_name

            osm_name_en = normalize(
                osm_stop.get(
                    "name_en"
                )
            )

            if osm_name_en:

                stop_copy[
                    "stop_name_en"
                ] = osm_name_en

        updated.append(
            stop_copy
        )

    print(
        "GTFS stops matched with OSM: "
        f"{matched}"
    )

    return updated

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
    stops_data
):
    """
    Build a canonical stop collection keyed by normalized stop_id.

    The raw GTFS feed can contain duplicate IDs for parent/station records
    and physical boarding stops. Keep exactly one best public record per ID
    in the normalized output, while preserving the source rows internally
    only for the duration of generation.
    """

    by_id = {}

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

        stop = dict(row)
        stop["stop_id"] = normalized_id

        current = by_id.get(normalized_id)
        if current is None or stop_preference_score(stop) > stop_preference_score(current):
            by_id[normalized_id] = stop

    result = [
        by_id[stop_id]
        for stop_id in sorted(by_id)
    ]

    return result, by_id
