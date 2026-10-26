from .common import normalize, normalize_stop_id

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
    Keep the existing stop structure and normalized IDs.

    Stop names and metadata come directly from the official GTFS feed.
    Duplicate stop_ids are retained in the output, but the lookup index
    chooses the most useful public stop record.
    """

    result = []

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

        result.append(
            stop
        )

    return (
        result,
        build_stop_index(result)
    )



def filter_stops_for_directions(stops, directions):
    """Keep public stops used by generated directions and their parent stations.

    Preserve every GTFS record sharing a referenced stop_id: duplicate IDs can
    carry useful platform metadata. Filter only stop IDs that the browser can
    never reach from any published direction, while retaining parent stations
    referenced by retained stops.
    """
    active_ids = set()
    for direction_set in (directions or {}).values():
        for direction in (direction_set or {}).values():
            for stop in direction.get("stops", []) or []:
                stop_id = normalize_stop_id(stop.get("stop_id"))
                if stop_id:
                    active_ids.add(stop_id)
            for stop_id in direction.get("pattern", []) or []:
                normalized_id = normalize_stop_id(stop_id)
                if normalized_id:
                    active_ids.add(normalized_id)

    parent_ids = {
        normalize_stop_id(stop.get("parent_station"))
        for stop in stops
        if normalize_stop_id(stop.get("stop_id")) in active_ids
        and normalize_stop_id(stop.get("parent_station"))
    }
    keep_ids = active_ids | parent_ids
    return [
        stop for stop in stops
        if normalize_stop_id(stop.get("stop_id")) in keep_ids
    ]
