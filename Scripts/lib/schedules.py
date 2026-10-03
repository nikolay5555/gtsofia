from collections import defaultdict
from collections import Counter

from .common import normalize, normalize_stop_id, parse_time
from .routes import build_model_routes
from .stops import build_model_stops


def build_trips(
    trips_data,
    service_day_types
):
    trips_by_id = {}

    for row in trips_data:

        trip_id = normalize(
            row.get(
                "trip_id"
            )
        )

        if not trip_id:
            continue

        service_id = normalize(
            row.get(
                "service_id"
            )
        )

        day_types = list(
            service_day_types.get(
                service_id,
                []
            )
        )

        if not day_types:
            continue

        trips_by_id[
            trip_id
        ] = {

            "trip_id":
                trip_id,

            "route_id":
                normalize(
                    row.get(
                        "route_id"
                    )
                ),

            "service_id":
                service_id,

            "trip_headsign":
                normalize(
                    row.get(
                        "trip_headsign"
                    )
                ),

            "direction_id":
                normalize(
                    row.get(
                        "direction_id"
                    )
                ),

            "shape_id":
                normalize(
                    row.get(
                        "shape_id"
                    )
                ),

            "day_types":
                day_types,

            # Kept for compatibility with older internal data consumers.
            "is_weekend":
                day_types == ["weekend"],
        }

    return trips_by_id


# ============================================================
# Stop times
# ============================================================

def build_stop_times(
    stop_times_data,
    trips_by_id,
    stop_code_by_gtfs_id=None
):
    result = defaultdict(list)

    for row in stop_times_data:

        trip_id = normalize(
            row.get(
                "trip_id"
            )
        )

        if trip_id not in trips_by_id:
            continue

        source_stop_id = normalize(
            row.get(
                "stop_id"
            )
        )

        stop_id = (
            stop_code_by_gtfs_id.get(
                source_stop_id,
                normalize_stop_id(source_stop_id)
            )
            if stop_code_by_gtfs_id
            else normalize_stop_id(source_stop_id)
        )

        if not stop_id:
            continue

        try:

            sequence = int(
                row.get(
                    "stop_sequence",
                    0
                )
            )

        except (
            TypeError,
            ValueError
        ):

            sequence = 0

        result[
            trip_id
        ].append({

            "stop_id":
                stop_id,

            "sequence":
                sequence,

            "arrival_time":
                normalize(
                    row.get(
                        "arrival_time"
                    )
                ),

            "departure_time":
                normalize(
                    row.get(
                        "departure_time"
                    )
                ),
        })

    for trip_id in result:

        result[
            trip_id
        ].sort(
            key=lambda item:
                item[
                    "sequence"
                ]
        )

    return result


# ============================================================
# Directions
# ============================================================

