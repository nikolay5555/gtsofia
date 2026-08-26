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


def normalize_gtfs_stop_id(value):
    """
    Same normalization used by Dimitar5555's 04-schedules.js:

        st.stop_id.startsWith('M')
            ? st.stop_id
            : st.stop_id.replace(/\D/g, '').padStart(4, '0')
    """

    value = normalize(value)

    if not value:
        return ""

    if value.startswith("M"):
        return value

    digits = "".join(
        character
        for character in value
        if character.isdigit()
    )

    return digits.zfill(4)


def parse_time(value):
    value = normalize(value)

    if not value:
        return None

    try:
        h, m, s = map(
            int,
            value.split(":")
        )

        return h * 3600 + m * 60 + s

    except (TypeError, ValueError):
        return None


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

    except (TypeError, ValueError):
        return None


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
    # Match Dimitar5555's project:
    # JavaScript's new Date().toISOString() is UTC-based.
    return datetime.now(
        timezone.utc
    ).date()


def iter_dates(start, days):
    for offset in range(days):
        yield start + timedelta(days=offset)


# ============================================================
# Destination helpers
# ============================================================

def get_route_destination_labels(route):
    """
    The site's existing A/B fallback is based on route_long_name:

        FROM - TO

    therefore:

        A = TO
        B = FROM
    """

    route_long_name = normalize(
        route.get("route_long_name")
    )

    if not route_long_name:
        return {
            "A": "",
            "B": ""
        }

    parts = [
        part.strip()
        for part in route_long_name.split(" - ")
        if part.strip()
    ]

    if len(parts) >= 2:
        return {
            "A": parts[1],
            "B": parts[0]
        }

    if len(parts) == 1:
        return {
            "A": parts[0],
            "B": parts[0]
        }

    return {
        "A": "",
        "B": ""
    }


def normalize_destination_text(value):
    """
    Normalizes destination/stop names only for comparison.

    It does NOT change anything that is written to transport.json.
    """

    value = normalize(value).lower()

    prefixes = [
        "кв.",
        "кв ",
        "ж.к.",
        "ж.к ",
        "жк.",
        "жк ",
    ]

    for prefix in prefixes:

        if value.startswith(prefix):
            value = value[
                len(prefix):
            ].strip()

    value = (
        value
        .replace("„", "")
        .replace("“", "")
        .replace('"', "")
        .replace("'", "")
        .replace("-", " ")
        .replace("–", " ")
        .replace("—", " ")
    )

    return " ".join(
        value.split()
    ).strip()


