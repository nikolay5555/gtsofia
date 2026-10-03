#!/usr/bin/env python3

import csv
import io
import hashlib
import json
import re
import shutil
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


GTFS_URL = "https://gtfs.sofiatraffic.bg/api/v1/static"

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
GTFS_DIR = ROOT / ".gtfs"
OUTPUT_FILE = DATA_DIR / "transport.json"
CALENDAR_CONFIG_FILE = ROOT / "config" / "calendar.json"
LINE_OVERRIDES_CONFIG_FILE = ROOT / "config" / "line-overrides.json"



def load_line_overrides():
    if not LINE_OVERRIDES_CONFIG_FILE.exists():
        return []

    with LINE_OVERRIDES_CONFIG_FILE.open(
        "r",
        encoding="utf-8"
    ) as file:
        data = json.load(file)

    if not isinstance(data, list):
        raise ValueError(
            "config/line-overrides.json must contain an array."
        )

    return data


def normalize(value):
    return str(value).strip() if value is not None else ""


def normalize_stop_id(value):
    value = normalize(value)

    if not value:
        return ""

    if value.startswith("M"):
        return value

    digits = "".join(
        char
        for char in value
        if char.isdigit()
    )

    return digits.zfill(4)


def parse_date(value):
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


def parse_time(value):
    value = normalize(value)

    if not value:
        return None

    try:
        hours, minutes, seconds = map(
            int,
            value.split(":")
        )

        return (
            hours * 3600
            + minutes * 60
            + seconds
        )

    except (
        TypeError,
        ValueError
    ):
        return None


SOFIA_TIME_ZONE = ZoneInfo("Europe/Sofia")


def get_today():
    # GTFS service dates are evaluated in the agency's local time. Sofia's
    # official feed is published for Europe/Sofia, so never use UTC here:
    # around midnight UTC that could select the wrong service date.
    return datetime.now(
        SOFIA_TIME_ZONE
    ).date()


GTFS_WEEKDAY_FIELDS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)


def gtfs_date_string(current):
    return current.strftime("%Y%m%d")


def iso_date_string(current):
    return current.isoformat()


# ============================================================
# GTFS
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

        names = {
            Path(name).name
            for name in archive.namelist()
        }

        required = {
            "routes.txt",
            "stops.txt",
            "trips.txt",
            "stop_times.txt",
        }

        missing = required - names

        if missing:
            raise RuntimeError(
                "GTFS archive is missing required files: "
                + ", ".join(
                    sorted(missing)
                )
            )

        has_calendar = "calendar.txt" in names
        has_calendar_dates = "calendar_dates.txt" in names

        if not has_calendar and not has_calendar_dates:
            raise RuntimeError(
                "GTFS archive must contain calendar.txt or calendar_dates.txt."
            )

        archive.extractall(
            GTFS_DIR
        )

    print(
        f"GTFS extracted to: {GTFS_DIR}"
    )


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
# Services
# ============================================================

def _calendar_row_covers_date(row, current):
    start_date = parse_date(row.get("start_date"))
    end_date = parse_date(row.get("end_date"))

    if start_date is None or end_date is None:
        return False

    if current < start_date or current > end_date:
        return False

    field = GTFS_WEEKDAY_FIELDS[current.weekday()]
    return normalize(row.get(field)) == "1"


def _apply_calendar_date_exceptions(
    service_ids,
    calendar_dates_by_date,
    current
):
    effective = set(service_ids)

    for row in calendar_dates_by_date.get(
        gtfs_date_string(current),
        []
    ):
        service_id = normalize(row.get("service_id"))
        exception_type = normalize(row.get("exception_type"))

        if not service_id:
            continue

        if exception_type == "1":
            effective.add(service_id)
        elif exception_type == "2":
            effective.discard(service_id)

    return effective