def build_reference_directions(
    trips_by_id,
    stop_times_by_trip
):
    """
    Core direction construction copied from the logic of
    Dimitar5555's 04-schedules.js.

    Every unique ordered stop pattern is a direction.
    """

    directions = []

    route_direction_codes = defaultdict(
        set
    )

    logical_trips = []

    logical_stop_times = []

    for trip_id, trip in (
        trips_by_id.items()
    ):

        trip_stop_times = (
            stop_times_by_trip.get(
                trip_id,
                []
            )
        )

        trip_stops = [
            item[
                "stop_id"
            ]
            for item in
            trip_stop_times
        ]

        if not trip_stops:
            continue

        route_id = trip[
            "route_id"
        ]

        if not route_id:
            continue

        matching_direction = None

        for direction in directions:

            if (
                direction[
                    "code"
                ]
                not in route_direction_codes[
                    route_id
                ]
            ):
                continue

            if (
                len(
                    direction[
                        "stops"
                    ]
                )
                != len(
                    trip_stops
                )
            ):
                continue

            if (
                direction[
                    "stops"
                ]
                == trip_stops
            ):

                matching_direction = (
                    direction
                )

                break

        if matching_direction is None:

            matching_direction = {

                "code":
                    str(
                        len(
                            directions
                        ) + 1
                    ),

                "route_id":
                    route_id,

                "stops":
                    list(
                        trip_stops
                    ),

                "is_deleted":
                    False,

                "trip_ids":
                    [],

                "headsigns":
                    [],

                "shape_ids":
                    [],
            }

            directions.append(
                matching_direction
            )

            route_direction_codes[
                route_id
            ].add(
                matching_direction[
                    "code"
                ]
            )

        direction_code = (
            matching_direction[
                "code"
            ]
        )

        matching_direction[
            "trip_ids"
        ].append(
            trip_id
        )

        if trip[
            "trip_headsign"
        ]:

            matching_direction[
                "headsigns"
            ].append(
                trip[
                    "trip_headsign"
                ]
            )

        if trip[
            "shape_id"
        ]:

            matching_direction[
                "shape_ids"
            ].append(
                trip[
                    "shape_id"
                ]
            )

        matching_trip = None

        for logical_trip in logical_trips:

            if (
                logical_trip[
                    "route_id"
                ]
                != route_id
            ):
                continue

            if (
                logical_trip[
                    "direction_code"
                ]
                != direction_code
            ):
                continue

            if (
                logical_trip.get("day_types", [])
                != trip.get("day_types", [])
            ):
                continue

            matching_trip = (
                logical_trip
            )

            break

        if matching_trip is None:

            matching_trip = {

                "id":
                    len(
                        logical_trips
                    ) + 1,

                "route_id":
                    route_id,

                "direction_code":
                    direction_code,

                "day_types":
                    list(
                        trip.get(
                            "day_types",
                            []
                        )
                    ),

                "original_trip_ids":
                    [],
            }

            logical_trips.append(
                matching_trip
            )

        matching_trip[
            "original_trip_ids"
        ].append(
            trip_id
        )

        times = []

        for stop_time in trip_stop_times:

            parsed = parse_time(
                stop_time.get(
                    "departure_time"
                )
                or stop_time.get(
                    "arrival_time"
                )
            )

            if parsed is None:
                times.append(
                    None
                )
            else:
                times.append(
                    parsed // 60
                )

        logical_stop_times.append({

            "trip":
                matching_trip[
                    "id"
                ],

            "times":
                times,

            # Preserve the GTFS stop_sequence alongside the padded timetable.
            # GTFS-Realtime StopTimeUpdate may identify a stop by sequence
            # instead of stop_id, so the virtual board needs this mapping to
            # decide whether a SKIPPED update applies to the selected stop.
            "stop_sequences": [
                item.get("sequence")
                for item in trip_stop_times
            ],

            "original_trip_id":
                trip_id,

            # Preserve the exact GTFS service_id of this original trip.
            # Logical trip merging can combine multiple source trips, so the
            # schedule row must retain its own service calendar identity for
            # runtime checks against the actual service date.
            "service_id":
                trip.get(
                    "service_id",
                    ""
                ),
        })

    return (
        directions,
        logical_trips,
        logical_stop_times
    )


# ============================================================
# Partial directions
# ============================================================

