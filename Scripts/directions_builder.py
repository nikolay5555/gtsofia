from __future__ import annotations

from collections import Counter, defaultdict

from transport_common import normalize, normalize_display_name, normalize_stop_id, parse_time
from trip_builder import extract_car_number


def _find_direction(directions, route_direction_codes, route_id, trip_stops):
    for direction in directions:
        if direction["code"] not in route_direction_codes[route_id]:
            continue
        if len(direction["stops"]) != len(trip_stops):
            continue
        if direction["stops"] == trip_stops:
            return direction
    return None


def _get_or_create_logical_trip(logical_trips, logical_by_key, route_id, direction_code, is_weekend, headsign, shape_id):
    key = (route_id, direction_code, bool(is_weekend))
    trip = logical_by_key.get(key)
    if trip is not None:
        return trip
    trip = {
        "id": len(logical_trips) + 1,
        "route_id": route_id,
        "direction_code": direction_code,
        "is_weekend": bool(is_weekend),
        "headsign": normalize_display_name(headsign),
        "shape_id": normalize(shape_id),
        "original_trip_ids": [],
    }
    logical_trips.append(trip)
    logical_by_key[key] = trip
    return trip


def build_reference_directions(trips_by_id, stop_times_by_trip):
    """Build logical directions/trips using Dimitar's data model.

    A direction is a unique ordered stop pattern per route. A logical trip is
    one (route, direction, weekday/weekend) bucket, and stop_times keeps every
    source GTFS course that belongs to that bucket.
    """
    directions = []
    route_direction_codes = defaultdict(set)
    logical_trips = []
    logical_by_key = {}
    logical_stop_times = []

    for trip_id, trip in trips_by_id.items():
        trip_stop_times = stop_times_by_trip.get(trip_id, [])
        trip_stops = [item["stop_id"] for item in trip_stop_times]
        if not trip_stops:
            continue
        route_id = trip.get("route_id")
        if not route_id:
            continue

        direction = _find_direction(directions, route_direction_codes, route_id, trip_stops)
        if direction is None:
            direction = {
                "code": len(directions) + 1,
                "route_id": route_id,
                "stops": list(trip_stops),
                "trip_ids": [],
                "headsigns": [],
                "shape_ids": [],
                "is_deleted": False,
            }
            directions.append(direction)
            route_direction_codes[route_id].add(direction["code"])

        direction["trip_ids"].append(trip_id)
        if trip.get("trip_headsign"):
            direction["headsigns"].append(trip["trip_headsign"])
        if trip.get("shape_id"):
            direction["shape_ids"].append(trip["shape_id"])

        times = []
        for stop_time in trip_stop_times:
            parsed = parse_time(stop_time.get("departure_time") or stop_time.get("arrival_time"))
            times.append(None if parsed is None else parsed // 60)

        stop_sequences = [item.get("sequence") for item in trip_stop_times]
        for day_type in trip.get("day_types", []):
            logical_trip = _get_or_create_logical_trip(
                logical_trips,
                logical_by_key,
                route_id,
                direction["code"],
                day_type == "weekend",
                trip.get("trip_headsign", ""),
                trip.get("shape_id", ""),
            )
            logical_trip["original_trip_ids"].append(trip_id)
            logical_stop_times.append({
                "trip": logical_trip["id"],
                "times": list(times),
                "stop_sequences": list(stop_sequences),
                "car": extract_car_number(trip_id),
                "original_trip_id": trip_id,
                "service_id": trip.get("service_id", ""),
            })

    return directions, logical_trips, logical_stop_times


def merge_partial_directions(routes_data, directions, logical_trips, logical_stop_times):
    """Merge shorter stop-pattern directions into longer containing patterns."""
    directions_by_code = {direction["code"]: direction for direction in directions}

    for route in routes_data:
        route_id = normalize(route.get("route_id"))
        route_direction_codes = {
            trip["direction_code"]
            for trip in logical_trips
            if trip["route_id"] == route_id
        }
        route_directions = [
            direction for direction in directions
            if direction["code"] in route_direction_codes and not direction.get("is_deleted")
        ]
        route_directions.sort(key=lambda direction: len(direction["stops"]), reverse=True)

        for index, child in enumerate(route_directions):
            child_string = ",".join(child["stops"])
            parent = None
            for parent_index, candidate in enumerate(route_directions):
                if parent_index == index or candidate.get("is_deleted"):
                    continue
                if child_string in ",".join(candidate["stops"]):
                    parent = candidate
                    break
            if parent is None:
                continue

            try:
                begin_padding = parent["stops"].index(child["stops"][0])
            except (ValueError, IndexError):
                continue
            end_padding = len(parent["stops"]) - begin_padding - len(child["stops"])
            if begin_padding < 0 or end_padding < 0:
                continue

            child["is_deleted"] = True
            child_code = child["code"]
            child_trip_ids = set(child.get("trip_ids", []))
            for logical_trip in logical_trips:
                if logical_trip["direction_code"] != child_code:
                    continue
                for item in logical_stop_times:
                    if item["trip"] != logical_trip["id"]:
                        continue
                    item["times"] = [None] * begin_padding + item["times"] + [None] * end_padding
                    item["stop_sequences"] = [None] * begin_padding + item.get("stop_sequences", []) + [None] * end_padding
                logical_trip["direction_code"] = parent["code"]
                parent.setdefault("trip_ids", []).extend(child.get("trip_ids", []))
                parent.setdefault("headsigns", []).extend(child.get("headsigns", []))
                parent.setdefault("shape_ids", []).extend(child.get("shape_ids", []))

            # Guard against an impossible state where source ids were not
            # propagated. This is diagnostic only; the child remains deleted.
            if child_trip_ids and not child_trip_ids.intersection(set(parent.get("trip_ids", []))):
                raise RuntimeError(f"Direction merge lost source trips for direction {child_code}")

        for index in range(len(directions) - 1, -1, -1):
            direction = directions[index]
            if not direction.get("is_deleted"):
                continue
            code = direction["code"]
            if any(trip["direction_code"] == code for trip in logical_trips):
                continue
            directions.pop(index)
            directions_by_code.pop(code, None)


def merge_logical_trips(routes_data, logical_trips, logical_stop_times):
    """Merge logical trips that now share route, direction and day type."""
    for route in routes_data:
        route_id = normalize(route.get("route_id"))
        route_trips = [trip for trip in logical_trips if trip["route_id"] == route_id and not trip.get("is_deleted")]

        seen = {}
        for trip in route_trips:
            key = (trip["direction_code"], bool(trip["is_weekend"]))
            same = seen.get(key)
            if same is None:
                seen[key] = trip
                continue
            for item in logical_stop_times:
                if item["trip"] == trip["id"]:
                    item["trip"] = same["id"]
            same["original_trip_ids"].extend(trip.get("original_trip_ids", []))
            trip["is_deleted"] = True

    for index in range(len(logical_trips) - 1, -1, -1):
        trip = logical_trips[index]
        if not trip.get("is_deleted"):
            continue
        if any(item["trip"] == trip["id"] for item in logical_stop_times):
            raise RuntimeError(f"Logical trip {trip['id']} still has stop times after merge")
        logical_trips.pop(index)


def choose_direction_name(direction, stops_by_id):
    # Dimitar does not store a passenger-facing destination in directions.json;
    # the UI derives it from the last stop. Prefer the OSM/SUMC merged terminal
    # name here as well, with GTFS headsign only as a safety fallback for a
    # malformed/incomplete stop mapping.
    stops = direction.get("stops", [])
    if stops:
        stop = stops_by_id.get(stops[-1])
        if stop:
            names = stop.get("names") if isinstance(stop.get("names"), dict) else {}
            name = normalize(names.get("bg")) or normalize(stop.get("stop_name"))
            if name:
                return name

    headsigns = [normalize_display_name(value) for value in direction.get("headsigns", []) if normalize(value)]
    if headsigns:
        return Counter(headsigns).most_common(1)[0][0]
    return ""


def choose_shape_id(direction):
    shapes = [normalize(value) for value in direction.get("shape_ids", []) if normalize(value)]
    return Counter(shapes).most_common(1)[0][0] if shapes else ""


def build_direction_records(routes_data, directions, logical_trips, stops_by_id):
    """Create compact directions.json entries and route -> direction metadata."""
    directions_by_code = {direction["code"]: direction for direction in directions}
    by_route = {}
    for route in routes_data:
        route_id = normalize(route.get("route_id"))
        route_trips = [trip for trip in logical_trips if trip["route_id"] == route_id and not trip.get("is_deleted")]
        if not route_trips:
            continue

        route_direction_codes = []
        for trip in route_trips:
            code = trip["direction_code"]
            if code not in route_direction_codes:
                route_direction_codes.append(code)

        route_meta = []
        for ordinal, code in enumerate(route_direction_codes, start=1):
            direction = directions_by_code.get(code)
            if direction is None:
                continue
            destination = choose_direction_name(direction, stops_by_id)
            route_meta.append({
                "key": f"D{ordinal}",
                "code": int(code),
                "headsign": destination,
                "destination": destination,
                "shape_id": choose_shape_id(direction),
                "stop_count": len(direction["stops"]),
            })
        if route_meta:
            by_route[route_id] = route_meta
    return by_route


def build_dimitar_directions(directions, direction_metadata):
    """Strip per-app metadata down to the five-file direction representation."""
    meta_by_code = {
        int(item["code"]): item
        for items in direction_metadata.values()
        for item in items
    }
    result = []
    for direction in directions:
        if direction.get("is_deleted"):
            continue
        code = int(direction["code"])
        item = {"code": code, "stops": [normalize_stop_id(x) for x in direction["stops"]]}
        metadata = meta_by_code.get(code)
        if metadata:
            item["destination"] = metadata.get("destination", "")
            shape_id = normalize(metadata.get("shape_id"))
            if shape_id:
                item["shape_id"] = shape_id
        result.append(item)
    return result


def build_dimitar_trips(logical_trips):
    result = []
    for trip in logical_trips:
        if trip.get("is_deleted"):
            continue
        source_trip_ids = list(dict.fromkeys(
            normalize(value)
            for value in trip.get("original_trip_ids", [])
            if normalize(value)
        ))
        result.append({
            "id": int(trip["id"]),
            "cgm_id": normalize(trip["route_id"]),
            "direction": int(trip["direction_code"]),
            "is_weekend": bool(trip["is_weekend"]),
            "source_trip_ids": source_trip_ids,
            "headsign": normalize_display_name(trip.get("headsign", "")),
            "shape_id": normalize(trip.get("shape_id", "")),
        })
    return result


def build_dimitar_stop_times(logical_stop_times):
    result = []
    for item in logical_stop_times:
        times = item.get("times", [])
        if not times or not any(value is not None for value in times):
            continue
        clean_times = [None if value is None else int(value) for value in times]
        result.append({
            "times": clean_times,
            "trip": int(item["trip"]),
            "car": normalize(item.get("car")),
            "original_trip_id": normalize(item.get("original_trip_id")),
            "service_id": normalize(item.get("service_id")),
            "stop_sequences": [
                None if value is None else int(value)
                for value in item.get("stop_sequences", [])
            ],
        })
    return result
