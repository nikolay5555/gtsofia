#!/usr/bin/env python3

import csv
import io
import json
import shutil
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
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


def normalize_gtfs_stop_id(stop_id):
    """
    Same normalization as Dimitar5555's 04-schedules.js:

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
        char
        for char in stop_id
        if char.isdigit()
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


def get_today():
    """
    Dimitar5555 uses:

        new Date().toISOString()

    so the reference date is UTC.
    """

    return datetime.now(
        timezone.utc
    ).date()


def is_weekend_date(current):
    """
    Same holiday treatment as 03-routes.js.
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

    if current.weekday() >= 5:
        return True

    return current.strftime(
        "%m-%d"
    ) in always_weekend


def parse_time_to_minutes(value):
    value = normalize(value)

    if not value:
        return None

    try:
        h, m, s = map(
            int,
            value.split(":")
        )

        return h * 60 + m

    except (
        TypeError,
        ValueError
    ):
        return None


def route_type(route_type):
    mapping = {
        "0": "tram",
        "1": "metro",
        "3": "bus",
        "11": "trolleybus",
    }

    return mapping.get(
        normalize(route_type),
        "other"
    )


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
# Active service IDs
#
# Direct Python equivalent of 03-routes.js.
# ============================================================

def get_active_service_ids(
    calendar_dates,
    start_date
):
    """
    Dimitar5555:

        today = current UTC date
        next_15_days = today + 15 days

    Only exception_type === '1' is considered.

    Each service_id gets classified as:
        False = weekday
        True  = weekend / holiday

    Ties go to weekend.
    """

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
            row.get(
                "exception_type"
            )
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
            row.get(
                "service_id"
            )
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

    result = {}

    for service_id, counts in stats.items():

        if (
            counts["weekday_count"]
            > counts["weekend_count"]
        ):

            result[
                service_id
            ] = False

        else:

            result[
                service_id
            ] = True

    print(
        "Active service IDs: "
        f"{len(result)}"
    )

    weekday_count = sum(
        not value
        for value in result.values()
    )

    weekend_count = sum(
        value
        for value in result.values()
    )

    print(
        "Classified services: "
        f"weekday={weekday_count}, "
        f"weekend={weekend_count}"
    )

    return result


# ============================================================
# Trips + stop times
# ============================================================

def load_trips(
    trips_data,
    active_service_ids
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

        if service_id not in active_service_ids:
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

            "is_weekend":
                active_service_ids[
                    service_id
                ],
        }

    return trips_by_id