def merge_partial_directions(
    routes_data,
    directions,
    logical_trips,
    logical_stop_times
):
    """
    Direct equivalent of the partial-direction merge
    in 04-schedules.js.
    """

    directions_by_code = {
        direction[
            "code"
        ]:
            direction
        for direction in directions
    }

    for route in routes_data:

        route_id = normalize(
            route.get(
                "route_id"
            )
        )

        route_direction_codes = {
            trip[
                "direction_code"
            ]
            for trip in logical_trips
            if (
                trip[
                    "route_id"
                ]
                == route_id
            )
        }

        route_directions = [
            direction
            for direction in directions
            if (
                direction[
                    "code"
                ]
                in route_direction_codes
                and not direction.get(
                    "is_deleted",
                    False
                )
            )
        ]

        route_directions.sort(
            key=lambda direction:
                len(
                    direction[
                        "stops"
                    ]
                ),
            reverse=True
        )

        for index, child in enumerate(
            route_directions
        ):

            if child.get(
                "is_deleted",
                False
            ):
                continue

            child_string = ",".join(
                child[
                    "stops"
                ]
            )

            parent = None

            for parent_index, candidate in enumerate(
                route_directions
            ):

                if (
                    parent_index
                    == index
                ):
                    continue

                if candidate.get(
                    "is_deleted",
                    False
                ):
                    continue

                candidate_string = ",".join(
                    candidate[
                        "stops"
                    ]
                )

                if (
                    child_string
                    in candidate_string
                ):

                    parent = candidate
                    break

            if parent is None:
                continue

            try:

                begin_padding = (
                    parent[
                        "stops"
                    ].index(
                        child[
                            "stops"
                        ][0]
                    )
                )

            except ValueError:
                continue

            end_padding = (
                len(
                    parent[
                        "stops"
                    ]
                )
                - begin_padding
                - len(
                    child[
                        "stops"
                    ]
                )
            )

            child[
                "is_deleted"
            ] = True

            child_code = child[
                "code"
            ]

            for logical_trip in logical_trips:

                if (
                    logical_trip[
                        "direction_code"
                    ]
                    != child_code
                ):
                    continue

                logical_times = [
                    item
                    for item in logical_stop_times
                    if (
                        item[
                            "trip"
                        ]
                        == logical_trip[
                            "id"
                        ]
                    )
                ]

                for item in logical_times:

                    item[
                        "times"
                    ] = (
                        [None]
                        * begin_padding
                        + item[
                            "times"
                        ]
                        + [None]
                        * end_padding
                    )

                    item[
                        "stop_sequences"
                    ] = (
                        [None]
                        * begin_padding
                        + item.get(
                            "stop_sequences",
                            []
                        )
                        + [None]
                        * end_padding
                    )

                logical_trip[
                    "direction_code"
                ] = parent[
                    "code"
                ]

                parent[
                    "trip_ids"
                ] = (
                    parent.get(
                        "trip_ids",
                        []
                    )
                    + child.get(
                        "trip_ids",
                        []
                    )
                )

                parent[
                    "headsigns"
                ] = (
                    parent.get(
                        "headsigns",
                        []
                    )
                    + child.get(
                        "headsigns",
                        []
                    )
                )

                parent[
                    "shape_ids"
                ] = (
                    parent.get(
                        "shape_ids",
                        []
                    )
                    + child.get(
                        "shape_ids",
                        []
                    )
                )

        for i in range(
            len(directions) - 1,
            -1,
            -1
        ):

            direction = directions[
                i
            ]

            if not direction.get(
                "is_deleted",
                False
            ):
                continue

            code = direction[
                "code"
            ]

            orphan_trips = any(
                trip[
                    "direction_code"
                ]
                == code
                for trip in logical_trips
            )

            if not orphan_trips:

                directions.pop(
                    i
                )

                directions_by_code.pop(
                    code,
                    None
                )


# ============================================================
# Logical trips
# ============================================================

def merge_logical_trips(
    routes_data,
    logical_trips,
    logical_stop_times
):
    """
    Direct equivalent of the trip merge in 04-schedules.js.
    """

    for route in routes_data:

        route_id = normalize(
            route.get(
                "route_id"
            )
        )

        route_trips = [
            trip
            for trip in logical_trips
            if trip[
                "route_id"
            ] == route_id
        ]

        for index, trip in enumerate(
            route_trips
        ):

            same = None

            for candidate_index, candidate in enumerate(
                route_trips
            ):

                if (
                    candidate_index
                    == index
                ):
                    continue

                if (
                    candidate[
                        "direction_code"
                    ]
                    != trip[
                        "direction_code"
                    ]
                ):
                    continue

                if (
                    candidate.get("day_types", [])
                    != trip.get("day_types", [])
                ):
                    continue

                if candidate.get(
                    "is_deleted",
                    False
                ):
                    continue

                same = candidate
                break

            if same is None:
                continue

            for item in logical_stop_times:

                if (
                    item[
                        "trip"
                    ]
                    == trip[
                        "id"
                    ]
                ):

                    item[
                        "trip"
                    ] = same[
                        "id"
                    ]

            same[
                "original_trip_ids"
            ] = (
                same[
                    "original_trip_ids"
                ]
                + trip[
                    "original_trip_ids"
                ]
            )

            trip[
                "is_deleted"
            ] = True

        for i in range(
            len(logical_trips) - 1,
            -1,
            -1
        ):

            trip = logical_trips[
                i
            ]

            if not trip.get(
                "is_deleted",
                False
            ):
                continue

            trip_id = trip[
                "id"
            ]

            has_orphan_stop_times = any(
                item[
                    "trip"
                ]
                == trip_id
                for item in logical_stop_times
            )

            if not has_orphan_stop_times:
                logical_trips.pop(
                    i
                )


