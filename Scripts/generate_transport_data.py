#!/usr/bin/env python3

import csv
import io
import json
import shutil
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


# ============================================================
# Configuration
# ============================================================

GTFS_URL = "https://gtfs.sofiatraffic.bg/api/v1/static"

ROOT = Path(__file__).resolve().parent.parent

DATA_DIR = ROOT / "data"
GTFS_DIR = ROOT / ".gtfs"

OUTPUT_FILE = DATA_DIR / "transport.json"


# ============================================================
# Helpers
# ============================================================

def normalize(value):
    return str(value).strip() if value is not None else ""


def normalize_stop_id(stop_id):
    """
    Exact normalization used by Dimitar5555's 04-schedules.js:

        st.stop_id.startsWith('M')
            ? st.stop_id
            : st.stop_id.replace(/\D/g, '').padStart(4, '0')
    """

    stop_id = normalize(stop_id)

    if not stop_id:
        return ""

    if stop_id.startswith("M"):
        return stop_id

    digits = "".join(
        ch
        for ch in stop_id
        if ch.isdigit()
    )

    return digits.zfill(4)


def parse_gtfs_date(value):
    value = normalize(value)

    if not value:
        return None

    try:
        return datetime.strptime(
            value,
            "%Y%m%d"
        ).date()
    except ValueError:
        return None


def parse_time_to_minutes(value):
    value = normalize(value)

    if not value:
        return None

    try:
        hours, minutes, seconds = map(
            int,
            value.split(":")
        )

        return (
            hours * 60
            + minutes
        )

    except (
        TypeError,
        ValueError
    ):
        return None


def get_today():
    """
    Dimitar5555 uses JavaScript toISOString(), which is UTC based.
    """

    return datetime.now(
        timezone.utc
    ).date()


def is_weekend_date(current):
    """
    Same holiday classification as 03-routes.js.
    """

    always_weekend = {
        "01-01",
        "03-03",
        "01-05",
        "06-05",
        "24-05",
        "06-09",
        "22-09",
        "01-11",
        "24-12",
        "25-12",
        "26-12",
    }

    return (
        current.weekday() >= 5
        or current.strftime("%m-%d")
        in always_weekend
    )


def get_route_destination_labels(route):
    """
    Match the existing gtsofia frontend fallback:

        route_long_name = "FROM - TO"

        A = TO
        B = FROM

    This is intentionally NOT taken from the last stop name and
    NOT taken from trip_headsign.
    """

    route_long_name = normalize(
        route.get("route_long_name")
    )

    parts = [
        part.strip()
        for part in route_long_name.split(" - ")
        if part.strip()
    ]

    if len(parts) >= 2:
        return {
            "A": parts[1],
            "B": parts[0],
        }

    if len(parts) == 1:
        return {
            "A": parts[0],
            "B": parts[0],
        }

    return {
        "A": "",
        "B": "",
    }


# ============================================================
# GTFS download
# ============================================================

def download_gtfs():

    print(
        f"Downloading official GTFS: {GTFS_URL}"
    )

    request = urllib.request.Request(
        GTFS_URL,
        headers={
            "User-Agent": "GTSofia/1.0"
        }
    )

    with urllib.request.urlopen(
        request,
        timeout=600
    ) as response:

        payload = response.read()

    if not payload.startswith(b"PK"):

        raise RuntimeError(
            "GTFS endpoint did not return a ZIP archive."
        )

    print(
        "Downloaded GTFS archive: "
        f"{len(payload) / 1024 / 1024:.2f} MB"
    )

    if GTFS_DIR.exists():
        shutil.rmtree(
            GTFS_DIR
        )

    GTFS_DIR.mkdir(
        parents=True,
        exist_ok=True
    )

    with zipfile.ZipFile(
        io.BytesIO(payload)
    ) as archive:

        names = {
            Path(name).name
            for name in archive.namelist()
        }

        required = {
            "routes.txt",
            "stops.txt",
            "trips.txt",
            "stop_times.txt",
            "calendar_dates.txt",
        }

        missing = required - names

        if missing:

            raise RuntimeError(
                "GTFS archive is missing required files: "
                + ", ".join(
                    sorted(missing)
                )
            )

        archive.extractall(
            GTFS_DIR
        )

    print(
        f"GTFS extracted to: {GTFS_DIR}"
    )


