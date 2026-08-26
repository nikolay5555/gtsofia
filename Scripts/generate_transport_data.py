#!/usr/bin/env python3

import csv
import io
import json
import math
import shutil
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


# Official static GTFS feed published by Sofia Urban Mobility Center.
GTFS_URL = "https://gtfs.sofiatraffic.bg/api/v1/static"

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
GTFS_DIR = ROOT / ".gtfs"

OUTPUT_FILE = DATA_DIR / "transport.json"


def normalize(value):
    return str(value).strip() if value is not None else ""


def download_gtfs():
    print(f"Downloading official GTFS: {GTFS_URL}")

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
        f"Downloaded GTFS archive: "
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
                + ", ".join(sorted(missing))
            )

        archive.extractall(GTFS_DIR)

    print(
        f"GTFS extracted to: {GTFS_DIR}"
    )


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


def load_selected_shapes(shape_ids):
    """Load only GTFS shapes used by the selected main directions."""

    shapes_path = GTFS_DIR / "shapes.txt"

    if not shapes_path.exists():
        print("WARNING: shapes.txt is not present in the GTFS feed.")
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
            shape_id = normalize(row.get("shape_id"))

            if shape_id not in selected_ids:
                continue

            try:
                lat = float(row.get("shape_pt_lat"))
                lon = float(row.get("shape_pt_lon"))
                sequence = int(row.get("shape_pt_sequence", 0))
            except (TypeError, ValueError):
                continue

            shapes[shape_id].append({
                "lat": lat,
                "lon": lon,
                "sequence": sequence
            })

    result = {}

    for shape_id, points in shapes.items():
        points.sort(key=lambda point: point["sequence"])

        result[shape_id] = [
            {
                "lat": point["lat"],
                "lon": point["lon"]
            }
            for point in points
        ]

    print(f"Selected GTFS shapes: {len(result)}")
    print(
        "Shape points retained: "
        f"{sum(len(points) for points in result.values())}"
    )

    return result


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
    # Match Dimitar5555 exactly: the reference project derives the
    # service date from JavaScript's toISOString(), i.e. UTC.
    return datetime.now(timezone.utc).date()


def iter_dates(start, days):
    for offset in range(days):
        yield start + timedelta(days=offset)


def get_active_service_weights(
    calendar,
    calendar_dates,
    start_date,
    horizon_days=15
):
    """
    Determine service_id values active during the current date +
    following 15 dates (16 dates total).

    The current Sofia GTFS feed observed in production does not contain
    calendar.txt, so calendar_dates.txt is the authoritative source
    for service dates.

    If calendar.txt is present in a future feed, its regular weekly
    service is also considered and calendar_dates.txt exceptions override it.
    """

    active_by_date = defaultdict(set)

    # ------------------------------------------------------------
    # Optional calendar.txt support.
    # ------------------------------------------------------------

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

            if weekdays[current.weekday()]:
                active_by_date[current].add(
                    service_id
                )

    # ------------------------------------------------------------
    # calendar_dates.txt
    # ------------------------------------------------------------

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
        except (TypeError, ValueError):
            exception_type = 0

        if exception_type == 1:
            active_by_date[current].add(
                service_id
            )

        elif exception_type == 2:
            active_by_date[current].discard(
                service_id
            )

    weights = defaultdict(int)

    for service_ids in active_by_date.values():
        for service_id in service_ids:
            weights[service_id] += 1

    print(
        f"Active service IDs in next "
        f"{horizon_days} days: {len(weights)}"
    )

    if active_by_date:
        print(
            f"Service dates considered: "
            f"{len(active_by_date)}"
        )

    return dict(weights)


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


def trip_start_seconds(
    trip_id,
    stop_times_by_trip
):
    values = []

    for item in stop_times_by_trip.get(
        trip_id,
        []
    ):

        seconds = parse_time(
            item.get("departure_time")
            or item.get("arrival_time")
        )

        if seconds is not None:
            values.append(seconds)

    return (
        min(values)
        if values
        else 10**12
    )