# ============================================================
# Direction metadata
# ============================================================

def choose_direction_name(
    direction,
    stops_by_id
):
    """
    Use the official trip_headsign that belongs to this
    exact direction pattern.

    Most frequent value wins.
    """

    headsigns = [
        normalize(value)
        for value in direction.get(
            "headsigns",
            []
        )
        if normalize(value)
    ]

    if headsigns:

        return Counter(
            headsigns
        ).most_common(
            1
        )[0][0]

    stops = direction.get(
        "stops",
        []
    )

    if stops:

        stop = stops_by_id.get(
            stops[-1]
        )

        if stop:

            return normalize(
                stop.get(
                    "stop_name"
                )
            )

    return ""


def choose_shape_id(
    direction
):
    shapes = [
        normalize(value)
        for value in direction.get(
            "shape_ids",
            []
        )
        if normalize(value)
    ]

    if not shapes:
        return ""

    return Counter(
        shapes
    ).most_common(
        1
    )[0][0]


# ============================================================
# Output directions
# ============================================================


def build_schedules(
    directions_result,
    logical_trips,
    logical_stop_times
):
    """
    Schedules use the SAME D1/D2/... direction keys as directions.
    """

    schedules = {}

    for route_id, route_directions in (
        directions_result.items()
    ):

        route_schedule = {}

        for key, direction in (
            route_directions.items()
        ):

            code = direction[
                "code"
            ]

            weekday = []
            weekend = []

            matching_trips = [
                trip
                for trip in logical_trips
                if (
                    trip[
                        "route_id"
                    ]
                    == route_id
                    and trip[
                        "direction_code"
                    ]
                    == code
                    and not trip.get(
                        "is_deleted",
                        False
                    )
                )
            ]

            for logical_trip in matching_trips:

                trip_day_types = logical_trip.get(
                    "day_types",
                    []
                )

                if not trip_day_types:
                    trip_day_types = [
                        "weekend"
                        if logical_trip.get(
                            "is_weekend",
                            False
                        )
                        else "weekday"
                    ]

                trip_times = [
                    item
                    for item in logical_stop_times
                    if (
                        item[
                            "trip"
                        ]
                        == logical_trip[
                            "id"
                        ]
                    )
                ]

                for item in trip_times:

                    values = item.get(
                        "times",
                        []
                    )

                    if not values:
                        continue

                    non_null = [
                        value
                        for value in values
                        if value is not None
                    ]

                    if not non_null:
                        continue

                    first = non_null[
                        0
                    ]

                    schedule_row = {

                        "trip_id":
                            logical_trip[
                                "id"
                            ],

                        # Keep the original GTFS trip id on every schedule
                        # row. GTFS-Realtime references this original id,
                        # while the public schedule uses the logical trip id
                        # created by the generator. This lets the virtual board
                        # suppress a SKIPPED course exactly, without hiding
                        # later courses in the same direction.
                        "original_trip_id":
                            normalize(
                                item.get(
                                    "original_trip_id",
                                    ""
                                )
                            ),

                        "service_id":
                            normalize(
                                item.get(
                                    "service_id",
                                    ""
                                )
                            ),

                        "stop_sequences":
                            [
                                sequence
                                if sequence is None
                                else int(sequence)
                                for sequence in item.get(
                                    "stop_sequences",
                                    []
                                )
                            ],

                        "start_time":
                            (
                                f"{first // 60:02d}:"
                                f"{first % 60:02d}:00"
                            ),

                        "times":
                            [
                                (
                                    f"{value // 60:02d}:"
                                    f"{value % 60:02d}:00"
                                )
                                if value is not None
                                else None
                                for value in values
                            ],

                    }

                    if "weekday" in trip_day_types:
                        weekday.append(dict(schedule_row))

                    if "weekend" in trip_day_types:
                        weekend.append(dict(schedule_row))

            weekday.sort(
                key=lambda item:
                    parse_time(
                        item[
                            "start_time"
                        ]
                    )
                    if parse_time(
                        item[
                            "start_time"
                        ]
                    ) is not None
                    else 10**12
            )

            weekend.sort(
                key=lambda item:
                    parse_time(
                        item[
                            "start_time"
                        ]
                    )
                    if parse_time(
                        item[
                            "start_time"
                        ]
                    ) is not None
                    else 10**12
            )

            route_schedule[
                key
            ] = {

                "weekday":
                    weekday,

                "weekend":
                    weekend
            }

        if route_schedule:

            schedules[
                route_id
            ] = route_schedule

    return schedules