# ============================================================
# CSV
# ============================================================

def read_csv(filename):

    path = GTFS_DIR / filename

    if not path.exists():

        raise FileNotFoundError(
            f"Missing GTFS file: {path}"
        )

    with path.open(
        "r",
        encoding="utf-8-sig",
        newline=""
    ) as file:

        return list(
            csv.DictReader(file)
        )


# ============================================================
# Active services
#
# Python translation of 03-routes.js
# ============================================================

def get_active_service_ids(
    calendar_dates,
    start_date
):

    end_date = (
        start_date
        + timedelta(days=15)
    )

    stats = defaultdict(
        lambda: {
            "weekday_count": 0,
            "weekend_count": 0,
        }
    )

    for row in calendar_dates:

        if normalize(
            row.get("exception_type")
        ) != "1":

            continue

        current = parse_gtfs_date(
            row.get("date")
        )

        if current is None:
            continue

        if current < start_date:
            continue

        if current > end_date:
            continue

        service_id = normalize(
            row.get("service_id")
        )

        if not service_id:
            continue

        if is_weekend_date(
            current
        ):

            stats[
                service_id
            ][
                "weekend_count"
            ] += 1

        else:

            stats[
                service_id
            ][
                "weekday_count"
            ] += 1

    active_service_ids = {}

    for service_id, counts in stats.items():

        # Same rule as 03-routes.js:
        # tie => weekend.
        active_service_ids[
            service_id
        ] = (
            counts["weekday_count"]
            <= counts["weekend_count"]
        )

    weekday_count = sum(
        value is False
        for value in active_service_ids.values()
    )

    weekend_count = sum(
        value is True
        for value in active_service_ids.values()
    )

    print(
        "Active service IDs: "
        f"{len(active_service_ids)}"
    )

    print(
        "Service classification: "
        f"weekday={weekday_count}, "
        f"weekend={weekend_count}"
    )

    return active_service_ids


# ============================================================
# Trips
# ============================================================