def destination_matches_stop(
    destination,
    stop_name
):
    """
    Compare route_long_name destination with a real final stop name.
    """

    destination = normalize_destination_text(
        destination
    )

    stop_name = normalize_destination_text(
        stop_name
    )

    if not destination or not stop_name:
        return False

    if destination == stop_name:
        return True

    if destination in stop_name:
        return True

    if stop_name in destination:
        return True

    return False


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

        required = {
            "routes.txt",
            "stops.txt",
            "trips.txt",
            "stop_times.txt",
            "calendar_dates.txt"
        }

        names = {
            Path(name).name
            for name in archive.namelist()
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

def open_csv(filename):

    path = GTFS_DIR / filename

    if not path.exists():

        raise FileNotFoundError(
            f"Missing GTFS file: {path}"
        )

    return path.open(
        "r",
        encoding="utf-8-sig",
        newline=""
    )


def read_csv(filename):

    with open_csv(filename) as file:

        return list(
            csv.DictReader(file)
        )


# ============================================================
# Shapes
# ============================================================

def load_selected_shapes(shape_ids):

    shapes_path = GTFS_DIR / "shapes.txt"

    if not shapes_path.exists():

        print(
            "WARNING: shapes.txt is not present in the GTFS feed."
        )

        return {}

    selected_ids = {
        normalize(shape_id)
        for shape_id in shape_ids
        if normalize(shape_id)
    }

    if not selected_ids:
        return {}

    shapes = defaultdict(list)

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
                row.get("shape_id")
            )

            if shape_id not in selected_ids:
                continue

            try:

                lat = float(
                    row.get("shape_pt_lat")
                )

                lon = float(
                    row.get("shape_pt_lon")
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

            shapes[
                shape_id
            ].append({
                "lat":
                    lat,

                "lon":
                    lon,

                "sequence":
                    sequence
            })

    result = {}

    for shape_id, points in shapes.items():

        points.sort(
            key=lambda point:
                point["sequence"]
        )

        result[
            shape_id
        ] = [
            {
                "lat":
                    point["lat"],

                "lon":
                    point["lon"]
            }
            for point in points
        ]

    print(
        f"Selected GTFS shapes: {len(result)}"
    )

    print(
        "Shape points retained: "
        f"{sum(len(points) for points in result.values())}"
    )

    return result


# ============================================================
# Active services
# ============================================================

def get_active_service_weights(
    calendar,
    calendar_dates,
    start_date,
    horizon_days=16
):

    active_by_date = defaultdict(set)

    # --------------------------------------------------------
    # Optional calendar.txt
    # --------------------------------------------------------

    for row in calendar:

        service_id = normalize(
            row.get("service_id")
        )

        if not service_id:
            continue

        start = parse_gtfs_date(
            row.get("start_date")
        )

        end = parse_gtfs_date(
            row.get("end_date")
        )

        if start is None:
            start = date.min

        if end is None:
            end = date.max

        weekdays = {
            0: normalize(row.get("monday")) == "1",
            1: normalize(row.get("tuesday")) == "1",
            2: normalize(row.get("wednesday")) == "1",
            3: normalize(row.get("thursday")) == "1",
            4: normalize(row.get("friday")) == "1",
            5: normalize(row.get("saturday")) == "1",
            6: normalize(row.get("sunday")) == "1",
        }

        for current in iter_dates(
            start_date,
            horizon_days
        ):

            if current < start or current > end:
                continue

            if weekdays[
                current.weekday()
            ]:

                active_by_date[
                    current
                ].add(
                    service_id
                )

    # --------------------------------------------------------
    # calendar_dates.txt
    # --------------------------------------------------------

    for row in calendar_dates:

        service_id = normalize(
            row.get("service_id")
        )

        current = parse_gtfs_date(
            row.get("date")
        )

        if not service_id or current is None:
            continue

        if not (
            start_date
            <= current
            < start_date
            + timedelta(days=horizon_days)
        ):

            continue

        try:

            exception_type = int(
                row.get(
                    "exception_type",
                    0
                )
            )

        except (
            TypeError,
            ValueError
        ):

            exception_type = 0

        if exception_type == 1:

            active_by_date[
                current
            ].add(
                service_id
            )

        elif exception_type == 2:

            active_by_date[
                current
            ].discard(
                service_id
            )

    weights = defaultdict(int)

    for service_ids in active_by_date.values():

        for service_id in service_ids:

            weights[
                service_id
            ] += 1

    print(
        "Active service IDs in next "
        f"{horizon_days} days: "
        f"{len(weights)}"
    )

    print(
        "Service dates considered: "
        f"{len(active_by_date)}"
    )

    return dict(weights)


def get_service_day_sets(
    calendar_dates,
    start_date,
    horizon_days=16
):

    service_stats = defaultdict(
        lambda: {
            "weekday_count": 0,
            "weekend_count": 0
        }
    )

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

    horizon_end = (
        start_date
        + timedelta(
            days=horizon_days
        )
    )

    for row in calendar_dates:

        service_id = normalize(
            row.get("service_id")
        )

        current = parse_gtfs_date(
            row.get("date")
        )

        if not service_id or current is None:
            continue

        if not (
            start_date
            <= current
            < horizon_end
        ):
            continue

        if normalize(
            row.get("exception_type")
        ) != "1":

            continue

        mm_dd = current.strftime(
            "%m-%d"
        )

        is_weekend = (
            current.weekday() >= 5
            or mm_dd in always_weekend
        )

        if is_weekend:

            service_stats[
                service_id
            ][
                "weekend_count"
            ] += 1

        else:

            service_stats[
                service_id
            ][
                "weekday_count"
            ] += 1

    weekday = set()
    weekend = set()

    for service_id, counts in (
        service_stats.items()
    ):

        if (
            counts["weekday_count"]
            > counts["weekend_count"]
        ):

            weekday.add(
                service_id
            )

        else:

            weekend.add(
                service_id
            )

    return weekday, weekend


# ============================================================
# Direction model
# ============================================================

def build_reference_direction_data(
    trips_by_id,
    stop_times_by_trip,
    service_weights
):

    trips = []
    directions = []
    stop_times = []

    route_direction_map = defaultdict(
        set
    )

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
            item["stop_id"]
            for item in trip_stop_times
        ]

        route_id = trip[
            "route_id"
        ]

        if not trip_stops or not route_id:
            continue

        is_weekend_trip = (
            trip["service_id"]
            in service_weights
        )

        corresponding_direction = None

        for direction in directions:

            if direction[
                "code"
            ] not in route_direction_map[
                route_id
            ]:

                continue

            if (
                len(direction["stops"])
                != len(trip_stops)
            ):

                continue

            if (
                direction["stops"]
                == trip_stops
            ):

                corresponding_direction = (
                    direction
                )

                break

        if corresponding_direction is None:

            corresponding_direction = {

                "code":
                    len(directions) + 1,

                "stops":
                    list(trip_stops),

                "is_deleted":
                    False
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

        corresponding_trip = None

        for existing_trip in trips:

            if (
                existing_trip["cgm_id"]
                != route_id
            ):
                continue

            if (
                existing_trip["direction"]
                != direction_code
            ):
                continue

            if (
                existing_trip["is_weekend"]
                != is_weekend_trip
            ):
                continue

            if existing_trip.get(
                "is_deleted",
                False
            ):
                continue

            corresponding_trip = (
                existing_trip
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
                    []
            }

            trips.append(
                corresponding_trip
            )

        corresponding_trip[
            "original_trip_ids"
        ].append(
            trip_id
        )

        if trip_id.startswith("M"):

            parts = trip_id.split("-")

            car = (
                parts[2]
                if len(parts) > 2
                else ""
            )

        else:

            parts = trip_id.split("-")

            car = (
                parts[-3]
                if len(parts) >= 3
                else ""
            )

        times = []

        for item in trip_stop_times:

            parsed = parse_time(
                item.get(
                    "departure_time"
                )
                or ""
            )

            if parsed is None:

                times.append(
                    None
                )

            else:

                times.append(
                    parsed // 60
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
                trip_id
        })

    return (
        trips,
        directions,
        stop_times
    )


