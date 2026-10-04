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


def build_stops(stops_data):
    result = []
    for row in stops_data:
        original_id = normalize(row.get("stop_id"))
        normalized_id = normalize_stop_id(original_id)
        if not normalized_id:
            continue
        stop = dict(row)
        stop["stop_id"] = normalized_id
        stop["stop_name"] = normalize_display_name(stop.get("stop_name"))
        if stop.get("stop_code"):
            stop["stop_code"] = normalize(stop.get("stop_code")).zfill(4) if not normalized_id.startswith("M") else normalize(stop.get("stop_code"))
        result.append(stop)
    return result, build_stop_index(result)


def build_public_stops(stops):
    """Produce the compact Dimitar-style stops.json list."""
    public = []
    seen = set()
    for stop in stops:
        code = normalize(stop.get("stop_id"))
        if not code or code in seen:
            continue
        if normalize(stop.get("location_type") or "0") != "0":
            continue
        try:
            lat = float(stop.get("stop_lat"))
            lon = float(stop.get("stop_lon"))
        except (TypeError, ValueError):
            continue
        name = normalize_display_name(stop.get("stop_name"))
        if not name:
            continue
        seen.add(code)
        item = {"code": code, "coords": [lat, lon], "names": {"bg": name}}
        public.append(item)
    return public