def load_trips(
    trips_data,
    active_service_ids
):

    trips_by_id = {}

    for row in trips_data:

        trip_id = normalize(
            row.get("trip_id")
        )

        if not trip_id:
            continue

        service_id = normalize(
            row.get("service_id")
        )

        if service_id not in active_service_ids:
            continue

        trips_by_id[
            trip_id
        ] = {
            "trip_id":
                trip_id,

            "route_id":
                normalize(
                    row.get("route_id")
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

            "is_weekend":
                active_service_ids[
                    service_id
                ],
        }

    return trips_by_id


# ============================================================
# Stop times
# ============================================================

def load_stop_times(
    stop_times_data,
    trips_by_id
):

    stop_times_by_trip = defaultdict(
        list
    )

    for row in stop_times_data:

        trip_id = normalize(
            row.get("trip_id")
        )

        if trip_id not in trips_by_id:
            continue

        stop_id = normalize_stop_id(
            row.get("stop_id")
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

        stop_times_by_trip[
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

    for trip_id in stop_times_by_trip:

        stop_times_by_trip[
            trip_id
        ].sort(
            key=lambda item:
                item["sequence"]
        )

    return stop_times_by_trip


# ============================================================
# Build directions and logical trips
#
# Direct translation of 04-schedules.js
# ============================================================

def build_reference_model(
    trips_by_id,
    stop_times_by_trip
):

    logical_trips = []
    directions = []
    logical_stop_times = []

    route_direction_map = defaultdict(
        set
    )

    for original_trip_id, trip in (
        trips_by_id.items()
    ):

        trip_stop_times = (
            stop_times_by_trip.get(
                original_trip_id,
                []
            )
        )

        trip_stops = [
            item["stop_id"]
            for item in trip_stop_times
        ]

        if not trip_stops:
            continue

        route_id = trip[
            "route_id"
        ]

        if not route_id:
            continue

        is_weekend_trip = trip[
            "is_weekend"
        ]

        # --------------------------------------------------------
        # Exact equivalent of directions.find(...)
        # --------------------------------------------------------

        corresponding_direction = None

        for direction in directions:

            if direction[
                "code"
            ] not in route_direction_map[
                route_id
            ]:

                continue

            if (
                len(
                    direction[
                        "stops"
                    ]
                )
                != len(trip_stops)
            ):

                continue

            same = all(
                direction["stops"][index]
                == trip_stops[index]
                for index in range(
                    len(trip_stops)
                )
            )

            if same:

                corresponding_direction = (
                    direction
                )

                break

        # --------------------------------------------------------
        # Create a new direction exactly as reference.
        # --------------------------------------------------------

        if corresponding_direction is None:

            corresponding_direction = {

                "code":
                    len(directions) + 1,

                "stops":
                    list(trip_stops),
            }

            directions.append(
                corresponding_direction
            )

            route_direction_map[
                route_id
            ].add(
                corresponding_direction[
                    "code"
                ]
            )

        direction_code = (
            corresponding_direction[
                "code"
            ]
        )

        # --------------------------------------------------------
        # Exact equivalent of logical trip grouping.
        # --------------------------------------------------------

        corresponding_trip = None

        for logical_trip in logical_trips:

            if (
                logical_trip[
                    "cgm_id"
                ]
                != route_id
            ):
                continue

            if (
                logical_trip[
                    "direction"
                ]
                != direction_code
            ):
                continue

            if (
                logical_trip[
                    "is_weekend"
                ]
                != is_weekend_trip
            ):
                continue

            if logical_trip.get(
                "is_deleted",
                False
            ):
                continue

            corresponding_trip = (
                logical_trip
            )

            break

        if corresponding_trip is None:

            corresponding_trip = {

                "id":
                    len(logical_trips) + 1,

                "cgm_id":
                    route_id,

                "direction":
                    direction_code,

                "is_weekend":
                    is_weekend_trip,

                "is_deleted":
                    False,

                "original_trip_ids":
                    [],
            }

            logical_trips.append(
                corresponding_trip
            )

        corresponding_trip[
            "original_trip_ids"
        ].append(
            original_trip_id
        )

        # --------------------------------------------------------
        # Same car extraction as 04-schedules.js.
        # --------------------------------------------------------

        if original_trip_id.startswith("M"):

            pieces = (
                original_trip_id.split("-")
            )

            car = (
                pieces[2]
                if len(pieces) > 2
                else ""
            )

        else:

            pieces = (
                original_trip_id.split("-")
            )

            car = (
                pieces[-3]
                if len(pieces) >= 3
                else ""
            )

        # --------------------------------------------------------
        # Same time conversion:
        # departure_time -> minutes from midnight.
        # --------------------------------------------------------

        times = []

        for item in trip_stop_times:

            parsed = parse_time_to_minutes(
                item.get(
                    "departure_time"
                )
            )

            times.append(
                parsed
            )

        logical_stop_times.append({

            "trip":
                corresponding_trip[
                    "id"
                ],

            "times":
                times,

            "car":
                car,

            "original_trip_id":
                original_trip_id,
        })

    return (
        logical_trips,
        directions,
        logical_stop_times
    )


# ============================================================
# Partial-direction merge
#
# Direct translation of 04-schedules.js
# ============================================================

def merge_partial_directions(
    routes_data,
    logical_trips,
    directions,
    logical_stop_times
):

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
                "cgm_id"
            ] == route_id
        ]

        direction_ids = [
            trip[
                "direction"
            ]
            for trip in route_trips
        ]

        route_dirs = [
            direction
            for direction in directions
            if direction[
                "code"
            ] in direction_ids
        ]

        route_dirs.sort(
            key=lambda direction:
                len(
                    direction[
                        "stops"
                    ]
                ),
            reverse=True
        )

        # --------------------------------------------------------
        # Exact partial direction algorithm.
        # --------------------------------------------------------

        for index1, child in enumerate(
            route_dirs
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

            for index2, candidate in enumerate(
                route_dirs
            ):

                if index2 == index1:
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

                if child_string in candidate_string:

                    parent = candidate
                    break

            if parent is None:
                continue

            first_child_stop = child[
                "stops"
            ][0]

            try:

                begin_slots = (
                    parent[
                        "stops"
                    ].index(
                        first_child_stop
                    )
                )

            except ValueError:

                continue

            end_slots = (
                len(
                    parent[
                        "stops"
                    ]
                )
                - begin_slots
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

            for trip in logical_trips:

                if (
                    trip[
                        "direction"
                    ]
                    != child_code
                ):
                    continue

                trip_stop_times = [
                    item
                    for item in logical_stop_times
                    if item[
                        "trip"
                    ] == trip["id"]
                ]

                for item in trip_stop_times:

                    item[
                        "times"
                    ] = (
                        [None]
                        * begin_slots
                        + item[
                            "times"
                        ]
                        + [None]
                        * end_slots
                    )

                trip[
                    "direction"
                ] = parent[
                    "code"
                ]

        # --------------------------------------------------------
        # Delete merged directions.
        # --------------------------------------------------------

        for index in range(
            len(directions) - 1,
            -1,
            -1
        ):

            direction = directions[
                index
            ]

            if not direction.get(
                "is_deleted",
                False
            ):

                continue

            direction_code = direction[
                "code"
            ]

            if any(
                trip[
                    "direction"
                ]
                == direction_code
                for trip in logical_trips
            ):

                print(
                    "WARNING: direction "
                    f"{direction_code} still has trips."
                )

                continue

            directions.pop(
                index
            )


# ============================================================
# Merge logical trips
#
# Direct translation of 04-schedules.js
# ============================================================

def merge_logical_trips(
    routes_data,
    logical_trips,
    logical_stop_times
):

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
                "cgm_id"
            ] == route_id
        ]

        for index1, trip in enumerate(
            route_trips
        ):

            if trip.get(
                "is_deleted",
                False
            ):
                continue

            same = None

            for index2, candidate in enumerate(
                route_trips
            ):

                if index2 == index1:
                    continue

                if candidate.get(
                    "is_deleted",
                    False
                ):
                    continue

                if (
                    candidate[
                        "direction"
                    ]
                    != trip[
                        "direction"
                    ]
                ):
                    continue

                if (
                    candidate[
                        "is_weekend"
                    ]
                    != trip[
                        "is_weekend"
                    ]
                ):
                    continue

                same = candidate
                break

            if same is None:
                continue

            trip_stop_times = [
                item
                for item in logical_stop_times
                if item[
                    "trip"
                ] == trip["id"]
            ]

            for item in trip_stop_times:

                item[
                    "trip"
                ] = same[
                    "id"
                ]

            same.setdefault(
                "original_trip_ids",
                []
            )

            same[
                "original_trip_ids"
            ].extend(
                trip.get(
                    "original_trip_ids",
                    []
                )
            )

            trip[
                "is_deleted"
            ] = True

        # --------------------------------------------------------
        # Delete merged logical trips.
        # --------------------------------------------------------

        for index in range(
            len(logical_trips) - 1,
            -1,
            -1
        ):

            trip = logical_trips[
                index
            ]

            if not trip.get(
                "is_deleted",
                False
            ):

                continue

            trip_id = trip[
                "id"
            ]

            if any(
                item[
                    "trip"
                ] == trip_id
                for item in logical_stop_times
            ):

                print(
                    "WARNING: trip "
                    f"{trip_id} still has stop times."
                )

                continue

            logical_trips.pop(
                index
            )


# ============================================================
# Stops
# ============================================================

def build_stop_index(
    stops_data
):

    result = {}

    for row in stops_data:

        raw_stop_id = normalize(
            row.get(
                "stop_id"
            )
        )

        normalized_id = normalize_stop_id(
            raw_stop_id
        )

        if not normalized_id:
            continue

        result[
            normalized_id
        ] = row

    return result


# ============================================================
# Representative trip
# ============================================================

def choose_representative_trip(
    logical_trip,
    trips_by_id,
    stop_times_by_trip
):

    original_ids = logical_trip.get(
        "original_trip_ids",
        []
    )

    candidates = [
        trips_by_id[
            trip_id
        ]
        for trip_id in original_ids
        if trip_id in trips_by_id
    ]

    if not candidates:
        return None

    def score(trip):

        values = []

        for item in stop_times_by_trip.get(
            trip["trip_id"],
            []
        ):

            value = parse_time_to_minutes(
                item.get(
                    "departure_time"
                )
            )

            if value is not None:
                values.append(
                    value
                )

        if not values:
            return 10**9

        return min(
            abs(
                value - 12 * 60
            )
            for value in values
        )

    return min(
        candidates,
        key=score
    )


# ============================================================
# Output directions
# ============================================================

def build_output_directions(
    routes_data,
    directions,
    logical_trips,
    trips_by_id,
    stop_times_by_trip,
    stops_by_code
):

    directions_by_code = {
        direction[
            "code"
        ]:
            direction
        for direction in directions
    }

    output = {}

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
                "cgm_id"
            ] == route_id
        ]

        if not route_trips:
            continue

        # Preserve the exact direction order resulting from the
        # reference generator.
        direction_codes = []

        for trip in route_trips:

            code = trip[
                "direction"
            ]

            if code not in direction_codes:

                direction_codes.append(
                    code
                )

        surviving_directions = []

        for code in direction_codes:

            direction = directions_by_code.get(
                code
            )

            if direction is None:
                continue

            if direction.get(
                "is_deleted",
                False
            ):
                continue

            surviving_directions.append(
                direction
            )

        if not surviving_directions:
            continue

        # --------------------------------------------------------
        # IMPORTANT:
        #
        # We use route_long_name for the visible destination.
        # This reproduces the existing site's correct A/B behavior.
        # --------------------------------------------------------

        destination_labels = (
            get_route_destination_labels(
                route
            )
        )

        route_result = {
            "A": None,
            "B": None,
        }

        # The current website supports two direction selectors.
        for index, direction in enumerate(
            surviving_directions[:2]
        ):

            direction_code = direction[
                "code"
            ]

            stop_records = []

            for stop_id in direction[
                "stops"
            ]:

                stop = stops_by_code.get(
                    stop_id
                )

                stop_records.append({

                    "stop_id":
                        stop_id,

                    "name":
                        (
                            normalize(
                                stop.get(
                                    "stop_name"
                                )
                            )
                            if stop
                            else stop_id
                        ),
                })

            direction_trips = [
                trip
                for trip in route_trips
                if trip[
                    "direction"
                ] == direction_code
            ]

            representative_trip = None

            if direction_trips:

                representative_trip = (
                    choose_representative_trip(
                        direction_trips[0],
                        trips_by_id,
                        stop_times_by_trip
                    )
                )

            key = (
                "A"
                if index == 0
                else "B"
            )

            headsign = destination_labels.get(
                key,
                ""
            )

            # Fallback hierarchy:
            # 1. route_long_name
            # 2. representative trip_headsign
            # 3. final stop name
            if not headsign and representative_trip:

                headsign = normalize(
                    representative_trip.get(
                        "trip_headsign"
                    )
                )

            if not headsign and stop_records:

                headsign = stop_records[
                    -1
                ][
                    "name"
                ]

            route_result[
                key
            ] = {

                "headsign":
                    headsign,

                "destination":
                    headsign,

                "trip_id":
                    (
                        representative_trip[
                            "trip_id"
                        ]
                        if representative_trip
                        else ""
                    ),

                "direction_id":
                    (
                        representative_trip[
                            "direction_id"
                        ]
                        if representative_trip
                        else ""
                    ),

                "shape_id":
                    (
                        representative_trip[
                            "shape_id"
                        ]
                        if representative_trip
                        else ""
                    ),

                "service_id":
                    (
                        representative_trip[
                            "service_id"
                        ]
                        if representative_trip
                        else ""
                    ),

                "frequency":
                    len(direction_trips),

                "stop_count":
                    len(stop_records),

                "stops":
                    stop_records,

                "_direction_code":
                    direction_code,
            }

        if (
            route_result["A"]
            or route_result["B"]
        ):

            output[
                route_id
            ] = route_result

    return output


