from __future__ import annotations

from transport_common import normalize, normalize_display_name, normalize_stop_id


def stop_preference_score(stop):
    stop_name = normalize(stop.get("stop_name"))
    stop_code = normalize(stop.get("stop_code"))
    location_type = normalize(stop.get("location_type"))
    return (bool(stop_name), bool(stop_code), location_type == "0")


def build_stop_index(stops):
    by_id = {}
    for stop in stops:
        stop_id = normalize(stop.get("stop_id"))
        if not stop_id:
            continue
        current = by_id.get(stop_id)
        if current is None or stop_preference_score(stop) > stop_preference_score(current):
            by_id[stop_id] = stop
    return by_id


def _normalize_gtfs_stops(stops_data):
    result = []
    for row in stops_data:
        original_id = normalize(row.get("stop_id"))
        normalized_id = normalize_stop_id(original_id)
        if not normalized_id:
            continue
        stop = dict(row)
        stop["stop_id"] = normalized_id
        stop["stop_name"] = normalize_display_name(stop.get("stop_name"))
        stop["name"] = stop["stop_name"]
        if stop.get("stop_code"):
            stop["stop_code"] = normalize(stop.get("stop_code")).zfill(4) if not normalized_id.startswith("M") else normalize(stop.get("stop_code"))
        result.append(stop)
    return result


def _osm_stop_as_internal(osm_stop):
    code = normalize_stop_id(osm_stop.get("code"))
    if not code:
        return None
    coords = osm_stop.get("coords") or []
    names = osm_stop.get("names") or {}
    try:
        lat = float(coords[0])
        lon = float(coords[1])
    except (TypeError, ValueError, IndexError):
        return None
    name = normalize(names.get("bg"))
    if not name:
        return None
    return {
        "stop_id": code,
        "stop_code": code if code.startswith("M") else code.zfill(4),
        "stop_name": name,
        "name": name,
        "stop_lat": str(lat),
        "stop_lon": str(lon),
        "location_type": "0",
        "names": names,
        "request_stop": bool(osm_stop.get("request_stop")),
        "local_ref": osm_stop.get("local_ref", ""),
        "metro_ref": osm_stop.get("metro_ref", ""),
    }


def build_stops(stops_data, osm_stops=None):
    """Normalize GTFS stops and overlay exact OSM public names/coordinates.

    OSM is authoritative for matched names/coordinates, following Dimitar's
    merge policy. GTFS remains the fallback for stops not represented in OSM.
    """
    gtfs_stops = _normalize_gtfs_stops(stops_data)
    osm_internal = []
    for raw in osm_stops or []:
        item = _osm_stop_as_internal(raw)
        if item:
            osm_internal.append(item)

    osm_by_id = {stop["stop_id"]: stop for stop in osm_internal}
    merged_internal = []
    seen = set()

    # The matching Dimitar project puts OSM stops first, with stop_position
    # ahead of platform, then appends CGM-only stops.
    for gtfs_stop in gtfs_stops:
        osm_stop = osm_by_id.get(gtfs_stop["stop_id"])
        if osm_stop is None:
            continue
        merged = dict(gtfs_stop)
        merged.update({
            "stop_name": osm_stop["stop_name"],
            "name": osm_stop["stop_name"],
            "stop_lat": osm_stop["stop_lat"],
            "stop_lon": osm_stop["stop_lon"],
            "stop_code": osm_stop["stop_code"],
        })
        merged["names"] = osm_stop["names"]
        if osm_stop.get("request_stop"):
            merged["request_stop"] = True
        if osm_stop.get("local_ref"):
            merged["local_ref"] = osm_stop["local_ref"]
        if osm_stop.get("metro_ref"):
            merged["metro_ref"] = osm_stop["metro_ref"]
        merged_internal.append(merged)
        seen.add(merged["stop_id"])

    # OSM can contain valid public transport stops that the current GTFS feed
    # does not reference directly. Keep them available for later direction
    # filtering, exactly as Dimitar does before filtering by used directions.
    for osm_stop in osm_internal:
        if osm_stop["stop_id"] in seen:
            continue
        merged_internal.append(osm_stop)
        seen.add(osm_stop["stop_id"])

    for gtfs_stop in gtfs_stops:
        if gtfs_stop["stop_id"] in seen:
            continue
        merged_internal.append(gtfs_stop)
        seen.add(gtfs_stop["stop_id"])

    return merged_internal, build_stop_index(merged_internal)


def build_public_stops(stops, used_stop_ids=None):
    """Produce the compact Dimitar-style stops.json list."""
    public = []
    seen = set()
    used = {normalize(value) for value in used_stop_ids} if used_stop_ids is not None else None
    for stop in stops:
        code = normalize(stop.get("stop_id"))
        if not code or code in seen:
            continue
        if used is not None and code not in used:
            continue
        if normalize(stop.get("location_type") or "0") != "0":
            continue
        try:
            lat = float(stop.get("stop_lat"))
            lon = float(stop.get("stop_lon"))
        except (TypeError, ValueError):
            continue
        names = stop.get("names") if isinstance(stop.get("names"), dict) else {}
        name = normalize(names.get("bg")) or normalize(stop.get("stop_name"))
        if not name:
            continue
        item = {"code": code, "coords": [round(lat, 5), round(lon, 5)], "names": {"bg": name}}
        en = normalize(names.get("en"))
        if en:
            item["names"]["en"] = en
        for key in ("bg_short", "en_short", "bg_full", "en_full"):
            value = normalize(names.get(key))
            if value:
                item["names"][key] = value
        if stop.get("request_stop"):
            item["request_stop"] = True
        if stop.get("local_ref"):
            item["local_ref"] = normalize(stop.get("local_ref"))
        if stop.get("metro_ref"):
            item["metro_ref"] = normalize(stop.get("metro_ref"))
        public.append(item)
    return public