# ============================================================
# Partial direction merge
# ============================================================

def merge_partial_directions(
    routes_data,
    trips,
    directions,
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
            and not direction.get(
                "is_deleted",
                False
            )
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

            try:

                begin_slots = (
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

            for trip in trips:

                if (
                    trip[
                        "direction"
                    ]
                    != child_code
                ):
                    continue

                trip_stop_times = [
                    item
                    for item in stop_times
                    if item[
                        "trip"
                    ] == trip[
                        "id"
                    ]
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

        # Delete merged directions.
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
                for trip in trips
            ):

                continue

            directions.pop(
                index
            )


# ============================================================
# Merge logical trips
# ============================================================

def merge_logical_trips(
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

            trip_stop_times = [
                item
                for item in stop_times
                if item[
                    "trip"
                ] == trip[
                    "id"
                ]
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

            if any(
                item[
                    "trip"
                ] == trip_id
                for item in stop_times
            ):

                continue

            trips.pop(
                index
            )


# ============================================================
# Stop index
# ============================================================

def build_stop_index(
    stops_data
):

    result = {}

    for row in stops_data:

        original_stop_id = normalize(
            row.get(
                "stop_id"
            )
        )

        normalized_id = normalize_gtfs_stop_id(
            original_stop_id
        )

        if not normalized_id:
            continue

        normalized_row = dict(
            row
        )

        normalized_row[
            "_original_stop_id"
        ] = original_stop_id

        # IMPORTANT:
        # Keep the public stop_id normalized so it is identical
        # to the ID stored in directions.stops.
        normalized_row[
            "stop_id"
        ] = normalized_id

        result[
            normalized_id
        ] = normalized_row

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
            trip[
                "trip_id"
            ],
            []
        ):

            value = parse_time(
                item.get(
                    "departure_time"
                )
                or item.get(
                    "arrival_time"
                )
            )

            if value is not None:
                values.append(
                    value
                )

        if not values:
            return 10**12

        return min(
            abs(
                value
                - 12 * 3600
            )
            for value in values
        )

    return min(
        candidates,
        key=score
    )


# ============================================================
# Direction output
# ============================================================

def build_output_directions(
    routes_data,
    directions,
    logical_trips,
    trips_by_id,
    stop_times_by_trip,
    stops_by_id
):

    directions_by_code = {
        direction[
            "code"
        ]:
            direction
        for direction in directions
    }

    directions_result = {}

    for route in routes_data:

        route_id = normalize(
            route.get(
                "route_id"
            )
        )

        route_trips = [
            trip
            for trip in logical_trips
            if (
                trip[
                    "cgm_id"
                ]
                == route_id
                and not trip.get(
                    "is_deleted",
                    False
                )
            )
        ]

        if not route_trips:
            continue

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
        # FIX 1:
        # Determine which real direction is A and which is B.
        #
        # The GTFS direction order itself is NOT guaranteed to be
        # the site's A/B order.
        # --------------------------------------------------------

        destination_labels = (
            get_route_destination_labels(
                route
            )
        )

        def get_last_stop_name(direction):

            stops = direction.get(
                "stops",
                []
            )

            if not stops:
                return ""

            last_stop_id = stops[-1]

            stop = stops_by_id.get(
                last_stop_id
            )

            if stop is None:
                return ""

            return normalize(
                stop.get(
                    "stop_name"
                )
            )

        if len(surviving_directions) >= 2:

            first_direction = (
                surviving_directions[0]
            )

            second_direction = (
                surviving_directions[1]
            )

            first_last = (
                get_last_stop_name(
                    first_direction
                )
            )

            second_last = (
                get_last_stop_name(
                    second_direction
                )
            )

            a_label = destination_labels.get(
                "A",
                ""
            )

            b_label = destination_labels.get(
                "B",
                ""
            )

            first_is_a = (
                destination_matches_stop(
                    a_label,
                    first_last
                )
            )

            second_is_a = (
                destination_matches_stop(
                    a_label,
                    second_last
                )
            )

            first_is_b = (
                destination_matches_stop(
                    b_label,
                    first_last
                )
            )

            second_is_b = (
                destination_matches_stop(
                    b_label,
                    second_last
                )
            )

            if (
                second_is_a
                and first_is_b
            ):

                surviving_directions = [
                    second_direction,
                    first_direction
                ]

            elif (
                not first_is_a
                and second_is_a
            ):

                surviving_directions = [
                    second_direction,
                    first_direction
                ]

        surviving_directions = (
            surviving_directions[:2]
        )

        output = {
            "A": None,
            "B": None
        }

        for index, direction in enumerate(
            surviving_directions
        ):

            direction_code = direction[
                "code"
            ]

            route_stops = []

            for stop_id in direction[
                "stops"
            ]:

                stop = stops_by_id.get(
                    stop_id
                )

                if stop is None:
                    continue

                # IMPORTANT:
                # direction.stop_id and data.stops.stop_id
                # must be identical for map.js.
                route_stops.append({

                    "stop_id":
                        normalize(
                            stop.get(
                                "stop_id"
                            )
                        ),

                    "name":
                        normalize(
                            stop.get(
                                "stop_name"
                            )
                        )
                })

            if not route_stops:
                continue

            direction_trips = [
                trip
                for trip in route_trips
                if trip[
                    "direction"
                ] == direction_code
            ]

            representative_original = None

            if direction_trips:

                representative_original = (
                    choose_representative_trip(
                        direction_trips[0],
                        trips_by_id,
                        stop_times_by_trip
                    )
                )

            destination_labels = (
                get_route_destination_labels(
                    route
                )
            )

            key = (
                "A"
                if index == 0
                else "B"
            )

            # ----------------------------------------------------
            # The visible name follows the same route_long_name
            # convention as the existing site.
            # ----------------------------------------------------

            headsign = destination_labels.get(
                key,
                ""
            )

            if not headsign:

                if representative_original:

                    headsign = normalize(
                        representative_original.get(
                            "trip_headsign"
                        )
                    )

            if not headsign and route_stops:

                headsign = route_stops[
                    -1
                ][
                    "name"
                ]

            direction_record = {

                "headsign":
                    headsign,

                "destination":
                    headsign,

                "trip_id":
                    (
                        representative_original[
                            "trip_id"
                        ]
                        if representative_original
                        else ""
                    ),

                "direction_id":
                    (
                        representative_original[
                            "direction_id"
                        ]
                        if representative_original
                        else ""
                    ),

                "shape_id":
                    (
                        representative_original[
                            "shape_id"
                        ]
                        if representative_original
                        else ""
                    ),

                "service_id":
                    (
                        representative_original[
                            "service_id"
                        ]
                        if representative_original
                        else ""
                    ),

                "frequency":
                    len(direction_trips),

                "stop_count":
                    len(route_stops),

                "stops":
                    route_stops,

                "pattern":
                    [
                        stop[
                            "stop_id"
                        ]
                        for stop in route_stops
                    ],

                "_reference_direction_code":
                    direction_code
            }

            output[
                key
            ] = direction_record

        if (
            output["A"]
            or output["B"]
        ):

            directions_result[
                route_id
            ] = output

    return directions_result


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
                "_reference_direction_code"
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

                    values = item.get(
                        "times",
                        []
                    )

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

                    target.append({

                        "trip_id":
                            logical_trip[
                                "id"
                            ],

                        "start_time":
                            (
                                f"{first_value // 60:02d}:"
                                f"{first_value % 60:02d}:00"
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

                        "car":
                            item.get(
                                "car",
                                ""
                            )
                    })

            weekday_courses.sort(
                key=lambda course:
                    parse_time(
                        course[
                            "start_time"
                        ]
                    )
                    if parse_time(
                        course[
                            "start_time"
                        ]
                    ) is not None
                    else 10**12
            )

            weekend_courses.sort(
                key=lambda course:
                    parse_time(
                        course[
                            "start_time"
                        ]
                    )
                    if parse_time(
                        course[
                            "start_time"
                        ]
                    ) is not None
                    else 10**12
            )

            route_schedule[
                direction_key
            ] = {

                "weekday":
                    weekday_courses,

                "weekend":
                    weekend_courses
            }

        if route_schedule:

            schedules[
                route_id
            ] = route_schedule

    return schedules


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

        calendar_data = []

        calendar_path = (
            GTFS_DIR / "calendar.txt"
        )

        if calendar_path.exists():

            print(
                "Reading calendar.txt..."
            )

            calendar_data = read_csv(
                "calendar.txt"
            )

        else:

            print(
                "calendar.txt not present; "
                "using calendar_dates.txt only."
            )

        print(
            "Reading calendar_dates.txt..."
        )

        calendar_dates_data = read_csv(
            "calendar_dates.txt"
        )

        print(
            "Reading stop_times.txt..."
        )

        stop_times_data = read_csv(
            "stop_times.txt"
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

        service_weights = (
            get_active_service_weights(
                calendar_data,
                calendar_dates_data,
                today,
                horizon_days=16
            )
        )

        use_service_filter = bool(
            service_weights
        )

        if use_service_filter:

            print(
                "Using active services only."
            )

        else:

            print(
                "WARNING: No active services "
                "could be determined. "
                "Using all trips."
            )

        weekday_services, weekend_services = (
            get_service_day_sets(
                calendar_dates_data,
                today,
                horizon_days=16
            )
        )

        print(
            "Weekday service IDs: "
            f"{len(weekday_services)}"
        )

        print(
            "Weekend service IDs: "
            f"{len(weekend_services)}"
        )

        # --------------------------------------------------------
        # 3. Stops
        # --------------------------------------------------------

        stops_by_id = build_stop_index(
            stops_data
        )

        # --------------------------------------------------------
        # 4. Trips
        # --------------------------------------------------------

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

            if (
                use_service_filter
                and service_id
                not in service_weights
            ):

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
                    )
            }

        print(
            "Active trips: "
            f"{len(trips_by_id)}"
        )

        # --------------------------------------------------------
        # 5. Stop times
        # --------------------------------------------------------

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

            original_stop_id = normalize(
                row.get(
                    "stop_id"
                )
            )

            stop_id = normalize_gtfs_stop_id(
                original_stop_id
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
                    )
            })

        for trip_id in stop_times_by_trip:

            stop_times_by_trip[
                trip_id
            ].sort(
                key=lambda item:
                    item[
                        "sequence"
                    ]
            )

        print(
            "Trips with active stop times: "
            f"{len(stop_times_by_trip)}"
        )

        # --------------------------------------------------------
        # 6. Direction construction
        # --------------------------------------------------------

        print(
            ""
        )

        print(
            "=== Building directions using "
            "Dimitar5555 reference algorithm ==="
        )

        (
            reference_trips,
            directions,
            reference_stop_times
        ) = build_reference_direction_data(
            trips_by_id,
            stop_times_by_trip,
            service_weights
        )

        print(
            "Initial directions: "
            f"{len(directions)}"
        )

        print(
            "Initial logical trips: "
            f"{len(reference_trips)}"
        )

        # --------------------------------------------------------
        # 7. Partial direction merge
        # --------------------------------------------------------

        merge_partial_directions(
            routes_data,
            reference_trips,
            directions,
            reference_stop_times
        )

        print(
            "Directions after partial merge: "
            f"{len(directions)}"
        )

        # --------------------------------------------------------
        # 8. Logical trip merge
        # --------------------------------------------------------

        merge_logical_trips(
            routes_data,
            reference_trips,
            reference_stop_times
        )

        print(
            "Logical trips after merge: "
            f"{len(reference_trips)}"
        )

        # --------------------------------------------------------
        # 9. Directions output
        # --------------------------------------------------------

        directions_result = (
            build_output_directions(
                routes_data,
                directions,
                reference_trips,
                trips_by_id,
                stop_times_by_trip,
                stops_by_id
            )
        )

        # --------------------------------------------------------
        # 10. Schedules
        # --------------------------------------------------------

        schedules_result = build_schedules(
            directions_result,
            reference_trips,
            reference_stop_times
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

        shapes_result = load_selected_shapes(
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
                        "_reference_direction_code",
                        None
                    )

        # --------------------------------------------------------
        # 13. IMPORTANT:
        #
        # Use NORMALIZED stop IDs in data.stops too.
        #
        # This makes:
        #
        # directions[*].stops[*].stop_id
        #
        # and:
        #
        # stops[*].stop_id
        #
        # identical, so map.js can find the stop coordinates.
        # --------------------------------------------------------

        output_stops = []

        for stop in stops_data:

            original_stop_id = normalize(
                stop.get(
                    "stop_id"
                )
            )

            normalized_stop_id = (
                normalize_gtfs_stop_id(
                    original_stop_id
                )
            )

            normalized_stop = dict(
                stop
            )

            normalized_stop[
                "stop_id"
            ] = normalized_stop_id

            output_stops.append(
                normalized_stop
            )

        # --------------------------------------------------------
        # 14. Final output
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
                output_stops,

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
                schedules_result
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
        # Diagnostics
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

            schedule_info = (
                schedules_result.get(
                    route_id,
                    {}
                )
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


if __name__ == "__main__":
    main()