def build_model_active_service_ids(calendar_result):
    service_stats = defaultdict(
        lambda: {
            "weekday_count": 0,
            "weekend_count": 0,
        }
    )

    service_ids_by_date = calendar_result.get(
        "serviceIdsByDate",
        {}
    )
    date_types = calendar_result.get(
        "dateTypes",
        {}
    )

    for date_key, service_ids in service_ids_by_date.items():
        day_type = date_types.get(date_key)
        if day_type not in {"weekday", "weekend"}:
            continue

        for service_id in service_ids:
            if day_type == "weekend":
                service_stats[service_id]["weekend_count"] += 1
            else:
                service_stats[service_id]["weekday_count"] += 1

    result = []

    for service_id in sorted(service_stats):
        stats = service_stats[service_id]

        # Mirrors Dimitar's compact active_service_ids model. The exact
        # GTFS date evaluation remains in calendar.json.
        is_weekend = (
            stats["weekend_count"]
            >= stats["weekday_count"]
        )

        result.append([
            service_id,
            is_weekend,
        ])

    return result


def build_model_schedule_data(
    routes_data,
    output_stops,
    directions,
    logical_trips,
    logical_stop_times,
    trips_by_id,
    calendar_result,
):
    active_service_ids = build_model_active_service_ids(
        calendar_result
    )
    active_service_map = dict(
        active_service_ids
    )

    active_route_ids = {
        normalize(trip.get("route_id"))
        for trip in logical_trips
        if normalize(trip.get("route_id"))
        and not trip.get("is_deleted", False)
    }

    model_routes = build_model_routes(
        routes_data,
        active_route_ids,
    )

    surviving_directions = [
        direction
        for direction in directions
        if not direction.get("is_deleted", False)
    ]

    model_directions = [
        {
            "code": int(direction["code"]),
            "stops": list(direction.get("stops", [])),
        }
        for direction in surviving_directions
    ]

    used_stop_ids = {
        stop_id
        for direction in model_directions
        for stop_id in direction["stops"]
    }

    model_stops = build_model_stops(
        output_stops,
        used_stop_ids,
    )

    # Dimitar's trips.json intentionally collapses source GTFS trips into a
    # logical trip keyed by route + direction + weekday/weekend.
    canonical_groups = {}
    logical_to_model = {}
    model_trips = []

    for logical_trip in logical_trips:
        if logical_trip.get("is_deleted", False):
            continue

        original_ids = logical_trip.get(
            "original_trip_ids",
            []
        )

        weekend_votes = []
        for original_id in original_ids:
            source_trip = trips_by_id.get(original_id)
            if source_trip is None:
                continue

            service_id = normalize(
                source_trip.get("service_id")
            )

            if service_id in active_service_map:
                weekend_votes.append(
                    bool(active_service_map[service_id])
                )

        if weekend_votes:
            is_weekend = (
                sum(weekend_votes)
                >= (len(weekend_votes) / 2)
            )
        else:
            day_types = logical_trip.get(
                "day_types",
                []
            )
            is_weekend = day_types == ["weekend"]

        key = (
            normalize(logical_trip.get("route_id")),
            int(logical_trip["direction_code"]),
            bool(is_weekend),
        )

        model_trip_id = canonical_groups.get(key)
        if model_trip_id is None:
            model_trip_id = len(model_trips) + 1
            canonical_groups[key] = model_trip_id

            model_trips.append({
                "id": model_trip_id,
                "cgm_id": normalize(
                    logical_trip.get("route_id")
                ),
                "direction": int(
                    logical_trip["direction_code"]
                ),
                "is_weekend": bool(is_weekend),
            })

        logical_to_model[
            logical_trip["id"]
        ] = model_trip_id

    model_stop_times = []

    for item in logical_stop_times:
        logical_trip_id = item.get("trip")
        model_trip_id = logical_to_model.get(
            logical_trip_id
        )

        if model_trip_id is None:
            continue

        model_stop_times.append({
            "trip": model_trip_id,
            "times": list(
                item.get("times", [])
            ),
            "stop_sequences": [
                sequence
                if sequence is None
                else int(sequence)
                for sequence in item.get("stop_sequences", [])
            ],
            "original_trip_id": normalize(
                item.get("original_trip_id", "")
            ),
            "service_id": normalize(
                item.get("service_id", "")
            ),
        })

    return {
        "routes": model_routes,
        "stops": model_stops,
        "trips": model_trips,
        "directions": model_directions,
        "stop_times": model_stop_times,
        "active_service_ids": active_service_ids,
    }


