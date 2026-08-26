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
# Basic helpers
# ============================================================

def normalize(value):
    return str(value).strip() if value is not None else ""


def normalize_gtfs_stop_id(value):
    """
    Match Dimitar5555's 04-schedules.js:

        st.stop_id.startsWith('M')
            ? st.stop_id
            : st.stop_id.replace(/\D/g, '').padStart(4, '0')

    This is important because direction identity is based on the
    normalized stop IDs.
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
    return datetime.now(timezone.utc).date()


def iter_dates(start, days):
    for offset in range(days):
        yield start + timedelta(days=offset)


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
        shutil.rmtree(GTFS_DIR)

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

        reader = csv.DictReader(file)

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
                "lat": lat,
                "lon": lon,
                "sequence": sequence
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
                "lat": point["lat"],
                "lon": point["lon"]
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

    # Optional calendar.txt support.
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

    # calendar_dates.txt
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
            < start_date + timedelta(
                days=horizon_days
            )
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
        + timedelta(days=horizon_days)
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

        # Same tie behavior as reference.
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
# Exact equivalent of Dimitar5555's direction construction
# ============================================================

def build_reference_direction_data(
    trips_by_id,
    stop_times_by_trip,
    service_weights
):
    """
    Reproduce the important direction-building part of
    Dimitar5555's 04-schedules.js.

    Reference logic:

        trip_stops = trip_stop_times.map(st => st.stop_id)

        find an existing direction for the same route when
        the complete ordered stop sequence is identical.

        otherwise create a new direction.

    Direction identity therefore comes from:

        route_id + exact ordered stop sequence

    NOT from:

        trip_headsign
        direction_id
        longest pattern
        service frequency
    """

    trips = []
    directions = []
    stop_times = []

    route_direction_map = defaultdict(set)

    # ------------------------------------------------------------
    # Same as:
    #
    # for(const trip of gtfs_trips)
    # ------------------------------------------------------------

    for trip_id, trip in trips_by_id.items():

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

        route_sumc_id = trip[
            "route_id"
        ]

        if not trip_stops or not route_sumc_id:
            continue

        is_weekend_trip = (
            trip["service_id"]
            in service_weights
        )

        # --------------------------------------------------------
        # EXACT direction matching from reference.
        #
        # JS:
        #
        # d.stops.length === trip_stops.length &&
        # d.stops.every((s,index) =>
        #     trip_stops.indexOf(s) === index
        # ) &&
        # route_direction_map...
        #
        # Since the original stop arrays are ordered, Python tuple
        # equality is the exact equivalent.
        # --------------------------------------------------------

        corresponding_direction = None

        for direction in directions:

            if direction[
                "code"
            ] not in route_direction_map[
                route_sumc_id
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

        # --------------------------------------------------------
        # Create new direction exactly when no exact direction
        # exists.
        # --------------------------------------------------------

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
                route_sumc_id
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
        # Reference groups trips by:
        #
        # cgm_id
        # direction
        # is_weekend
        #
        # This is intentionally retained.
        # --------------------------------------------------------

        corresponding_trip = None

        for existing_trip in trips:

            if (
                existing_trip["cgm_id"]
                != route_sumc_id
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
                    route_sumc_id,

                "direction":
                    direction_code,

                "is_weekend":
                    is_weekend_trip,

                "is_deleted":
                    False
            }

            trips.append(
                corresponding_trip
            )

        # --------------------------------------------------------
        # The original project extracts car information.
        # Keep it where possible, although the current site's JSON
        # does not depend on it.
        # --------------------------------------------------------

        original_trip_id = trip_id

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
        # Original:
        #
        # departure_time -> minutes from midnight
        # --------------------------------------------------------

        times = []

        for item in trip_stop_times:

            raw_time = (
                item.get(
                    "departure_time"
                )
                or ""
            )

            parsed = parse_time(
                raw_time
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
                corresponding_trip["id"],

            "times":
                times,

            "car":
                car
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
    """
    Reproduce lines 77-120 of Dimitar5555's 04-schedules.js.

    Important:

    The reference implementation DOES NOT simply select the two
    longest patterns.

    It first obtains all directions belonging to the route, sorts
    them by descending stop count, and then looks for a parent whose
    stop string contains the child's stop string.

    When a child is merged:

        - child direction is marked deleted
        - its stop times are padded with null values
        - its trips are moved to the parent direction

    This is the crucial difference from the previous generator.
    """

    for route in routes_data:

        route_id = normalize(
            route.get("route_id")
        )

        route_trips = [
            trip
            for trip in trips
            if trip["cgm_id"]
            == route_id
            and not trip.get(
                "is_deleted",
                False
            )
        ]

        direction_ids = {
            trip["direction"]
            for trip in route_trips
        }

        route_dirs = [
            direction
            for direction in directions
            if direction["code"]
            in direction_ids
            and not direction.get(
                "is_deleted",
                False
            )
        ]

        # Same ordering:
        #
        # .sort((a,b) => b.stops.length - a.stops.length)
        #
        route_dirs.sort(
            key=lambda direction:
                len(direction["stops"]),
            reverse=True
        )

        # --------------------------------------------------------
        # Partial direction merge
        # --------------------------------------------------------

        for index1, child in enumerate(
            route_dirs
        ):

            if child.get(
                "is_deleted",
                False
            ):

                continue

            child_stops = child[
                "stops"
            ]

            if not child_stops:
                continue

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

                candidate_stops = candidate[
                    "stops"
                ]

                if not candidate_stops:
                    continue

                # The JS implementation uses:
                #
                # d.stops.join(',').includes(
                #     child.stops.join(',')
                # )
                #
                parent_string = ",".join(
                    candidate_stops
                )

                child_string = ",".join(
                    child_stops
                )

                if child_string not in parent_string:
                    continue

                parent = candidate
                break

            if parent is None:
                continue

            # ----------------------------------------------------
            # Exactly like:
            #
            # parent.stops.indexOf(child.stops[0])
            # ----------------------------------------------------

            try:

                needed_empty_begin_slots = (
                    parent["stops"].index(
                        child_stops[0]
                    )
                )

            except ValueError:

                continue

            needed_empty_end_slots = (
                len(parent["stops"])
                - needed_empty_begin_slots
                - len(child_stops)
            )

            child[
                "is_deleted"
            ] = True

            # ----------------------------------------------------
            # Move all child trips to parent and pad their times.
            # ----------------------------------------------------

            child_code = child[
                "code"
            ]

            for trip in trips:

                if trip[
                    "direction"
                ] != child_code:

                    continue

                trip_stop_times = [
                    st
                    for st in stop_times
                    if st["trip"]
                    == trip["id"]
                ]

                for st in trip_stop_times:

                    st["times"] = (
                        [None]
                        * needed_empty_begin_slots
                        + st["times"]
                        + [None]
                        * needed_empty_end_slots
                    )

                trip[
                    "direction"
                ] = parent[
                    "code"
                ]

        # --------------------------------------------------------
        # Delete directions exactly like reference.
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

            direction_code = (
                direction["code"]
            )

            has_orphan_trips = any(
                trip["direction"]
                == direction_code
                for trip in trips
            )

            if has_orphan_trips:

                print(
                    "WARNING: Direction "
                    f"{direction_code} is marked "
                    "as deleted but still has trips!"
                )

                continue

            directions.pop(
                index
            )


# ============================================================
# Merge trips after direction merge
# ============================================================

def merge_duplicate_trips(
    routes_data,
    trips,
    stop_times
):
    """
    Reproduce lines 121-151 of 04-schedules.js.

    Trips having the same:

        direction
        is_weekend

    are merged into one logical trip.
    """

    for route in routes_data:

        route_id = normalize(
            route.get("route_id")
        )

        route_trips = [
            trip
            for trip in trips
            if trip["cgm_id"]
            == route_id
            and not trip.get(
                "is_deleted",
                False
            )
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
                    candidate["direction"]
                    != trip["direction"]
                ):

                    continue

                if (
                    candidate["is_weekend"]
                    != trip["is_weekend"]
                ):

                    continue

                same = candidate
                break

            if same is None:
                continue

            trip_stop_times = [
                st
                for st in stop_times
                if st["trip"]
                == trip["id"]
            ]

            same_stop_times = [
                st
                for st in stop_times
                if st["trip"]
                == same["id"]
            ]

            for st in trip_stop_times:

                st["trip"] = same["id"]

                same_stop_times.append(
                    st
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
                st["trip"]
                == trip_id
                for st in stop_times
            )

            if has_orphan_stop_times:

                print(
                    "WARNING: Trip "
                    f"{trip_id} is marked "
                    "as deleted but still has "
                    "stop times!"
                )

                continue

            trips.pop(
                index
            )


# ============================================================
# Build final directions for transport.json
# ============================================================

def build_output_directions(
    routes_data,
    stops_by_id,
    trips,
    directions,
    trips_by_id
):
    """
    Convert the reference direction model into the existing
    transport.json contract.

    A/B are assigned only AFTER all direction merging has happened.

    This is important: we no longer select two directions before
    partial-trip merging.

    Destination/headsign is derived from the LAST STOP of the
    resulting direction, not from trip_headsign.
    """

    directions_result = {}

    directions_by_code = {
        direction["code"]:
            direction
        for direction in directions
    }

    # Route ordering follows routes.txt.
    for route in routes_data:

        route_id = normalize(
            route.get("route_id")
        )

        if not route_id:
            continue

        route_trips = [
            trip
            for trip in trips
            if trip["cgm_id"]
            == route_id
            and not trip.get(
                "is_deleted",
                False
            )
        ]

        if not route_trips:
            continue

        route_direction_codes = []

        for trip in route_trips:

            code = trip[
                "direction"
            ]

            if code not in route_direction_codes:

                route_direction_codes.append(
                    code
                )

        route_directions = []

        for code in route_direction_codes:

            direction = directions_by_code.get(
                code
            )

            if direction is None:
                continue

            route_directions.append(
                direction
            )

        if not route_directions:
            continue

        # --------------------------------------------------------
        # Keep deterministic order.
        #
        # The reference direction list is based on the order in
        # which directions are first encountered in GTFS trips.
        #
        # We preserve that order here.
        # --------------------------------------------------------

        output = {
            "A": None,
            "B": None
        }

        for index, direction in enumerate(
            route_directions[:2]
        ):

            direction_code = direction[
                "code"
            ]

            direction_stops = []

            for stop_id in direction[
                "stops"
            ]:

                stop = stops_by_id.get(
                    stop_id
                )

                if stop is None:
                    continue

                direction_stops.append({
                    "stop_id":
                        stop_id,

                    "name":
                        normalize(
                            stop.get(
                                "stop_name"
                            )
                        )
                })

            if not direction_stops:
                continue

            # ----------------------------------------------------
            # Find a representative trip for metadata only.
            #
            # IMPORTANT:
            # the trip_headsign is NOT used as the direction
            # identity or destination.
            # ----------------------------------------------------

            representative_trip = None

            direction_trips = [
                trip
                for trip in route_trips
                if trip["direction"]
                == direction_code
            ]

            if direction_trips:

                # Prefer a normal daytime trip if possible.
                representative_trip = min(
                    direction_trips,
                    key=lambda trip:
                        min(
                            (
                                parse_time(
                                    item.get(
                                        "departure_time"
                                    )
                                    or item.get(
                                        "arrival_time"
                                    )
                                )
                                for item in
                                trips_by_id[
                                    trip[
                                        "representative_trip_id"
                                    ]
                                ]["stop_times"]
                            ),
                            default=10**12
                        )
                    if trip.get(
                        "representative_trip_id"
                    )
                    else 10**12
                )

            representative_original = None

            if representative_trip:

                representative_original = (
                    trips_by_id.get(
                        representative_trip.get(
                            "representative_trip_id"
                        )
                    )
                )

            # ----------------------------------------------------
            # Destination = last stop.
            # ----------------------------------------------------

            destination = direction_stops[
                -1
            ]["name"]

            direction_record = {
                "headsign":
                    destination,

                "destination":
                    destination,

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
                    len(direction_stops),

                "stops":
                    direction_stops,

                "pattern":
                    [
                        stop["stop_id"]
                        for stop in direction_stops
                    ]
            }

            output[
                "A"
                if index == 0
                else "B"
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
# Build schedules from merged reference trips
# ============================================================

def build_schedule_data(
    directions_result,
    trips,
    stop_times,
    weekday_services,
    weekend_services,
    routes_data
):
    """
    Build the existing site's schedules from the merged reference
    direction/trip model.

    Unlike the previous generator, this DOES NOT require the trip's
    original stop pattern to exactly equal the final direction pattern.

    This is necessary because Dimitar5555's algorithm moves partial
    trips into their parent direction and pads their times with nulls.
    """

    schedules = {}

    route_by_id = {
        normalize(route.get("route_id")):
            route
        for route in routes_data
    }

    # Map A/B output directions back to their stop pattern.
    for route_id, route_directions in (
        directions_result.items()
    ):

        route_schedule = {}

        route = route_by_id.get(
            route_id
        )

        if route is None:
            continue

        # Build final pattern -> direction key.
        direction_code_by_pattern = {}

        for direction_key in (
            "A",
            "B"
        ):

            direction = route_directions.get(
                direction_key
            )

            if not direction:
                continue

            pattern = tuple(
                direction["pattern"]
            )

            direction_code_by_pattern[
                pattern
            ] = direction_key

        # --------------------------------------------------------
        # The output directions were built from the reference
        # direction codes. Find the corresponding code by comparing
        # patterns.
        # --------------------------------------------------------

        for direction_key in (
            "A",
            "B"
        ):

            direction = route_directions.get(
                direction_key
            )

            if not direction:
                continue

            selected_pattern = tuple(
                direction["pattern"]
            )

            # Find reference direction with same pattern.
            reference_code = None

            for trip in trips:

                if trip["cgm_id"] != route_id:
                    continue

                reference_trip_id = trip.get(
                    "representative_trip_id"
                )

                if reference_trip_id is None:
                    continue

                reference_trip = next(
                    (
                        t
                        for t in trips
                        if t["id"]
                        == reference_trip_id
                    ),
                    None
                )

                if reference_trip is None:
                    continue

                reference_code = trip[
                    "direction"
                ]

                break

            # Better and deterministic route-level matching:
            # find a direction by exact pattern from its representative
            # trip's original stop list.
            matching_codes = []

            for trip in trips:

                if trip["cgm_id"] != route_id:
                    continue

                code = trip[
                    "direction"
                ]

                matching_codes.append(
                    code
                )

            if not matching_codes:
                continue

            # ----------------------------------------------------
            # We can identify the final direction by looking at
            # the route direction's original stop pattern.
            # ----------------------------------------------------

            selected_code = None

            for trip in trips:

                if trip["cgm_id"] != route_id:
                    continue

                code = trip[
                    "direction"
                ]

                # A trip belonging to the direction may have a
                # shorter original pattern after partial merging,
                # so compare the final direction through the output
                # pattern stored on the direction record.
                if trip.get(
                    "final_pattern"
                ) == list(
                    selected_pattern
                ):

                    selected_code = code
                    break

            # ----------------------------------------------------
            # Fallback: schedules are constructed below using
            # explicit final_direction_code attached during main().
            # ----------------------------------------------------

            if selected_code is None:

                selected_code = direction.get(
                    "_reference_direction_code"
                )

            if selected_code is None:
                continue

            day_groups = {
                "weekday":
                    weekday_services,

                "weekend":
                    weekend_services
            }

            direction_schedule = {}

            for day_type, service_ids in (
                day_groups.items()
            ):

                courses = []

                for trip in trips:

                    if trip[
                        "cgm_id"
                    ] != route_id:

                        continue

                    if trip[
                        "direction"
                    ] != selected_code:

                        continue

                    is_weekend = trip[
                        "is_weekend"
                    ]

                    if day_type == "weekday":
                        if is_weekend:
                            continue
                    else:
                        if not is_weekend:
                            continue

                    trip_stop_times = [
                        st
                        for st in stop_times
                        if st["trip"]
                        == trip["id"]
                    ]

                    for st in trip_stop_times:

                        times = st[
                            "times"
                        ]

                        if not times:
                            continue

                        # First non-null time.
                        start_time = next(
                            (
                                value
                                for value in times
                                if value is not None
                            ),
                            None
                        )

                        if start_time is None:
                            continue

                        courses.append({
                            "trip_id":
                                trip["id"],

                            "start_time":
                                (
                                    f"{start_time // 60:02d}:"
                                    f"{start_time % 60:02d}:00"
                                ),

                            "times":
                                [
                                    (
                                        f"{value // 60:02d}:"
                                        f"{value % 60:02d}:00"
                                    )
                                    if value is not None
                                    else None
                                    for value in times
                                ],

                            "car":
                                st.get(
                                    "car",
                                    ""
                                )
                        })

                courses.sort(
                    key=lambda course:
                        (
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
                )

                direction_schedule[
                    day_type
                ] = courses

            route_schedule[
                direction_key
            ] = direction_schedule

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

    # ------------------------------------------------------------
    # 1. Download GTFS
    # ------------------------------------------------------------

    download_gtfs()

    # ------------------------------------------------------------
    # 2. Read GTFS
    # ------------------------------------------------------------

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

    # ------------------------------------------------------------
    # 3. Active services
    # ------------------------------------------------------------

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

    # ------------------------------------------------------------
    # 4. Stops
    # ------------------------------------------------------------

    stops_by_id = {}

    for row in stops_data:

        original_stop_id = normalize(
            row.get("stop_id")
        )

        stop_id = normalize_gtfs_stop_id(
            original_stop_id
        )

        if not stop_id:
            continue

        normalized_row = dict(
            row
        )

        normalized_row[
            "_original_stop_id"
        ] = original_stop_id

        normalized_row[
            "stop_id"
        ] = stop_id

        stops_by_id[
            stop_id
        ] = normalized_row

    # ------------------------------------------------------------
    # 5. Trips
    # ------------------------------------------------------------

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

    # ------------------------------------------------------------
    # 6. Stop times
    # ------------------------------------------------------------

    stop_times_by_trip = defaultdict(
        list
    )

    for row in stop_times_data:

        trip_id = normalize(
            row.get("trip_id")
        )

        if trip_id not in trips_by_id:
            continue

        original_stop_id = normalize(
            row.get("stop_id")
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
                item["sequence"]
        )

    print(
        "Trips with active stop times: "
        f"{len(stop_times_by_trip)}"
    )

    # ------------------------------------------------------------
    # 7. Build directions EXACTLY from trip stop sequences
    # ------------------------------------------------------------

    print(
        ""
    )

    print(
        "=== Building directions using "
        "Dimitar5555 reference algorithm ==="
    )

    reference_trips, directions, reference_stop_times = (
        build_reference_direction_data(
            trips_by_id,
            stop_times_by_trip,
            service_weights
        )
    )

    print(
        "Initial directions: "
        f"{len(directions)}"
    )

    print(
        "Initial logical trips: "
        f"{len(reference_trips)}"
    )

    # ------------------------------------------------------------
    # Attach original representative trip information to each
    # logical trip.
    #
    # This is metadata only. Direction identity is already decided
    # from stop sequences.
    # ------------------------------------------------------------

    direction_to_original_trips = defaultdict(
        list
    )

    for trip_id, trip in trips_by_id.items():

        stop_items = stop_times_by_trip.get(
            trip_id,
            []
        )

        pattern = [
            item["stop_id"]
            for item in stop_items
        ]

        for logical_direction in directions:

            if (
                logical_direction[
                    "stops"
                ]
                == pattern
            ):

                for logical_trip in reference_trips:

                    if (
                        logical_trip[
                            "cgm_id"
                        ]
                        == trip["route_id"]
                        and logical_trip[
                            "direction"
                        ]
                        == logical_direction[
                            "code"
                        ]
                    ):

                        direction_to_original_trips[
                            logical_trip["id"]
                        ].append(
                            trip
                        )

    for logical_trip in reference_trips:

        candidates = (
            direction_to_original_trips.get(
                logical_trip["id"],
                []
            )
        )

        if candidates:

            # Prefer a trip with a departure closest to noon.
            representative = min(
                candidates,
                key=lambda trip:
                    min(
                        (
                            parse_time(
                                item.get(
                                    "departure_time"
                                )
                                or item.get(
                                    "arrival_time"
                                )
                            )
                            for item in
                            stop_times_by_trip.get(
                                trip[
                                    "trip_id"
                                ],
                                []
                            )
                            if (
                                parse_time(
                                    item.get(
                                        "departure_time"
                                    )
                                    or item.get(
                                        "arrival_time"
                                    )
                                )
                                is not None
                            )
                        ),
                        default=10**12
                    )
            )

            logical_trip[
                "representative_trip_id"
            ] = (
                len(
                    direction_to_original_trips[
                        logical_trip["id"]
                    ]
                )
                and representative[
                    "trip_id"
                ]
            )

    # ------------------------------------------------------------
    # 8. Merge partial directions EXACTLY like reference.
    # ------------------------------------------------------------

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

    # ------------------------------------------------------------
    # 9. Merge logical trips EXACTLY like reference.
    # ------------------------------------------------------------

    merge_duplicate_trips(
        routes_data,
        reference_trips,
        reference_stop_times
    )

    print(
        "Trips after merge: "
        f"{len(reference_trips)}"
    )

    # ------------------------------------------------------------
    # 10. Determine final output directions.
    #
    # We need the reference direction code attached to A/B so
    # schedules can use the same merged direction.
    # ------------------------------------------------------------

    directions_by_code = {
        direction["code"]:
            direction
        for direction in directions
    }

    directions_result = {}

    for route in routes_data:

        route_id = normalize(
            route.get("route_id")
        )

        route_trips = [
            trip
            for trip in reference_trips
            if trip["cgm_id"]
            == route_id
            and not trip.get(
                "is_deleted",
                False
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

        # IMPORTANT:
        # Do NOT sort by length and do NOT take longest two.
        #
        # Preserve the direction order resulting from the reference
        # generator.
        final_directions = []

        for code in direction_codes:

            direction = directions_by_code.get(
                code
            )

            if direction is None:
                continue

            final_directions.append(
                direction
            )

        final_directions = final_directions[:2]

        output = {
            "A": None,
            "B": None
        }

        for index, direction in enumerate(
            final_directions
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

                route_stops.append({
                    "stop_id":
                        stop_id,

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
                if trip["direction"]
                == direction_code
            ]

            # Find representative original trip.
            original_candidates = []

            for logical_trip in direction_trips:

                logical_id = logical_trip[
                    "id"
                ]

                for original_trip_id, original_trip in (
                    trips_by_id.items()
                ):

                    original_items = (
                        stop_times_by_trip.get(
                            original_trip_id,
                            []
                        )
                    )

                    original_pattern = [
                        item["stop_id"]
                        for item in original_items
                    ]

                    if (
                        original_trip[
                            "route_id"
                        ]
                        != route_id
                    ):
                        continue

                    if (
                        original_pattern
                        == direction["stops"]
                    ):

                        original_candidates.append(
                            original_trip
                        )

            representative_original = None

            if original_candidates:

                def representative_score(
                    original_trip
                ):

                    starts = [
                        parse_time(
                            item.get(
                                "departure_time"
                            )
                            or item.get(
                                "arrival_time"
                            )
                        )
                        for item in
                        stop_times_by_trip.get(
                            original_trip[
                                "trip_id"
                            ],
                            []
                        )
                    ]

                    starts = [
                        value
                        for value in starts
                        if value is not None
                    ]

                    if not starts:
                        return 10**12

                    return min(
                        abs(
                            value
                            - 12 * 3600
                        )
                        for value in starts
                    )

                representative_original = min(
                    original_candidates,
                    key=representative_score
                )

            # ----------------------------------------------------
            # CRITICAL:
            #
            # Destination is the LAST STOP.
            #
            # Not trip_headsign.
            # ----------------------------------------------------

            destination = (
                route_stops[-1]["name"]
                if route_stops
                else ""
            )

            direction_record = {

                "headsign":
                    destination,

                "destination":
                    destination,

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
                        stop["stop_id"]
                        for stop in route_stops
                    ],

                "_reference_direction_code":
                    direction_code
            }

            output[
                "A"
                if index == 0
                else "B"
            ] = direction_record

        if (
            output["A"]
            or output["B"]
        ):

            directions_result[
                route_id
            ] = output

    # ------------------------------------------------------------
    # 11. Build schedules.
    # ------------------------------------------------------------

    schedules_result = {}

    weekday_service_set = set(
        weekday_services
    )

    weekend_service_set = set(
        weekend_services
    )

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

            direction_schedule = {}

            for day_type, service_ids in (
                (
                    "weekday",
                    weekday_service_set
                ),
                (
                    "weekend",
                    weekend_service_set
                )
            ):

                courses = []

                for logical_trip in reference_trips:

                    if logical_trip[
                        "cgm_id"
                    ] != route_id:
                        continue

                    if logical_trip[
                        "direction"
                    ] != direction_code:
                        continue

                    if logical_trip.get(
                        "is_deleted",
                        False
                    ):

                        continue

                    if (
                        logical_trip[
                            "is_weekend"
                        ]
                    ):

                        if day_type == "weekday":
                            continue

                    else:

                        if day_type == "weekend":
                            continue

                    logical_stop_times = [
                        st
                        for st in reference_stop_times
                        if st["trip"]
                        == logical_trip["id"]
                    ]

                    for st in logical_stop_times:

                        times = st.get(
                            "times",
                            []
                        )

                        if not times:
                            continue

                        non_null = [
                            value
                            for value in times
                            if value is not None
                        ]

                        if not non_null:
                            continue

                        first_time = non_null[0]

                        courses.append({
                            "trip_id":
                                logical_trip[
                                    "id"
                                ],

                            "start_time":
                                (
                                    f"{first_time // 60:02d}:"
                                    f"{first_time % 60:02d}:00"
                                ),

                            "times":
                                [
                                    (
                                        f"{value // 60:02d}:"
                                        f"{value % 60:02d}:00"
                                    )
                                    if value is not None
                                    else None
                                    for value in times
                                ],

                            "car":
                                st.get(
                                    "car",
                                    ""
                                )
                        })

                courses.sort(
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

                direction_schedule[
                    day_type
                ] = courses

            route_schedule[
                direction_key
            ] = direction_schedule

        if route_schedule:

            schedules_result[
                route_id
            ] = route_schedule

    # ------------------------------------------------------------
    # 12. Remove internal helper fields before JSON output.
    # ------------------------------------------------------------

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

            direction.pop(
                "_reference_direction_code",
                None
            )

    # ------------------------------------------------------------
    # 13. Shapes
    # ------------------------------------------------------------

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

    # ------------------------------------------------------------
    # 14. Output
    # ------------------------------------------------------------

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

    print(
        ""
    )

    print(
        f"Written: {OUTPUT_FILE}"
    )

    print(
        f"Routes: "
        f"{len(result['routes'])}"
    )

    print(
        f"Stops: "
        f"{len(result['stops'])}"
    )

    print(
        f"Trips: "
        f"{len(result['trips'])}"
    )

    print(
        f"Directions: "
        f"{len(result['directions'])}"
    )

    print(
        f"Schedules: "
        f"{len(result['schedules'])}"
    )

    # ------------------------------------------------------------
    # 15. Diagnostic output for route 10.
    # ------------------------------------------------------------

    print(
        ""
    )

    print(
        "=== TEST ROUTE 10 ==="
    )

    found_route_10 = False

    for route in routes_data:

        route_id = normalize(
            route.get("route_id")
        )

        short_name = normalize(
            route.get(
                "route_short_name"
            )
        )

        if short_name not in {
            "10",
            "ТМ10",
            "Т10"
        }:

            continue

        found_route_10 = True

        print(
            f"route_id: {route_id}"
        )

        info = directions_result.get(
            route_id
        )

        if not info:

            print(
                "No directions generated "
                "for route 10."
            )

            continue

        for direction_key in (
            "A",
            "B"
        ):

            item = info.get(
                direction_key
            )

            if not item:
                continue

            names = [
                stop["name"]
                for stop in item[
                    "stops"
                ]
            ]

            print(
                f"{direction_key}: "
                f"{item['headsign']} | "
                f"trip={item['trip_id']} | "
                f"shape={item['shape_id']} | "
                f"stops={len(names)}"
            )

            if names:

                print(
                    f"    first: "
                    f"{names[0]}"
                )

                print(
                    f"    last: "
                    f"{names[-1]}"
                )

    if not found_route_10:

        print(
            "Route 10 was not found in routes.txt."
        )

    # ------------------------------------------------------------
    # 16. Remove temporary GTFS
    # ------------------------------------------------------------

    if GTFS_DIR.exists():

        shutil.rmtree(
            GTFS_DIR
        )

    print(
        "Temporary GTFS files removed."
    )


if __name__ == "__main__":
    main()