# ============================================================
# Schedules
# ============================================================

def build_schedules(
    directions_result,
    logical_trips,
    logical_stop_times
):

    schedules = {}

    for route_id, route_directions in (
        directions_result.items()
    ):

        route_schedule = {}

        for direction_key in (
            "A",
            "B"
        ):

            direction = route_directions.get(
                direction_key
            )

            if not direction:
                continue

            direction_code = direction[
                "_direction_code"
            ]

            weekday_courses = []
            weekend_courses = []

            for logical_trip in logical_trips:

                if (
                    logical_trip[
                        "cgm_id"
                    ]
                    != route_id
                ):
                    continue

                if (
                    logical_trip[
                        "direction"
                    ]
                    != direction_code
                ):
                    continue

                if logical_trip.get(
                    "is_deleted",
                    False
                ):
                    continue

                target = (
                    weekend_courses
                    if logical_trip[
                        "is_weekend"
                    ]
                    else weekday_courses
                )

                trip_stop_times = [
                    item
                    for item in logical_stop_times
                    if item[
                        "trip"
                    ] == logical_trip[
                        "id"
                    ]
                ]

                for item in trip_stop_times:

                    values = item[
                        "times"
                    ]

                    if not values:
                        continue

                    if not any(
                        value is not None
                        for value in values
                    ):
                        continue

                    first_value = next(
                        value
                        for value in values
                        if value is not None
                    )

                    start_time = (
                        f"{first_value // 60:02d}:"
                        f"{first_value % 60:02d}:00"
                    )

                    target.append({

                        "trip_id":
                            logical_trip[
                                "id"
                            ],

                        "start_time":
                            start_time,

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

                        "car":
                            item.get(
                                "car",
                                ""
                            ),
                    })

            weekday_courses.sort(
                key=lambda course:
                    parse_time_to_minutes(
                        course[
                            "start_time"
                        ]
                    )
                    if parse_time_to_minutes(
                        course[
                            "start_time"
                        ]
                    ) is not None
                    else 10**9
            )

            weekend_courses.sort(
                key=lambda course:
                    parse_time_to_minutes(
                        course[
                            "start_time"
                        ]
                    )
                    if parse_time_to_minutes(
                        course[
                            "start_time"
                        ]
                    ) is not None
                    else 10**9
            )

            route_schedule[
                direction_key
            ] = {

                "weekday":
                    weekday_courses,

                "weekend":
                    weekend_courses,
            }

        if route_schedule:

            schedules[
                route_id
            ] = route_schedule

    return schedules