def write_model_json(path, data):
    DATA_DIR.mkdir(
        parents=True,
        exist_ok=True
    )

    with path.open(
        "w",
        encoding="utf-8"
    ) as file:
        json.dump(
            data,
            file,
            ensure_ascii=False,
            indent=2
        )
        file.write("\n")


def build_model_realtime_trips(logical_trips, trips_by_id):
    direction_by_source_trip = {}

    for logical_trip in logical_trips:
        if logical_trip.get("is_deleted", False):
            continue

        direction_code = int(
            logical_trip["direction_code"]
        )

        for source_trip_id in logical_trip.get(
            "original_trip_ids",
            []
        ):
            direction_by_source_trip[
                source_trip_id
            ] = direction_code

    result = []

    for trip_id, trip in trips_by_id.items():
        direction_code = direction_by_source_trip.get(
            trip_id
        )

        if direction_code is None:
            continue

        result.append({
            "trip_id": normalize(trip_id),
            "route_id": normalize(trip.get("route_id")),
            "service_id": normalize(trip.get("service_id")),
            "trip_headsign": normalize(trip.get("trip_headsign")),
            "direction_id": normalize(trip.get("direction_id")),
            "shape_id": normalize(trip.get("shape_id")),
            "direction_code": direction_code,
        })

    return result


def write_canonical_data_model(
    model,
    calendar_result,
    line_overrides,
    shapes_result,
    realtime_trips,
    updated_at,
):
    files = {
        "routes": model["routes"],
        "stops": model["stops"],
        "trips": model["trips"],
        "directions": model["directions"],
        "stop_times": model["stop_times"],
        "active_service_ids": model["active_service_ids"],
        "shapes": shapes_result,
        "realtime-trips": realtime_trips,
        "calendar": calendar_result,
        "line-overrides": line_overrides,
    }

    written = []

    for name, data in files.items():
        path = DATA_DIR / f"{name}.json"
        write_model_json(path, data)
        written.append(path)

    metadata = {
        "app_version": "gtsofia-data-model-v2",
        "model_version": 2,
        "retrieval_date": get_today().isoformat(),
        "updatedAt": updated_at,
        "source": "CGM Sofia official GTFS",
        "files": [
            path.name
            for path in written
        ],
        "hashes": {},
    }

    for path in written:
        payload = path.read_bytes()
        metadata["hashes"][
            path.stem
        ] = hashlib.sha256(payload).hexdigest()

    write_model_json(
        DATA_DIR / "metadata.json",
        metadata
    )

    manifest = {
        "version": 2,
        "metadata": "metadata.json",
        "files": metadata["files"],
    }

    write_model_json(
        DATA_DIR / "manifest.json",
        manifest
    )

    return metadata

