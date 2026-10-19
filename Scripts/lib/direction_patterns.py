"""Identify route directions and merge partial/logical trips."""

from collections import defaultdict

from .common import normalize, parse_time

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

            "car":
                extract_car_number(
                    trip_id
                ),

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

def extract_car_number(
    trip_id
):
    parts = trip_id.split(
        "-"
    )

    if trip_id.startswith(
        "M"
    ):

        return (
            parts[2]
            if len(parts) > 2
            else ""
        )

    return (
        parts[-3]
        if len(parts) >= 3
        else ""
    )

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