def load_calendar_config(path=CALENDAR_CONFIG_FILE):
    if not path.exists():
        return {"dateOverrides": {}}

    with path.open("r", encoding="utf-8") as file:
        raw = json.load(file)

    if not isinstance(raw, dict):
        raise ValueError("Calendar config must be a JSON object.")

    overrides = raw.get("dateOverrides", {})
    if not isinstance(overrides, dict):
        raise ValueError("calendar.json dateOverrides must be an object.")

    normalized_overrides = {}
    for raw_date, raw_day_type in overrides.items():
        date_value = parse_date(raw_date.replace("-", ""))
        if date_value is None:
            raise ValueError(
                f"Invalid calendar override date: {raw_date}"
            )

        day_type = normalize(raw_day_type).lower()
        if day_type not in {"weekday", "weekend"}:
            raise ValueError(
                f"Invalid calendar override type for {raw_date}: {raw_day_type}"
            )

        normalized_overrides[iso_date_string(date_value)] = day_type

    return {
        "dateOverrides": normalized_overrides,
    }


def build_calendar_context(
    calendar,
    calendar_dates,
    today,
    horizon_days=15,
    calendar_config=None
):
    """
    Evaluate GTFS service dates exactly from calendar.txt plus
    calendar_dates.txt. The resulting weekday/weekend buckets are an
    application-level view only; GTFS service_id remains the source of truth.
    """

    end_date = today + timedelta(days=horizon_days)
    has_calendar = bool(calendar)
    calendar_config = calendar_config or {"dateOverrides": {}}
    date_overrides = calendar_config.get("dateOverrides", {})

    calendar_by_service = {}
    for row in calendar:
        service_id = normalize(row.get("service_id"))
        if service_id:
            calendar_by_service[service_id] = dict(row)

    calendar_dates_by_date = defaultdict(list)
    for row in calendar_dates:
        service_id = normalize(row.get("service_id"))
        date_value = parse_date(row.get("date"))
        exception_type = normalize(row.get("exception_type"))

        if not service_id or date_value is None:
            continue

        if exception_type not in {"1", "2"}:
            continue

        calendar_dates_by_date[gtfs_date_string(date_value)].append(
            dict(row)
        )

    date_types = {}
    service_ids_by_date = {}
    service_day_types = defaultdict(set)

    current = today
    while current <= end_date:
        base_service_ids = {
            service_id
            for service_id, row in calendar_by_service.items()
            if _calendar_row_covers_date(row, current)
        }

        effective_service_ids = _apply_calendar_date_exceptions(
            base_service_ids,
            calendar_dates_by_date,
            current
        )

        # GTFS determines which service_ids are active on the date. The
        # project's two-button UI is a separate application-level view. By
        # default it follows the local weekday/weekend of the date; explicit
        # operational overrides live in config/calendar.json so holidays or
        # other authority-defined schedule regimes are maintained centrally.
        date_key = iso_date_string(current)
        day_type = date_overrides.get(
            date_key,
            "weekend" if current.weekday() >= 5 else "weekday"
        )

        date_types[date_key] = day_type
        service_ids_by_date[date_key] = sorted(effective_service_ids)

        for service_id in effective_service_ids:
            service_day_types[service_id].add(day_type)

        current += timedelta(days=1)

    # If calendar.txt is omitted, calendar_dates.txt is the complete service
    # definition according to GTFS. In that form the only defensible
    # weekday/weekend split available to the application is the actual day of
    # week of each explicit service date.
    if not has_calendar:
        service_day_types.clear()
        for date_key, day_type in date_types.items():
            for service_id in service_ids_by_date[date_key]:
                service_day_types[service_id].add(day_type)

    result = {
        service_id: sorted(
            day_types,
            key=lambda value: 0 if value == "weekday" else 1
        )
        for service_id, day_types in service_day_types.items()
    }

    calendar_result = {
        "referenceDate": today.isoformat(),
        "endDate": end_date.isoformat(),
        "servicePatterns": [dict(row) for row in calendar],
        "exceptions": [dict(row) for row in calendar_dates],
        "serviceIdsByDate": service_ids_by_date,
        "dateTypes": date_types,
        "serviceDayTypes": result,
        "config": calendar_config,
    }

    print(
        "Service date window: "
        f"{today} -> {end_date}"
    )
    print(
        "Calendar services: "
        f"{len(calendar_by_service)}"
    )
    print(
        "Calendar exceptions: "
        f"{len(calendar_dates)}"
    )
    print(
        "Weekday service IDs: "
        f"{sum("weekday" in types for types in result.values())}"
    )
    print(
        "Weekend/holiday service IDs: "
        f"{sum("weekend" in types for types in result.values())}"
    )

    return result, calendar_result