# ============================================================
# Shapes
# ============================================================

def load_shapes(
    shape_ids
):

    path = (
        GTFS_DIR / "shapes.txt"
    )

    if not path.exists():

        print(
            "WARNING: shapes.txt not present."
        )

        return {}

    shape_ids = {
        normalize(
            shape_id
        )
        for shape_id in shape_ids
        if normalize(shape_id)
    }

    if not shape_ids:
        return {}

    points = defaultdict(
        list
    )

    with path.open(
        "r",
        encoding="utf-8-sig",
        newline=""
    ) as file:

        reader = csv.DictReader(
            file
        )

        for row in reader:

            shape_id = normalize(
                row.get(
                    "shape_id"
                )
            )

            if shape_id not in shape_ids:
                continue

            try:

                lat = float(
                    row.get(
                        "shape_pt_lat"
                    )
                )

                lon = float(
                    row.get(
                        "shape_pt_lon"
                    )
                )

                sequence = int(
                    row.get(
                        "shape_pt_sequence",
                        0
                    )
                )

            except (
                TypeError,
                ValueError
            ):

                continue

            points[
                shape_id
            ].append({

                "lat":
                    lat,

                "lon":
                    lon,

                "sequence":
                    sequence,
            })

    result = {}

    for shape_id, items in points.items():

        items.sort(
            key=lambda item:
                item[
                    "sequence"
                ]
        )

        result[
            shape_id
        ] = [
            {
                "lat":
                    item[
                        "lat"
                    ],

                "lon":
                    item[
                        "lon"
                    ],
            }
            for item in items
        ]

    return result