def load_stop_times(
    stop_times_data,
    trips_by_id
):

    stop_times_by_trip = defaultdict(
        list
    )

    for row in stop_times_data:

        trip_id = normalize(
            row.get(
                "trip_id"
            )
        )

        if trip_id not in trips_by_id:
            continue

        stop_id = normalize_gtfs_stop_id(
            row.get(
                "stop_id"
            )
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
# Direction builder
#
# Direct Python translation of 04-schedules.js, lines 20-75.
# ============================================================

def build_reference_model(
    trips_by_id,
    stop_times_by_trip
):

    trips = []
    directions = []
    stop_times = []

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

        is_weekend_trip = trip[
            "is_weekend"
        ]

        # --------------------------------------------------------
        # Exact equivalent of:
        #
        # directions.find(...)
        # --------------------------------------------------------

        corresponding_direction = None

        for direction in directions:

            route_codes = (
                route_direction_map.get(
                    route_id,
                    set()
                )
            )

            if direction[
                "code"
            ] not in route_codes:

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

            same = True

            for index, stop_id in enumerate(
                direction[
                    "stops"
                ]
            ):

                # JS:
                #
                # trip_stops.indexOf(s) === index
                #
                # Equivalent because both sequences are ordered.
                if stop_id != trip_stops[index]:

                    same = False
                    break

            if same:

                corresponding_direction = (
                    direction
                )

                break

        # --------------------------------------------------------
        # Create direction if necessary.
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
        # Exact equivalent of corresponding_trip = trips.find(...)
        # --------------------------------------------------------

        corresponding_trip = None

        for logical_trip in trips:

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
                    len(trips) + 1,

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

            trips.append(
                corresponding_trip
            )

        corresponding_trip[
            "original_trip_ids"
        ].append(
            original_trip_id
        )

        # --------------------------------------------------------
        # Exact same car extraction as 04-schedules.js.
        # --------------------------------------------------------

        if original_trip_id.startswith("M"):

            parts = (
                original_trip_id.split("-")
            )

            car = (
                parts[2]
                if len(parts) > 2
                else ""
            )

        else:

            parts = (
                original_trip_id.split("-")
            )

            car = (
                parts[-3]
                if len(parts) >= 3
                else ""
            )

        # --------------------------------------------------------
        # Exact time conversion:
        #
        # departure_time -> minutes from midnight
        # --------------------------------------------------------

        times = []

        for stop_time in trip_stop_times:

            value = parse_time_to_minutes(
                stop_time.get(
                    "departure_time"
                )
            )

            times.append(
                value
            )

        stop_times.append({

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
        trips,
        directions,
        stop_times
    )


# ============================================================
# Partial direction merge
#
# Direct Python translation of 04-schedules.js, lines 77-120.
# ============================================================

def merge_partial_directions(
    routes_data,
    trips,
    directions,
    stop_times
):

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

        route_trips = [
            trip
            for trip in trips
            if (
                trip[
                    "cgm_id"
                ]
                == route_id
            )
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
            if (
                direction[
                    "code"
                ]
                in direction_ids
            )
            and not direction.get(
                "is_deleted",
                False
            )
        ]

        # EXACT:
        #
        # .sort((a, b) => b.stops.length - a.stops.length)
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
        # Exact merge logic.
        # --------------------------------------------------------

        for index1, child in enumerate(
            route_dirs
        ):

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

                if (
                    child_string
                    in candidate_string
                ):

                    parent = candidate
                    break

            if parent is None:
                continue

            # ----------------------------------------------------
            # Exact same padding calculation.
            # ----------------------------------------------------

            first_child_stop = child[
                "stops"
            ][0]

            try:

                needed_empty_begin_slots = (
                    parent[
                        "stops"
                    ].index(
                        first_child_stop
                    )
                )

            except ValueError:
                continue

            needed_empty_end_slots = (
                len(
                    parent[
                        "stops"
                    ]
                )
                - needed_empty_begin_slots
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

            # ----------------------------------------------------
            # Move the child trips to parent and pad their times.
            # ----------------------------------------------------

            for trip in trips:

                if trip[
                    "direction"
                ] != child_code:

                    continue

                trip_stop_times = [
                    stop_time
                    for stop_time in stop_times
                    if stop_time[
                        "trip"
                    ]
                    == trip["id"]
                ]

                for item in trip_stop_times:

                    item[
                        "times"
                    ] = (
                        [None]
                        * needed_empty_begin_slots
                        + item[
                            "times"
                        ]
                        + [None]
                        * needed_empty_end_slots
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

            has_orphan_trips = any(
                trip[
                    "direction"
                ]
                == direction_code
                for trip in trips
            )

            if has_orphan_trips:

                print(
                    "WARNING: Direction "
                    f"{direction_code} is marked "
                    "deleted but still has trips."
                )

                continue

            directions.pop(
                index
            )

            directions_by_code.pop(
                direction_code,
                None
            )


# ============================================================
# Trip merge
#
# Direct Python translation of 04-schedules.js, lines 121-151.
# ============================================================

def merge_trips(
    routes_data,
    trips,
    stop_times
):

    for route in routes_data:

        route_id = normalize(
            route.get(
                "route_id"
            )
        )

        route_trips = [
            trip
            for trip in trips
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

            # ----------------------------------------------------
            # Move stop times from trip to same trip.
            # ----------------------------------------------------

            trip_stop_times = [
                item
                for item in stop_times
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

            # Keep original IDs for diagnostics.
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
        # Delete merged trips.
        # --------------------------------------------------------

        for index in range(
            len(trips) - 1,
            -1,
            -1
        ):

            trip = trips[
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

            has_orphan_stop_times = any(
                item[
                    "trip"
                ] == trip_id
                for item in stop_times
            )

            if has_orphan_stop_times:

                print(
                    "WARNING: Trip "
                    f"{trip_id} is marked "
                    "deleted but still has stop times."
                )

                continue

            trips.pop(
                index
            )


# ============================================================
# Representative original trip
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

    if not original_ids:
        return None

    candidates = [
        trips_by_id[trip_id]
        for trip_id in original_ids
        if trip_id in trips_by_id
    ]

    if not candidates:
        return None

    def score(trip):

        starts = []

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

                starts.append(
                    value
                )

        if not starts:
            return 10**9

        return min(
            abs(
                value - 720
            )
            for value in starts
        )

    return min(
        candidates,
        key=score
    )


# ============================================================
# Stop records
# ============================================================

def build_stop_index(
    stops_data
):

    by_code = {}

    for row in stops_data:

        raw_stop_id = normalize(
            row.get(
                "stop_id"
            )
        )

        stop_code = normalize(
            row.get(
                "stop_code"
            )
        )

        if raw_stop_id.startswith("M"):

            public_code = raw_stop_id

        elif stop_code:

            public_code = stop_code.zfill(
                4
            )

        else:

            public_code = normalize_gtfs_stop_id(
                raw_stop_id
            )

        if not public_code:
            continue

        by_code[
            public_code
        ] = row

    return by_code


# ============================================================
# Output directions
# ============================================================

def build_directions_output(
    routes_data,
    directions,
    trips,
    stops_by_code,
    trips_by_id,
    stop_times_by_trip
):

    directions_by_code = {
        direction[
            "code"
        ]:
            direction
        for direction in directions
    }

    result = {}

    for route in routes_data:

        route_id = normalize(
            route.get(
                "route_id"
            )
        )

        route_trips = [
            trip
            for trip in trips
            if (
                trip[
                    "cgm_id"
                ]
                == route_id
            )
        ]

        if not route_trips:
            continue

        # Preserve the order in which surviving direction codes
        # occur in the logical trip list.
        direction_codes = []

        for trip in route_trips:

            code = trip[
                "direction"
            ]

            if code not in direction_codes:

                direction_codes.append(
                    code
                )

        # The site expects A/B.
        surviving = []

        for code in direction_codes:

            direction = directions_by_code.get(
                code
            )

            if direction is None:
                continue

            surviving.append(
                direction
            )

        surviving = surviving[:2]

        output = {}

        for index, direction in enumerate(
            surviving
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

                if stop is None:

                    stop_records.append({
                        "stop_id":
                            stop_id,

                        "name":
                            stop_id
                    })

                    continue

                stop_records.append({
                    "stop_id":
                        stop_id,

                    "name":
                        normalize(
                            stop.get(
                                "stop_name"
                            )
                        )
                })

            direction_trips = [
                trip
                for trip in route_trips
                if trip[
                    "direction"
                ]
                == direction_code
            ]

            representative = None

            if direction_trips:

                representative = (
                    choose_representative_trip(
                        direction_trips[0],
                        trips_by_id,
                        stop_times_by_trip
                    )
                )

            destination = (
                stop_records[-1][
                    "name"
                ]
                if stop_records
                else ""
            )

            key = (
                "A"
                if index == 0
                else "B"
            )

            output[
                key
            ] = {

                # The site's schedules.js uses headsign as the
                # visible direction/destination text.
                #
                # For this generated contract it is the terminal
                # stop of the final surviving direction.
                "headsign":
                    destination,

                "destination":
                    destination,

                "trip_id":
                    (
                        representative[
                            "trip_id"
                        ]
                        if representative
                        else ""
                    ),

                "direction_id":
                    (
                        representative[
                            "direction_id"
                        ]
                        if representative
                        else ""
                    ),

                "shape_id":
                    (
                        representative[
                            "shape_id"
                        ]
                        if representative
                        else ""
                    ),

                "service_id":
                    (
                        representative[
                            "service_id"
                        ]
                        if representative
                        else ""
                    ),

                "frequency":
                    len(direction_trips),

                "stop_count":
                    len(stop_records),

                "stops":
                    stop_records,

                "pattern":
                    [
                        item[
                            "stop_id"
                        ]
                        for item in stop_records
                    ],

                # Temporary value for schedule construction.
                "_direction_code":
                    direction_code,
            }

        if output:

            result[
                route_id
            ] = output

    return result


# ============================================================
# Schedules
# ============================================================

def build_schedules(
    directions_result,
    trips,
    stop_times,
    routes_data
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

            # ----------------------------------------------------
            # Each logical trip can have several accumulated
            # stop_time records after the merges.
            #
            # The reference project keeps all of them.
            # ----------------------------------------------------

            for logical_trip in trips:

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
                    else
                    weekday_courses
                )

                logical_stop_times = [
                    item
                    for item in stop_times
                    if item[
                        "trip"
                    ]
                    == logical_trip[
                        "id"
                    ]
                ]

                for item in logical_stop_times:

                    values = item[
                        "times"
                    ]

                    if not values:
                        continue

                    non_null = [
                        value
                        for value in values
                        if value is not None
                    ]

                    if not non_null:
                        continue

                    first_value = non_null[
                        0
                    ]

                    # Preserve the GTFS hour where possible.
                    # JS schedules.js will normalize 24+ hours.
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

    shapes_path = (
        GTFS_DIR / "shapes.txt"
    )

    if not shapes_path.exists():

        print(
            "shapes.txt not present; "
            "skipping shapes."
        )

        return {}

    shape_ids = {
        normalize(
            shape_id
        )
        for shape_id in shape_ids
        if normalize(
            shape_id
        )
    }

    if not shape_ids:
        return {}

    points = defaultdict(
        list
    )

    with shapes_path.open(
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

    # --------------------------------------------------------
    # 1. Download GTFS
    # --------------------------------------------------------

    download_gtfs()

    try:

        # ----------------------------------------------------
        # 2. Read GTFS
        # ----------------------------------------------------

        print(
            "Reading routes.txt..."
        )

        routes_data = read_csv(
            "routes.txt"
        )

        print(
            "Reading stops.txt..."
        )

        stops_data = read_csv(
            "stops.txt"
        )

        print(
            "Reading trips.txt..."
        )

        trips_data = read_csv(
            "trips.txt"
        )

        print(
            "Reading stop_times.txt..."
        )

        stop_times_data = read_csv(
            "stop_times.txt"
        )

        print(
            "Reading calendar_dates.txt..."
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

        # ----------------------------------------------------
        # 3. Active services
        # ----------------------------------------------------

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

        # ----------------------------------------------------
        # 4. Stops
        # ----------------------------------------------------

        stops_by_code = build_stop_index(
            stops_data
        )

        # ----------------------------------------------------
        # 5. Active trips
        # ----------------------------------------------------

        trips_by_id = load_trips(
            trips_data,
            active_service_ids
        )

        print(
            "Active trips: "
            f"{len(trips_by_id)}"
        )

        # ----------------------------------------------------
        # 6. Stop times
        # ----------------------------------------------------

        stop_times_by_trip = load_stop_times(
            stop_times_data,
            trips_by_id
        )

        print(
            "Trips with stop times: "
            f"{len(stop_times_by_trip)}"
        )

        # ----------------------------------------------------
        # 7. EXACT reference direction algorithm
        # ----------------------------------------------------

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

        # ----------------------------------------------------
        # 8. EXACT partial direction merge
        # ----------------------------------------------------

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

        # ----------------------------------------------------
        # 9. EXACT trip merge
        # ----------------------------------------------------

        merge_trips(
            routes_data,
            logical_trips,
            logical_stop_times
        )

        print(
            "Logical trips after merge: "
            f"{len(logical_trips)}"
        )

        # ----------------------------------------------------
        # 10. Output directions
        # ----------------------------------------------------

        directions_result = (
            build_directions_output(
                routes_data,
                directions,
                logical_trips,
                stops_by_code,
                trips_by_id,
                stop_times_by_trip
            )
        )

        # ----------------------------------------------------
        # 11. Schedules
        # ----------------------------------------------------

        schedules_result = build_schedules(
            directions_result,
            logical_trips,
            logical_stop_times,
            routes_data
        )

        # ----------------------------------------------------
        # 12. Shapes
        # ----------------------------------------------------

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

        # ----------------------------------------------------
        # 13. Remove internal helper field
        # ----------------------------------------------------

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

        # ----------------------------------------------------
        # 14. Final transport.json
        # ----------------------------------------------------

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

        # ----------------------------------------------------
        # Diagnostics
        # ----------------------------------------------------

        print(
            ""
        )

        print(
            "=== Generation summary ==="
        )

        print(
            "Routes in output: "
            f"{len(result['routes'])}"
        )

        print(
            "Directions in output: "
            f"{len(result['directions'])}"
        )

        print(
            "Schedule routes in output: "
            f"{len(result['schedules'])}"
        )

        print(
            ""
        )

        print(
            "=== Direction diagnostics ==="
        )

        # Print every generated route's A/B destinations.
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

            a_name = (
                a.get(
                    "headsign"
                )
                if a
                else "-"
            )

            b_name = (
                b.get(
                    "headsign"
                )
                if b
                else "-"
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
                f"A={a_name} | "
                f"B={b_name} | "
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


if __name__ == "__main__":
    main()