def build_stop_pattern(
    stop_times_by_trip,
    trip_id
):
    return tuple(
        item["stop_id"]
        for item in stop_times_by_trip.get(
            trip_id,
            []
        )
    )


def choose_daytime_trip(
    trip_ids,
    stop_times_by_trip
):
    """
    Pick a normal daytime representative rather than an extremely
    early/late exceptional course.

    12:00 is used as the center of the normal daytime service.
    """

    return min(
        trip_ids,
        key=lambda trip_id: (
            abs(
                trip_start_seconds(
                    trip_id,
                    stop_times_by_trip
                )
                - 12 * 3600
            ),
            -len(
                stop_times_by_trip[
                    trip_id
                ]
            )
        )
    )


def is_subsequence(shorter, longer):
    """
    True when every stop in `shorter` occurs in order in `longer`.

    This mirrors the direction-merging idea used by Dimitar5555:
    a shorter trip pattern that occurs inside a longer pattern is
    treated as a partial trip of the longer direction.
    """

    if not shorter:
        return True

    if len(shorter) > len(longer):
        return False

    index = 0

    for value in longer:

        if value == shorter[index]:
            index += 1

            if index == len(shorter):
                return True

    return False


def pattern_contains(parent, child):
    """
    Match Dimitar5555's partial-direction merge criterion.

    The reference implementation sorts directions by descending
    stop count and checks whether the child stop sequence occurs
    inside the parent's stop sequence.
    """

    if not child:
        return True

    if len(child) > len(parent):
        return False

    return is_subsequence(
        child,
        parent
    )


def select_main_patterns(
    patterns,
    pattern_trip_ids,
    pattern_weight
):
    """
    Determine the main route directions using the same basic mechanism
    as Dimitar5555's 04-schedules.js.

    Important difference from the old implementation:
    we do NOT choose directions simply by the highest service weight.

    Instead:

    1. Every unique exact stop pattern is initially a direction.
    2. Patterns are ordered from longest to shortest.
    3. A shorter pattern which occurs inside a longer pattern is
       considered a partial direction and is merged into the longer
       direction.
    4. Only the remaining full directions are candidates for A/B.

    The actual timetable generation remains unchanged elsewhere in
    this generator.
    """

    candidates = []

    for pattern, trip_ids in patterns.items():

        if not trip_ids:
            continue

        candidates.append({
            "pattern": pattern,
            "trip_ids": list(trip_ids),
            "weight": pattern_weight.get(
                pattern,
                len(trip_ids)
            ),
            "stop_count": len(pattern),
            "is_deleted": False
        })

    # This is the same ordering used by Dimitar5555:
    # longest direction first.
    candidates.sort(
        key=lambda item: item["stop_count"],
        reverse=True
    )

    # ------------------------------------------------------------
    # Merge partial directions into their parent directions.
    #
    # This corresponds to:
    #
    # route_dirs.sort((a, b) => b.stops.length - a.stops.length)
    #
    # followed by checking whether:
    #
    # d.stops.join(',').includes(child.stops.join(','))
    #
    # in Dimitar5555's generator.
    # ------------------------------------------------------------

    for child_index, child in enumerate(candidates):

        if child["is_deleted"]:
            continue

        child_pattern = child["pattern"]

        for parent_index, parent in enumerate(candidates):

            if parent_index == child_index:
                continue

            if parent["is_deleted"]:
                continue

            if len(parent["pattern"]) <= len(child_pattern):
                continue

            if not pattern_contains(
                parent["pattern"],
                child_pattern
            ):
                continue

            child["is_deleted"] = True

            # The parent remains the actual direction.
            # We deliberately do not change its stop pattern.
            break

    remaining = [
        candidate
        for candidate in candidates
        if not candidate["is_deleted"]
    ]

    # In the reference generator, after partial directions have been
    # merged, the remaining route directions are retained. Our current
    # site's JSON contract supports two directions (A/B), so retain the
    # two strongest remaining full directions.
    #
    # Length is primary, while service weight is only a deterministic
    # tie-breaker.
    remaining.sort(
        key=lambda item: (
            item["stop_count"],
            item["weight"]
        ),
        reverse=True
    )

    return remaining[:2]