# ============================================================
# Stops
# ============================================================

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


# ============================================================
# Trips
# ============================================================

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
    trips_by_id
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

        stop_id = normalize_stop_id(
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

def build_output_directions(
    routes_data,
    directions,
    logical_trips,
    trips_by_id,
    stop_times_by_trip,
    stops_by_id
):
    """
    Output ALL surviving directions.

    No A/B restriction.
    """

    result = {}

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
            for trip in logical_trips
            if (
                trip[
                    "route_id"
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
                "direction_code"
            ]

            if code not in direction_codes:

                direction_codes.append(
                    code
                )

        route_directions = {}

        for ordinal, code in enumerate(
            direction_codes,
            start=1
        ):

            direction = directions_by_code.get(
                code
            )

            if direction is None:
                continue

            stop_records = []

            for stop_id in direction[
                "stops"
            ]:

                stop = stops_by_id.get(
                    stop_id
                )

                if stop is None:
                    continue

                stop_records.append({
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

            if not stop_records:
                continue

            direction_trips = [
                trip
                for trip in route_trips
                if trip[
                    "direction_code"
                ]
                == code
            ]

            representative = None

            if direction_trips:

                representative_id = (
                    direction_trips[
                        0
                    ].get(
                        "original_trip_ids",
                        []
                    )[0]
                    if direction_trips[
                        0
                    ].get(
                        "original_trip_ids"
                    )
                    else ""
                )

                if representative_id:

                    representative = (
                        trips_by_id.get(
                            representative_id
                        )
                    )

            direction_key = (
                f"D{ordinal}"
            )

            direction_name = (
                choose_direction_name(
                    direction,
                    stops_by_id
                )
            )

            route_directions[
                direction_key
            ] = {

                "key":
                    direction_key,

                "code":
                    code,

                "headsign":
                    direction_name,

                "destination":
                    direction_name,

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
                    choose_shape_id(
                        direction
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
                    len(
                        direction_trips
                    ),

                "stop_count":
                    len(
                        stop_records
                    ),

                "stops":
                    stop_records,

                "pattern":
                    [
                        stop[
                            "stop_id"
                        ]
                        for stop in stop_records
                    ]
            }

        if route_directions:

            result[
                route_id
            ] = route_directions

    return result


# ============================================================
# Schedules
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

                        "car":
                            item.get(
                                "car",
                                ""
                            )
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


# ============================================================
# Shapes
# ============================================================

def load_shapes(
    shape_ids
):
    path = (
        GTFS_DIR
        / "shapes.txt"
    )

    if not path.exists():
        return {}

    shape_ids = {
        normalize(value)
        for value in shape_ids
        if normalize(value)
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
                    sequence
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
                    ]
            }
            for item in items
        ]

    return result


# ============================================================
# Canonical schedule/data model
# ============================================================

def determine_model_route_ref(ref):
    ref = normalize(ref).upper()
    number = re.sub(r"[A-ZА-Я]", "", ref)

    if ref.startswith("E") or ref.startswith("Е"):
        return number

    if ref.startswith("N"):
        return f"N{number}"

    if ref.startswith("Y"):
        return f"У{number}"

    if ref.endswith(("ТБ", "TB")):
        return f"{number}ТБ"

    if ref.endswith(("ТМ", "TM", "Т", "T")):
        return f"{number}ТМ"

    return ref


def determine_model_route_type(route_ref, route_type):
    route_ref = normalize(route_ref).upper()
    type_mapping = {
        "0": "tram",
        "1": "metro",
        "3": "bus",
        "11": "trolley",
    }

    model_type = type_mapping.get(normalize(route_type), "other")

    if (
        route_ref.endswith(("ТБ", "ТМ"))
        or (route_ref.startswith("М") and model_type == "bus")
    ):
        model_type = "bus"

    digits = re.sub(r"[A-ZА-Я]", "", route_ref)
    try:
        sort_ref = int(digits)
    except ValueError:
        sort_ref = 0

    if sort_ref >= 50 and model_type == "trolley":
        model_type = "bus"

    return model_type


def build_model_routes(routes_data, active_route_ids):
    result = []

    for route in routes_data:
        route_id = normalize(route.get("route_id"))
        if route_id not in active_route_ids:
            continue

        route_ref = determine_model_route_ref(
            route.get("route_short_name", "")
        )
        route_type = determine_model_route_type(
            route_ref,
            route.get("route_type", "")
        )

        model_route = {
            "cgm_id": route_id,
            "route_ref": route_ref,
            "type": route_type,
        }

        if route_type == "metro":
            text_color = normalize(route.get("route_text_color"))
            bg_color = normalize(route.get("route_color"))

            if text_color:
                model_route["text_color"] = text_color

            if bg_color:
                model_route["bg_color"] = bg_color

        result.append(model_route)

    return result


CYRILLIC_TO_LATIN = dict(
    zip(
        "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯ",
        [
            "A", "B", "V", "G", "D", "E", "ZH", "Z", "I", "Y",
            "K", "L", "M", "N", "O", "P", "R", "S", "T", "U",
            "F", "H", "TS", "CH", "SH", "SHT", "A", "A", "YU", "YA"
        ],
    )
)


def transliterate_bulgarian(text):
    text = normalize(text)
    result = []

    for char in text:
        upper = char.upper()
        replacement = CYRILLIC_TO_LATIN.get(upper)

        if replacement is None:
            result.append(char)
            continue

        result.append(
            replacement.lower()
            if char == char.lower()
            else replacement
        )

    return "".join(result)


def round_coordinate(value):
    try:
        return round(float(value), 5)
    except (TypeError, ValueError):
        return None


def build_model_stops(output_stops, used_stop_ids):
    result = []

    for stop in output_stops:
        stop_id = normalize(stop.get("stop_id"))
        if stop_id not in used_stop_ids:
            continue

        lat = round_coordinate(stop.get("stop_lat"))
        lon = round_coordinate(stop.get("stop_lon"))

        if lat is None or lon is None:
            continue

        bg_name = normalize(stop.get("stop_name"))
        en_name = transliterate_bulgarian(bg_name)

        result.append({
            "code": stop_id,
            "coords": [lat, lon],
            "names": {
                "bg": bg_name,
                "en": en_name,
            },
        })

    return result


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
        # GTFS date evaluation remains in transport.json/calendar.
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
        # Read GTFS
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

        calendar = (
            read_csv("calendar.txt")
            if (GTFS_DIR / "calendar.txt").exists()
            else []
        )

        calendar_dates = (
            read_csv("calendar_dates.txt")
            if (GTFS_DIR / "calendar_dates.txt").exists()
            else []
        )

        today = get_today()
        line_overrides = load_line_overrides()

        print(
            f"Service reference date: {today}"
        )

        # --------------------------------------------------------
        # Active services
        # --------------------------------------------------------

        calendar_config = load_calendar_config()

        (
            service_day_types,
            calendar_result
        ) = build_calendar_context(
            calendar,
            calendar_dates,
            today,
            calendar_config=calendar_config
        )

        # --------------------------------------------------------
        # GTFS stops
        # --------------------------------------------------------

        output_stops, stops_by_id = (
            build_stops(
                stops_data
            )
        )

        # --------------------------------------------------------
        # Trips
        # --------------------------------------------------------

        trips_by_id = build_trips(
            trips_data,
            service_day_types
        )

        # --------------------------------------------------------
        # Stop times
        # --------------------------------------------------------

        stop_times_by_trip = (
            build_stop_times(
                stop_times_data,
                trips_by_id
            )
        )

        print(
            "Active trips: "
            f"{len(trips_by_id)}"
        )

        print(
            "Trips with stop times: "
            f"{len(stop_times_by_trip)}"
        )

        # --------------------------------------------------------
        # Directions
        # --------------------------------------------------------

        (
            directions,
            logical_trips,
            logical_stop_times
        ) = build_reference_directions(
            trips_by_id,
            stop_times_by_trip
        )

        print(
            "Initial directions: "
            f"{len(directions)}"
        )

        # --------------------------------------------------------
        # Partial directions
        # --------------------------------------------------------

        merge_partial_directions(
            routes_data,
            directions,
            logical_trips,
            logical_stop_times
        )

        print(
            "Directions after partial merge: "
            f"{len(directions)}"
        )

        # --------------------------------------------------------
        # Logical trips
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
        # Output directions
        # --------------------------------------------------------

        directions_result = (
            build_output_directions(
                routes_data,
                directions,
                logical_trips,
                trips_by_id,
                stop_times_by_trip,
                stops_by_id
            )
        )

        # --------------------------------------------------------
        # Schedules
        # --------------------------------------------------------

        schedules_result = (
            build_schedules(
                directions_result,
                logical_trips,
                logical_stop_times
            )
        )

        # --------------------------------------------------------
        # Shapes
        # --------------------------------------------------------

        selected_shape_ids = set()

        for route_directions in (
            directions_result.values()
        ):

            for direction in (
                route_directions.values()
            ):

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
        # Final output
        # --------------------------------------------------------

        canonical_model = build_model_schedule_data(
            routes_data,
            output_stops,
            directions,
            logical_trips,
            logical_stop_times,
            trips_by_id,
            calendar_result,
        )

        realtime_trips = build_model_realtime_trips(
            logical_trips,
            trips_by_id
        )

        canonical_metadata = write_canonical_data_model(
            canonical_model,
            calendar_result,
            line_overrides,
            shapes_result,
            realtime_trips,
            today.isoformat(),
        )

        result = {

            "updatedAt":
                today.isoformat(),

            "source":
                "CGM Sofia official GTFS",

            # Presentation-only mappings. The original GTFS routes above
            # remain untouched; the frontend applies these overrides when
            # displaying line metadata.
            "lineOverrides":
                line_overrides,

            "calendar":
                calendar_result,

            # Keep transport.json compatible with the existing frontend.
            # The canonical Dimitar-style schedule model lives in the
            # separate data/*.json files.
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

        print(
            ""
        )

        print(
            "=== Generation summary ==="
        )

        print(
            "Routes: "
            f"{len(routes_data)}"
        )

        print(
            "Stops: "
            f"{len(output_stops)}"
        )

        print(
            "Directions: "
            f"{sum(len(value) for value in directions_result.values())}"
        )

        print(
            "Schedule routes: "
            f"{len(schedules_result)}"
        )

        print(
            "Shapes: "
            f"{len(shapes_result)}"
        )

        print(
            "Canonical data model: "
            f"routes={len(canonical_model['routes'])}, "
            f"stops={len(canonical_model['stops'])}, "
            f"trips={len(canonical_model['trips'])}, "
            f"directions={len(canonical_model['directions'])}, "
            f"stop_times={len(canonical_model['stop_times'])}"
        )

        print(
            "Canonical metadata hashes: "
            f"{len(canonical_metadata['hashes'])}"
        )

        print(
            "Canonical split data files: "
            f"{len(canonical_metadata['files'])}"
        )

        print(
            "Realtime trip mappings: "
            f"{len(realtime_trips)}"
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

            route_directions = (
                directions_result.get(
                    route_id,
                    {}
                )
            )

            if not route_directions:
                continue

            print(
                f"\n{short_name}:"
            )

            for key, direction in (
                route_directions.items()
            ):

                schedule = (
                    schedules_result
                    .get(
                        route_id,
                        {}
                    )
                    .get(
                        key,
                        {}
                    )
                )

                print(
                    "  "
                    f"{key}: "
                    f"{direction['headsign']} | "
                    f"stops={len(direction['stops'])} | "
                    f"weekday={len(schedule.get('weekday', []))} | "
                    f"weekend={len(schedule.get('weekend', []))}"
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
