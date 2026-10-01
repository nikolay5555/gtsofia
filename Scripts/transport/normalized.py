"""Compact Dimitar-compatible normalized transport model."""

from transport.routes import normalize_route_record
from transport.utils import normalize, normalize_stop_code, round_coordinate, transliterate


def build_normalized_data(
    routes_data,
    output_stops,
    directions,
    logical_trips,
    logical_stop_times,
    directions_result,
    line_overrides
):
    """Expose a compact normalized dataset alongside the legacy data model."""

    normalized_routes = []
    for route in routes_data:
        route_id = normalize(route.get("route_id"))
        if route_id not in directions_result:
            continue
        normalized_routes.append(
            normalize_route_record(route, line_overrides)
        )

    normalized_stops = []
    for stop in output_stops:
        code = normalize_stop_code(
            stop.get("stop_id"),
            stop.get("stop_code"),
        )
        if not code:
            continue

        names = dict(stop.get("names") or {})
        bg = normalize(names.get("bg")) or normalize(stop.get("stop_name"))
        en = normalize(names.get("en")) or normalize(stop.get("stop_name_en")) or transliterate(bg)
        names["bg"] = bg
        names["en"] = en

        item = {
            "code": code,
            "coords": stop.get("_coords") or [
                round_coordinate(stop.get("stop_lat")),
                round_coordinate(stop.get("stop_lon")),
            ],
            "names": names,
        }

        for key in ("request_stop", "local_ref", "metro_ref"):
            if key in stop:
                item[key] = stop[key]

        normalized_stops.append(item)

    normalized_directions = []
    active_direction_codes = set()
    for route_directions in directions_result.values():
        for direction in route_directions.values():
            code = direction.get("code")
            if code is None:
                continue
            try:
                numeric_code = int(code)
            except (TypeError, ValueError):
                numeric_code = code
            active_direction_codes.add(str(code))
            normalized_directions.append({
                "code": numeric_code,
                "stops": [
                    normalize_stop_code(stop.get("stop_id"), stop.get("stop_id"))
                    if isinstance(stop, dict)
                    else normalize_stop_code(stop, stop)
                    for stop in direction.get("stops", [])
                ],
            })

    normalized_trips = []
    normalized_trip_ids_by_key = {}
    next_normalized_trip_id = 1

    for trip in logical_trips:
        if trip.get("is_deleted"):
            continue

        direction_code = str(trip.get("direction_code", ""))
        if direction_code not in active_direction_codes:
            continue

        day_types = trip.get("day_types") or []
        if not day_types:
            day_types = [
                "weekend"
                if trip.get("is_weekend", False)
                else "weekday"
            ]

        try:
            direction_value = int(trip.get("direction_code"))
        except (TypeError, ValueError):
            direction_value = trip.get("direction_code")

        for day_type in ("weekday", "weekend"):
            if day_type not in day_types:
                continue

            key = (trip.get("id"), day_type)
            normalized_id = normalized_trip_ids_by_key.get(key)
            if normalized_id is None:
                normalized_id = next_normalized_trip_id
                next_normalized_trip_id += 1
                normalized_trip_ids_by_key[key] = normalized_id

                normalized_trips.append({
                    "id": normalized_id,
                    "cgm_id": normalize(trip.get("route_id")),
                    "direction": direction_value,
                    "is_weekend": day_type == "weekend",
                })

    normalized_stop_times = []
    for item in logical_stop_times:
        source_trip_id = item.get("trip")
        for day_type in ("weekday", "weekend"):
            normalized_trip_id = normalized_trip_ids_by_key.get(
                (source_trip_id, day_type)
            )
            if normalized_trip_id is None:
                continue
            normalized_stop_times.append({
                "trip": normalized_trip_id,
                "times": list(item.get("times", [])),
                "car": normalize(item.get("car")),
            })

    return {
        "stops": normalized_stops,
        "routes": normalized_routes,
        "directions": normalized_directions,
        "trips": normalized_trips,
        "stop_times": normalized_stop_times,
    }