def route_type_from_gtfs(route_type):
    value = normalize(route_type)

    # GTFS:
    # 0 tram
    # 1 metro
    # 3 bus
    # 11 trolleybus
    if value == "0":
        return "tram"

    if value == "1":
        return "metro"

    if value == "3":
        return "bus"

    if value == "11":
        return "trolleybus"

    return "other"


def normalize_route_record(row):
    """
    Keep the original GTFS route fields so the existing app can
    continue using route_short_name, route_type, route_color, etc.
    """

    return dict(row)


def normalize_stop_record(row):
    """
    Keep the original GTFS stop fields.
    The existing app only needs stop_id, stop_name and coordinates,
    but retaining the GTFS fields makes the generated file useful
    for future features.
    """

    return dict(row)


def normalize_trip_record(row):
    return dict(row)


def get_service_day_sets(
    calendar_dates,
    start_date,
    horizon_days=15
):
    """
    Mirror Dimitar5555's service-day classification exactly.

    Each service_id is assigned to ONE day group based on which type
    of date (weekday/weekend/holiday) it appears on most often during
    the next 15 days. Holidays listed below are treated as weekend days,
    just like the reference project.
    """

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

    horizon_end = start_date + timedelta(
        days=horizon_days
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
            ]["weekend_count"] += 1

        else:
            service_stats[
                service_id
            ]["weekday_count"] += 1

    weekday = set()
    weekend = set()

    for service_id, counts in (
        service_stats.items()
    ):

        # Exact tie behavior of Dimitar5555:
        # ties go to weekend.
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


