"""Reference direction detection from ordered stop patterns."""

from collections import defaultdict

from ..utils import normalize, parse_time


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

            "car":
                extract_car_number(
                    trip_id
                ),

            "original_trip_id":
                trip_id,
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