def build_model_schedule_data(
    routes_data,
    output_stops,
    directions,
    logical_trips,
    logical_stop_times,
    trips_by_id,
    calendar_result,
):
    active_service_ids = build_model_active_service_ids(calendar_result)
    active_service_map = dict(active_service_ids)

    active_route_ids = {
        normalize(trip.get("route_id"))
        for trip in logical_trips
        if normalize(trip.get("route_id"))
        and not trip.get("is_deleted", False)
    }

    model_routes = build_model_routes(routes_data, active_route_ids)

    surviving_directions = [
        direction
        for direction in directions
        if not direction.get("is_deleted", False)
    ]

    model_directions = [
        {
            "code": int(direction["code"]),
            "stops": list(direction.get("stops", [])),
        }
        for direction in surviving_directions
    ]

    used_stop_ids = {
        stop_id
        for direction in model_directions
        for stop_id in direction["stops"]
    }

    model_stops = build_model_stops(
        output_stops,
        used_stop_ids,
    )

    canonical_groups = {}
    logical_to_model = {}
    model_trips = []

    for logical_trip in logical_trips:
        if logical_trip.get("is_deleted", False):
            continue

        original_ids = logical_trip.get("original_trip_ids", [])
        weekend_votes = []

        for original_id in original_ids:
            source_trip = trips_by_id.get(original_id)
            if source_trip is None:
                continue

            service_id = normalize(source_trip.get("service_id"))
            if service_id in active_service_map:
                weekend_votes.append(bool(active_service_map[service_id]))

        if weekend_votes:
            is_weekend = (
                sum(weekend_votes) >= (len(weekend_votes) / 2)
            )
        else:
            is_weekend = logical_trip.get("day_types", []) == ["weekend"]

        key = (
            normalize(logical_trip.get("route_id")),
            int(logical_trip["direction_code"]),
            bool(is_weekend),
        )

        model_trip_id = canonical_groups.get(key)
        if model_trip_id is None:
            model_trip_id = len(model_trips) + 1
            canonical_groups[key] = model_trip_id
            model_trips.append({
                "id": model_trip_id,
                "cgm_id": normalize(logical_trip.get("route_id")),
                "direction": int(logical_trip["direction_code"]),
                "is_weekend": bool(is_weekend),
            })

        logical_to_model[logical_trip["id"]] = model_trip_id

    model_stop_times = []

    for item in logical_stop_times:
        model_trip_id = logical_to_model.get(item.get("trip"))
        if model_trip_id is None:
            continue

        model_stop_times.append({
            "trip": model_trip_id,
            "times": list(item.get("times", [])),
            "stop_sequences": [
                sequence if sequence is None else int(sequence)
                for sequence in item.get("stop_sequences", [])
            ],
            "original_trip_id": normalize(item.get("original_trip_id", "")),
            "service_id": normalize(item.get("service_id", "")),
        })

    return {
        "routes": model_routes,
        "stops": model_stops,
        "trips": model_trips,
        "directions": model_directions,
        "stop_times": model_stop_times,
        "active_service_ids": active_service_ids,
    }


def build_model_realtime_trips(logical_trips, trips_by_id):
    direction_by_source_trip = {}

    for logical_trip in logical_trips:
        if logical_trip.get("is_deleted", False):
            continue
        direction_code = int(logical_trip["direction_code"])
        for source_trip_id in logical_trip.get("original_trip_ids", []):
            direction_by_source_trip[source_trip_id] = direction_code

    result = []
    for trip_id, trip in trips_by_id.items():
        direction_code = direction_by_source_trip.get(trip_id)
        if direction_code is None:
            continue
        result.append({
            "trip_id": normalize(trip_id),
            "route_id": normalize(trip.get("route_id")),
            "service_id": normalize(trip.get("service_id")),
            "trip_headsign": normalize(trip.get("trip_headsign")),
            "direction_id": normalize(trip.get("direction_id")),
            "shape_id": normalize(trip.get("shape_id")),
            "direction_code": direction_code,
        })
    return result