def build_schedule_data(
    directions_result,
    trips_by_id,
    stop_times_by_trip,
    weekday_services,
    weekend_services,
):
    """
    Build compact timetable/course data for the two selected GTFS
    directions.

    This function is intentionally unchanged in behavior so that the
    currently correct timetable data is not affected by the direction
    detection change.
    """

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

            selected_pattern = tuple(
                stop["stop_id"]
                for stop in direction.get(
                    "stops",
                    []
                )
            )

            selected_trip_ids = []

            # Find all trips whose exact stop pattern is the selected
            # direction.
            for trip_id, trip in (
                trips_by_id.items()
            ):

                if trip.get(
                    "route_id"
                ) != route_id:
                    continue

                items = stop_times_by_trip.get(
                    trip_id,
                    []
                )

                pattern = tuple(
                    item["stop_id"]
                    for item in items
                )

                if pattern == selected_pattern:
                    selected_trip_ids.append(
                        trip_id
                    )

            day_groups = {
                "weekday": weekday_services,
                "weekend": weekend_services,
            }

            direction_schedule = {}

            for day_type, service_ids in (
                day_groups.items()
            ):

                courses = []

                for trip_id in selected_trip_ids:

                    trip = trips_by_id[
                        trip_id
                    ]

                    if (
                        trip.get(
                            "service_id"
                        )
                        not in service_ids
                    ):
                        continue

                    items = stop_times_by_trip.get(
                        trip_id,
                        []
                    )

                    # Match Dimitar5555 exactly:
                    # timetable times are derived from GTFS
                    # departure_time at each stop.
                    times = [
                        item.get(
                            "departure_time"
                        )
                        or item.get(
                            "arrival_time"
                        )
                        or ""
                        for item in items
                    ]

                    if not times:
                        continue

                    start = times[0]

                    courses.append({
                        "trip_id": trip_id,
                        "start_time": start,
                        "times": times,
                    })

                courses.sort(
                    key=lambda c:
                        parse_time(
                            c["start_time"]
                        )
                        if parse_time(
                            c["start_time"]
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
            schedules[
                route_id
            ] = route_schedule

    return schedules


def main():

    print(
        "=== Sofia GTFS transport generator ==="
    )

    # ------------------------------------------------------------
    # 1. Download and extract official GTFS.
    # ------------------------------------------------------------

    download_gtfs()

    # ------------------------------------------------------------
    # 2. Read GTFS files.
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

    print(
        "calendar.txt not present; using calendar_dates.txt only."
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
    # 3. Active services.
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
        f"Weekday service IDs: "
        f"{len(weekday_services)}"
    )

    print(
        f"Weekend service IDs: "
        f"{len(weekend_services)}"
    )

    # ------------------------------------------------------------
    # 4. Index stops.
    # ------------------------------------------------------------

    stops_by_id = {}

    for row in stops_data:

        stop_id = normalize(
            row.get("stop_id")
        )

        if not stop_id:
            continue

        stops_by_id[
            stop_id
        ] = normalize_stop_record(
            row
        )

    # ------------------------------------------------------------
    # 5. Index trips.
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

        trips_by_id[
            trip_id
        ] = {
            "trip_id": trip_id,
            "route_id": normalize(
                row.get("route_id")
            ),
            "service_id": service_id,
            "trip_headsign": normalize(
                row.get("trip_headsign")
            ),
            "direction_id": normalize(
                row.get("direction_id")
            ),
            "shape_id": normalize(
                row.get("shape_id")
            )
        }

    # ------------------------------------------------------------
    # 6. Index stop_times by trip.
    # ------------------------------------------------------------

    stop_times_by_trip = defaultdict(list)

    for row in stop_times_data:

        trip_id = normalize(
            row.get("trip_id")
        )

        if not trip_id:
            continue

        trip = trips_by_id.get(
            trip_id
        )

        if trip is None:
            continue

        if use_service_filter:

            if (
                trip["service_id"]
                not in service_weights
            ):
                continue

        stop_id = normalize(
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
            "stop_id": stop_id,
            "sequence": sequence,
            "arrival_time": normalize(
                row.get(
                    "arrival_time"
                )
            ),
            "departure_time": normalize(
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
        f"Trips with active stop times: "
        f"{len(stop_times_by_trip)}"
    )

    # ------------------------------------------------------------
    # 7. Group exact stop patterns by route.
    #
    # IMPORTANT:
    # Direction identity is based on the exact ordered sequence
    # of stops, not on trip_headsign or direction_id.
    #
    # This is the same fundamental direction identification used
    # by Dimitar5555's 04-schedules.js.
    # ------------------------------------------------------------

    patterns_by_route = defaultdict(
        lambda: defaultdict(list)
    )

    for trip_id, trip in (
        trips_by_id.items()
    ):

        if trip_id not in stop_times_by_trip:
            continue

        route_id = trip[
            "route_id"
        ]

        if not route_id:
            continue

        pattern = build_stop_pattern(
            stop_times_by_trip,
            trip_id
        )

        if not pattern:
            continue

        patterns_by_route[
            route_id
        ][pattern].append(
            trip_id
        )

    print(
        f"Routes with active stop patterns: "
        f"{len(patterns_by_route)}"
    )

    # ------------------------------------------------------------
    # 8. Determine main directions.
    #
    # THIS is the changed section.
    #
    # Partial stop patterns are merged into the longer pattern,
    # following Dimitar5555's direction-merging approach.
    # ------------------------------------------------------------

    directions_result = {}

    matched_stops = 0
    unmatched_stops = 0

    for route_id, patterns in (
        patterns_by_route.items()
    ):

        pattern_weight = {}

        for pattern, trip_ids in (
            patterns.items()
        ):

            weight = 0

            for trip_id in trip_ids:

                service_id = trips_by_id[
                    trip_id
                ]["service_id"]

                weight += service_weights.get(
                    service_id,
                    1
                )

            pattern_weight[
                pattern
            ] = weight

        selected = select_main_patterns(
            patterns,
            {
                pattern: trip_ids
                for pattern, trip_ids
                in patterns.items()
            },
            pattern_weight
        )

        if not selected:
            continue

        directions = []

        for candidate in selected:

            trip_ids = list(
                candidate["trip_ids"]
            )

            if not trip_ids:
                continue

            # Prefer a representative around midday.
            selected_trip_id = (
                choose_daytime_trip(
                    trip_ids,
                    stop_times_by_trip
                )
            )

            trip = trips_by_id[
                selected_trip_id
            ]

            route_stops = []

            for item in stop_times_by_trip[
                selected_trip_id
            ]:

                stop_id = item[
                    "stop_id"
                ]

                stop = stops_by_id.get(
                    stop_id
                )

                if stop is None:
                    unmatched_stops += 1
                    continue

                matched_stops += 1

                route_stops.append({
                    "stop_id": stop_id,
                    "name": normalize(
                        stop.get(
                            "stop_name"
                        )
                    )
                })

            if not route_stops:
                continue

            direction = {
                "headsign": trip[
                    "trip_headsign"
                ],

                "trip_id":
                    selected_trip_id,

                "direction_id":
                    trip["direction_id"],

                "shape_id":
                    trip["shape_id"],

                "service_id":
                    trip["service_id"],

                "frequency":
                    candidate["weight"],

                "stop_count":
                    len(route_stops),

                "stops":
                    route_stops,

                "pattern": [
                    stop["stop_id"]
                    for stop in route_stops
                ]
            }

            directions.append(
                direction
            )

        if not directions:
            continue

        directions_result[
            route_id
        ] = {
            "A": directions[0],
            "B": (
                directions[1]
                if len(directions) > 1
                else None
            )
        }

    # ------------------------------------------------------------
    # 9. Build timetable/course data.
    # ------------------------------------------------------------

    schedules_result = build_schedule_data(
        directions_result,
        trips_by_id,
        stop_times_by_trip,
        weekday_services,
        weekend_services
    )

    print(
        "Schedule routes: "
        f"{len(schedules_result)}"
    )

    # ------------------------------------------------------------
    # 10. Diagnostics.
    # ------------------------------------------------------------

    print(
        f"Matched representative stops: "
        f"{matched_stops}"
    )

    print(
        f"Unmatched representative stops: "
        f"{unmatched_stops}"
    )

    # Useful diagnostics for the first test.
    for route in routes_data:

        route_id = normalize(
            route.get("route_id")
        )

        short_name = normalize(
            route.get(
                "route_short_name"
            )
        )

        if short_name in {
            "10",
            "ТМ10",
            "Т10"
        }:

            info = directions_result.get(
                route_id
            )

            print(
                ""
            )

            print(
                "=== TEST ROUTE 10 ==="
            )

            print(
                f"route_id: {route_id}"
            )

            print(
                f"route_short_name: "
                f"{short_name}"
            )

            if info:

                for direction in (
                    "A",
                    "B"
                ):

                    item = info.get(
                        direction
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
                        f"{direction}: "
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

            else:

                print(
                    "No directions generated "
                    "for route 10."
                )

    # ------------------------------------------------------------
    # 11. Load only the GTFS shapes used by the selected main
    #     directions.
    #
    # This does NOT affect route/direction/stop selection.
    # It only provides geometry for the future map.
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
    # 12. Preserve the existing output contract.
    # ------------------------------------------------------------

    result = {
        "updatedAt": today.isoformat(),

        "source":
            "CGM Sofia official GTFS",

        "routes": [
            normalize_route_record(row)
            for row in routes_data
        ],

        "stops": [
            normalize_stop_record(row)
            for row in stops_data
        ],

        "trips": [
            normalize_trip_record(row)
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
            separators=(",", ":")
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

    # The extracted GTFS data is deliberately removed after generation.
    if GTFS_DIR.exists():
        shutil.rmtree(GTFS_DIR)

    print(
        "Temporary GTFS files removed."
    )


if __name__ == "__main__":
    main()
