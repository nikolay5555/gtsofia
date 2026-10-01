"""GTFS stop indexing helpers."""

from transport.osm import _gtfs_stop_to_canonical
from transport.utils import normalize
from transport.osm import _stop_preference_score as stop_preference_score


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
    result_by_code = {}
    for row in stops_data:
        stop = _gtfs_stop_to_canonical(row)
        if stop is None:
            continue
        code = stop["stop_id"]
        current = result_by_code.get(code)
        if current is None or stop_preference_score(stop) > stop_preference_score(current):
            result_by_code[code] = stop
    result = list(result_by_code.values())
    return result, build_stop_index(result)