# ============================================================
# Main
# ============================================================

def main():

    print(
        "=== Sofia GTFS transport generator ==="
    )

    download_gtfs()

    try:

        # --------------------------------------------------------
        # 1. Read GTFS
        # --------------------------------------------------------

        routes_data = read_csv(
            "routes.txt"
        )

        stops_data = read_csv(
            "stops.txt"
        )

        trips_data = read_csv(
            "trips.txt"
        )

        stop_times_data = read_csv(
            "stop_times.txt"
        )

        calendar_dates_data = read_csv(
            "calendar_dates.txt"
        )

        print(
            f"Routes: {len(routes_data)}"
        )

        print(
            f"Stops: {len(stops_data)}"
        )

        print(
            f"Trips: {len(trips_data)}"
        )

        print(
            f"Stop times: {len(stop_times_data)}"
        )

        # --------------------------------------------------------
        # 2. Active services
        # --------------------------------------------------------

        today = get_today()

        print(
            f"Service reference date: {today}"
        )

        active_service_ids = (
            get_active_service_ids(
                calendar_dates_data,
                today
            )
        )

        # --------------------------------------------------------
        # 3. Stops
        # --------------------------------------------------------

        stops_by_code = build_stop_index(
            stops_data
        )

        # --------------------------------------------------------
        # 4. Trips
        # --------------------------------------------------------

        trips_by_id = load_trips(
            trips_data,
            active_service_ids
        )

        print(
            "Active trips: "
            f"{len(trips_by_id)}"
        )

        # --------------------------------------------------------
        # 5. Stop times
        # --------------------------------------------------------

        stop_times_by_trip = load_stop_times(
            stop_times_data,
            trips_by_id
        )

        print(
            "Trips with stop times: "
            f"{len(stop_times_by_trip)}"
        )

        # --------------------------------------------------------
        # 6. Exact 04-schedules.js direction construction
        # --------------------------------------------------------

        (
            logical_trips,
            directions,
            logical_stop_times
        ) = build_reference_model(
            trips_by_id,
            stop_times_by_trip
        )

        print(
            "Initial directions: "
            f"{len(directions)}"
        )

        print(
            "Initial logical trips: "
            f"{len(logical_trips)}"
        )

        # --------------------------------------------------------
        # 7. Partial directions
        # --------------------------------------------------------

        merge_partial_directions(
            routes_data,
            logical_trips,
            directions,
            logical_stop_times
        )

        print(
            "Directions after partial merge: "
            f"{len(directions)}"
        )

        # --------------------------------------------------------
        # 8. Merge logical trips
        # --------------------------------------------------------

        merge_logical_trips(
            routes_data,
            logical_trips,
            logical_stop_times
        )

        print(
            "Logical trips after merge: "
            f"{len(logical_trips)}"
        )

        # --------------------------------------------------------
        # 9. Build output directions.
        #
        # IMPORTANT:
        # Visible A/B text comes from route_long_name.
        # --------------------------------------------------------

        directions_result = (
            build_output_directions(
                routes_data,
                directions,
                logical_trips,
                trips_by_id,
                stop_times_by_trip,
                stops_by_code
            )
        )

        # --------------------------------------------------------
        # 10. Build schedules
        # --------------------------------------------------------

        schedules_result = build_schedules(
            directions_result,
            logical_trips,
            logical_stop_times
        )

        # --------------------------------------------------------
        # 11. Shapes
        # --------------------------------------------------------

        selected_shape_ids = set()

        for route_directions in (
            directions_result.values()
        ):

            for direction_key in (
                "A",
                "B"
            ):

                direction = route_directions.get(
                    direction_key
                )

                if not direction:
                    continue

                shape_id = normalize(
                    direction.get(
                        "shape_id"
                    )
                )

                if shape_id:
                    selected_shape_ids.add(
                        shape_id
                    )

        shapes_result = load_shapes(
            selected_shape_ids
        )

        # --------------------------------------------------------
        # 12. Remove internal fields
        # --------------------------------------------------------

        for route_directions in (
            directions_result.values()
        ):

            for direction_key in (
                "A",
                "B"
            ):

                direction = route_directions.get(
                    direction_key
                )

                if direction:

                    direction.pop(
                        "_direction_code",
                        None
                    )

        # --------------------------------------------------------
        # 13. Final JSON
        # --------------------------------------------------------

        result = {

            "updatedAt":
                today.isoformat(),

            "source":
                "CGM Sofia official GTFS",

            "routes":
                [
                    dict(row)
                    for row in routes_data
                ],

            "stops":
                [
                    dict(row)
                    for row in stops_data
                ],

            "trips":
                [
                    dict(row)
                    for row in trips_data
                ],

            "directions":
                directions_result,

            "shapes":
                shapes_result,

            "schedules":
                schedules_result,
        }

        DATA_DIR.mkdir(
            parents=True,
            exist_ok=True
        )

        with OUTPUT_FILE.open(
            "w",
            encoding="utf-8"
        ) as file:

            json.dump(
                result,
                file,
                ensure_ascii=False,
                separators=(
                    ",",
                    ":"
                )
            )

        # --------------------------------------------------------
        # 14. Diagnostics
        # --------------------------------------------------------

        print(
            ""
        )

        print(
            "=== Direction diagnostics ==="
        )

        for route in routes_data:

            route_id = normalize(
                route.get(
                    "route_id"
                )
            )

            short_name = normalize(
                route.get(
                    "route_short_name"
                )
            )

            info = directions_result.get(
                route_id
            )

            if not info:
                continue

            a = info.get(
                "A"
            )

            b = info.get(
                "B"
            )

            schedule_info = schedules_result.get(
                route_id,
                {}
            )

            weekday_a = len(
                schedule_info.get(
                    "A",
                    {}
                ).get(
                    "weekday",
                    []
                )
            )

            weekday_b = len(
                schedule_info.get(
                    "B",
                    {}
                ).get(
                    "weekday",
                    []
                )
            )

            weekend_a = len(
                schedule_info.get(
                    "A",
                    {}
                ).get(
                    "weekend",
                    []
                )
            )

            weekend_b = len(
                schedule_info.get(
                    "B",
                    {}
                ).get(
                    "weekend",
                    []
                )
            )

            print(
                f"{short_name}: "
                f"A={a['headsign'] if a else '-'} | "
                f"B={b['headsign'] if b else '-'} | "
                f"weekday={weekday_a}/{weekday_b} | "
                f"weekend={weekend_a}/{weekend_b}"
            )

        print(
            ""
        )

        print(
            f"Written: {OUTPUT_FILE}"
        )

    finally:

        if GTFS_DIR.exists():

            shutil.rmtree(
                GTFS_DIR
            )

        print(
            "Temporary GTFS files removed."
        )


# ============================================================
# Stop index
# ============================================================

def build_stop_index(
    stops_data
):

    result = {}

    for row in stops_data:

        raw_id = normalize(
            row.get(
                "stop_id"
            )
        )

        normalized_id = normalize_stop_id(
            raw_id
        )

        if not normalized_id:
            continue

        result[
            normalized_id
        ] = row

    return result


if __name__ == "__main__":
    main()
