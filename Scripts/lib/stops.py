
from .common import normalize, normalize_stop_id


def stop_preference_score(stop):
    return (
        bool(normalize(stop.get("stop_name"))),
        bool(normalize(stop.get("stop_code"))),
        normalize(stop.get("location_type")) == "0",
    )


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


def build_stop_code_map(stops_data):
    result = {}
    for row in stops_data:
        gtfs_stop_id = normalize(row.get("stop_id"))
        if not gtfs_stop_id:
            continue
        public_code = normalize_stop_id(
            row.get("stop_code") or gtfs_stop_id
        )
        if public_code:
            result[gtfs_stop_id] = public_code
    return result


def build_stops(stops_data):
    result = []
    for row in stops_data:
        original_id = normalize(row.get("stop_id"))
        normalized_id = normalize_stop_id(
            row.get("stop_code") or original_id
        )
        if not normalized_id:
            continue
        stop = dict(row)
        stop["stop_id"] = normalized_id
        result.append(stop)
    return result, build_stop_index(result)


CYRILLIC_TO_LATIN = dict(
    zip(
        "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯ",
        [
            "A", "B", "V", "G", "D", "E", "ZH", "Z", "I", "Y",
            "K", "L", "M", "N", "O", "P", "R", "S", "T", "U",
            "F", "H", "TS", "CH", "SH", "SHT", "A", "A", "YU", "YA"
        ],
    )
)


def transliterate_bulgarian(text):
    text = normalize(text)
    result = []
    for char in text:
        upper = char.upper()
        replacement = CYRILLIC_TO_LATIN.get(upper)
        if replacement is None:
            result.append(char)
            continue
        result.append(
            replacement.lower()
            if char == char.lower()
            else replacement
        )
    return "".join(result)


def round_coordinate(value):
    try:
        return round(float(value), 5)
    except (TypeError, ValueError):
        return None


def build_model_stops(output_stops, used_stop_ids=None):
    result = []
    used_stop_ids = used_stop_ids or {
        normalize(stop.get("stop_id"))
        for stop in output_stops
    }

    for stop in output_stops:
        stop_id = normalize(stop.get("stop_id"))
        if stop_id not in used_stop_ids:
            continue

        lat = round_coordinate(stop.get("stop_lat"))
        lon = round_coordinate(stop.get("stop_lon"))
        if lat is None or lon is None:
            continue

        bg_name = normalize(stop.get("stop_name"))
        result.append({
            "code": stop_id,
            "coords": [lat, lon],
            "names": {
                "bg": bg_name,
                "en": transliterate_bulgarian(bg_name),
            },
        })
    return result
