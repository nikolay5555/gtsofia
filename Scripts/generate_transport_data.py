#!/usr/bin/env python3

import csv
import io
import json
import re
import shutil
import urllib.request
import urllib.parse
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


GTFS_URL = "https://gtfs.sofiatraffic.bg/api/v1/static"

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
GTFS_DIR = ROOT / ".gtfs"
CALENDAR_CONFIG_FILE = ROOT / "config" / "calendar.json"
LINE_OVERRIDES_CONFIG_FILE = ROOT / "config" / "line-overrides.json"

OSM_NETWORK_NAME = "Градски транспорт София"

OSM_STOPS_TYPES = [
    {
        "type": "subway",
        "public_transport": "station",
    },
    {
        "type": "tram",
        "public_transport": "stop_position",
    },
    {
        "type": "bus",
        "public_transport": "platform",
    },
    {
        "type": "trolleybus",
        "public_transport": "platform",
    },
]


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
# OSM helpers
# ============================================================

def round_coordinate(value):
    try:
        return round(
            float(value),
            5
        )
    except (
        TypeError,
        ValueError
    ):
        return None


def transliterate(text):
    """
    Exact transliteration table from Dimitar5555's 02-stops.js.
    """

    cyrillic = (
        "А,Б,В,Г,Д,Е,Ж,З,И,Й,К,Л,М,Н,О,П,Р,С,Т,У,Ф,Х,Ц,Ч,Ш,Щ,Ъ,Ь,Ю,Я"
    ).split(",")

    latin = (
        "A,B,V,G,D,E,ZH,Z,I,Y,K,L,M,N,O,P,R,S,T,U,F,H,TS,CH,SH,SHT,A,A,YU,YA"
    ).split(",")

    if len(cyrillic) != len(latin):
        raise RuntimeError(
            "Cyrillic and Latin transliteration arrays differ."
        )

    result = []

    for char in str(text or ""):

        is_lower_case = (
            char == char.lower()
        )

        try:
            index = cyrillic.index(
                char.upper()
            )
        except ValueError:
            result.append(
                char
            )
            continue

        latin_char = latin[
            index
        ]

        if is_lower_case:
            latin_char = latin_char.lower()

        result.append(
            latin_char
        )

    return "".join(
        result
    )


def fetch_osm_stops():
    """
    Python equivalent of Dimitar5555's fetch_osm_stops().

    OSM is used only to improve/complete stop metadata.
    It does NOT replace GTFS geometry or schedules.
    """

    elements = "".join(
        (
            f'node[{item["type"]}=yes]'
            f'[public_transport={item["public_transport"]}]'
            f'[ref]'
            f'[network="{OSM_NETWORK_NAME}"];'
        )
        for item in OSM_STOPS_TYPES
    )

    query = (
        "[out:json][timeout:25];"
        f"({elements});"
        "out geom;"
    )

    body = urllib.parse.urlencode(
        {
            "data": query
        }
    ).encode(
        "utf-8"
    )

    request = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=body,
        method="POST",
        headers={
            "Referer":
                "https://overpass-turbo.eu/",

            "User-Agent":
                "github/nikolay5555/gtsofia"
        }
    )

    try:

        with urllib.request.urlopen(
            request,
            timeout=90
        ) as response:

            payload = response.read()

        data = json.loads(
            payload.decode(
                "utf-8"
            )
        )

    except Exception as error:

        print(
            "WARNING: OSM stop fetch failed:"
        )

        print(
            f"  {error}"
        )

        print(
            "Continuing with GTFS stop names."
        )

        return {}

    elements_data = data.get(
        "elements",
        []
    )

    result = {}

    for element in elements_data:

        tags = element.get(
            "tags",
            {}
        )

        ref = normalize(
            tags.get(
                "ref"
            )
        )

        if not ref:
            continue

        if (
            tags.get(
                "subway"
            )
            == "yes"
        ):

            code = (
                "M"
                + ref
            )

        else:

            code = ref.zfill(
                4
            )

        name_bg = normalize(
            tags.get(
                "name"
            )
        )

        name_en = normalize(
            tags.get(
                "name:en"
            )
        )

        if not name_en:
            name_en = transliterate(
                name_bg
            )

        result[
            code
        ] = {
            "code":
                code,

            "name":
                name_bg,

            "name_en":
                name_en,

            "lat":
                round_coordinate(
                    element.get(
                        "lat"
                    )
                ),

            "lon":
                round_coordinate(
                    element.get(
                        "lon"
                    )
                ),
        }

    print(
        "OSM stops fetched: "
        f"{len(result)}"
    )

    return result


def merge_osm_stop_names(
    stops,
    osm_stops
):
    """
    Preserve the current GTFS stop structure while enriching names.

    For matching stop codes:
        OSM name -> preferred
        GTFS name -> fallback

    The rest of the GTFS stop record remains unchanged.
    """

    if not osm_stops:
        return stops

    updated = []

    matched = 0

    for stop in stops:

        stop_copy = dict(
            stop
        )

        stop_id = normalize(
            stop_copy.get(
                "stop_id"
            )
        )

        osm_stop = osm_stops.get(
            stop_id
        )

        if osm_stop:

            matched += 1

            osm_name = normalize(
                osm_stop.get(
                    "name"
                )
            )

            if osm_name:
                stop_copy[
                    "stop_name"
                ] = osm_name

            osm_name_en = normalize(
                osm_stop.get(
                    "name_en"
                )
            )

            if osm_name_en:

                stop_copy[
                    "stop_name_en"
                ] = osm_name_en

        updated.append(
            stop_copy
        )

    print(
        "GTFS stops matched with OSM: "
        f"{matched}"
    )

    return updated


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

    Names are merged with OSM later. Duplicate stop_ids are retained in the
    output, but the lookup index chooses the most useful public stop record.
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
# Split output (Dimitar5555-style model)
# ============================================================

def normalize_route_ref(route_ref):
    """Normalize CGM line references like Dimitar5555's 03-routes.js."""
    value = normalize(route_ref).upper()
    if not value:
        return ""

    number = re.sub(r"[A-ZА-Я]", "", value, flags=re.IGNORECASE)

    if value.startswith(("E", "Е")):
        return number
    if value.startswith("N"):
        return f"N{number}"
    if value.startswith("Y"):
        return f"У{number}"
    if value.endswith(("ТБ", "TB")):
        return f"{number}ТБ"
    if value.endswith(("ТМ", "TM", "Т", "T")):
        return f"{number}ТМ"

    return value


def apply_route_override(route_ref, route_type, route_id, overrides):
    override = next(
        (
            item for item in overrides
            if normalize(item.get("cgm_id")) == route_id
        ),
        None,
    )

    if override is None:
        override = next(
            (
                item for item in overrides
                if not normalize(item.get("cgm_id"))
                and normalize(item.get("route_ref")) == route_ref
            ),
            None,
        )

    if override:
        if normalize(override.get("route_ref")):
            route_ref = normalize(override.get("route_ref"))
        if normalize(override.get("type")):
            route_type = normalize(override.get("type"))

    return route_ref, route_type


def build_output_routes(routes_data, logical_trips, overrides):
    """Write compact route metadata; do not expose the raw GTFS routes table."""
    active_ids = {
        normalize(trip.get("route_id"))
        for trip in logical_trips
        if normalize(trip.get("route_id"))
        and not trip.get("is_deleted", False)
    }

    result = []

    for route in routes_data:
        route_id = normalize(route.get("route_id"))
        if route_id not in active_ids:
            continue

        route_ref = normalize_route_ref(route.get("route_short_name"))
        route_type = {
            "0": "tram",
            "1": "metro",
            "3": "bus",
            "11": "trolley",
        }.get(normalize(route.get("route_type")), "other")

        base_route_type = route_type
        route_ref, route_type = apply_route_override(
            route_ref, route_type, route_id, overrides
        )

        # Match Dimitar5555's current route post-processing:
        # replacement-bus refs and trolley refs 50+ are treated as buses.
        route_number = re.sub(r"[^0-9]", "", route_ref)
        if (
            route_ref.endswith(("ТБ", "ТМ"))
            or (route_ref.startswith("М") and route_type == "bus")
            or (base_route_type == "trolley" and route_number.isdigit() and int(route_number) >= 50)
        ):
            route_type = "bus"

        subtype = ""
        if route_ref.startswith("N"):
            route_type = "bus"
            subtype = "night"
        elif route_ref.startswith("У"):
            route_type = "bus"
            subtype = "school"
        elif route_ref.endswith(("ТБ", "ТМ")) or (route_ref.startswith("M") and route_type == "bus"):
            route_type = "bus"
            if route_ref.endswith(("ТБ", "ТМ")):
                subtype = "temporary"

        item = {
            "cgm_id": route_id,
            "route_index": len(result),
            "route_ref": route_ref,
            "type": route_type,
        }

        if subtype:
            item["subtype"] = subtype

        override = next(
            (
                item for item in overrides
                if normalize(item.get("cgm_id")) == route_id
            ),
            None,
        )
        if override is None:
            override = next(
                (
                    item for item in overrides
                    if not normalize(item.get("cgm_id"))
                    and normalize(item.get("route_ref")) == normalize(route_ref)
                ),
                None,
            )

        color = normalize(route.get("route_color"))
        text_color = normalize(route.get("route_text_color"))
        if color and not (override and normalize(override.get("type"))):
            item["bg_color"] = f"#{color.lstrip('#')}"
        if text_color and not (override and normalize(override.get("type"))):
            item["text_color"] = f"#{text_color.lstrip('#')}"

        result.append(item)

    return result


def build_output_stops(stops, directions):
    """Compact stop records to code/coords/names, then filter unused stops."""
    used = {
        normalize(stop_id)
        for direction in directions
        for stop_id in direction.get("stops", [])
        if normalize(stop_id)
    }

    best = {}
    for stop in stops:
        code = normalize(stop.get("stop_id")) or normalize(stop.get("stop_code"))
        if not code or code not in used:
            continue

        try:
            lat = round(float(stop.get("stop_lat")), 5)
            lon = round(float(stop.get("stop_lon")), 5)
        except (TypeError, ValueError):
            continue

        bg = normalize(stop.get("stop_name"))
        en = normalize(stop.get("stop_name_en")) or transliterate(bg)
        candidate = {
            "code": code,
            "coords": [lat, lon],
            "names": {"bg": bg, "en": en},
        }

        current = best.get(code)
        if current is None or (
            not current["names"].get("en")
            and candidate["names"].get("en")
        ):
            best[code] = candidate

    return [best[key] for key in sorted(best)]


def build_output_directions(
    routes_data,
    directions,
    logical_trips,
    trips_by_id,
    stop_times_by_trip,
    stops_by_id,
):
    """Flat global directions, matching the current Dimitar5555 data model."""
    route_ids = {
        normalize(route.get("route_id"))
        for route in routes_data
    }

    surviving_codes = set()
    for trip in logical_trips:
        if trip.get("is_deleted", False):
            continue
        code = normalize(trip.get("direction_code"))
        if code:
            surviving_codes.add(code)

    for direction in directions:
        code = normalize(direction.get("code"))
        route_id = normalize(direction.get("route_id"))
        if not code or code not in surviving_codes:
            continue

        result.append({
            "code": int(code) if code.isdigit() else code,
            "cgm_id": route_id,
            "stops": [normalize(x) for x in direction.get("stops", []) if normalize(x)],
            "headsign": choose_direction_name(direction, stops_by_id),
            "destination": choose_direction_name(direction, stops_by_id),
            "direction_id": normalize(
                next(
                    (
                        trips_by_id[trip_id].get("direction_id")
                        for trip_id in direction.get("trip_ids", [])
                        if trip_id in trips_by_id
                        and normalize(trips_by_id[trip_id].get("direction_id"))
                    ),
                    "",
                )
            ),
            "shape_id": choose_shape_id(direction),
        })

    return result


def build_output_trips(logical_trips, routes):
    route_index_by_id = {
        normalize(route.get("cgm_id")): route.get("route_index")
        for route in routes
    }

    result = []
    for trip in logical_trips:
        if trip.get("is_deleted", False):
            continue

        route_id = normalize(trip.get("route_id"))
        direction = trip.get("direction_code")
        day_types = [
            value for value in trip.get("day_types", [])
            if value in {"weekday", "weekend"}
        ]

        item = {
            "id": trip.get("id"),
            "route_index": route_index_by_id.get(route_id, -1),
            "cgm_id": route_id,
            "direction": int(direction) if normalize(direction).isdigit() else direction,
            "is_weekend": day_types == ["weekend"],
            "day_types": day_types,
        }
        result.append(item)

    return result


def build_output_stop_times(logical_stop_times, valid_trip_ids):
    result = []
    for row in logical_stop_times:
        trip_id = row.get("trip")
        if trip_id not in valid_trip_ids:
            continue
        times = []
        for value in row.get("times", []):
            if value is None:
                times.append(None)
            else:
                try:
                    times.append(int(value))
                except (TypeError, ValueError):
                    times.append(None)

        if not times or not any(value is not None for value in times):
            continue

        result.append({
            "trip": trip_id,
            "times": times,
            "car": normalize(row.get("car")),
        })

    return result


def build_trip_aliases(logical_trips):
    """Map GTFS-RT physical trip ids to the compact logical trip id."""
    result = {}
    for trip in logical_trips:
        if trip.get("is_deleted", False):
            continue
        logical_id = trip.get("id")
        for original_id in trip.get("original_trip_ids", []):
            value = normalize(original_id)
            if value:
                result[value] = logical_id
    return result


def build_compact_calendar(calendar_result):
    return {
        "referenceDate": calendar_result.get("referenceDate"),
        "endDate": calendar_result.get("endDate"),
        "dateTypes": calendar_result.get("dateTypes", {}),
        "config": calendar_result.get("config", {}),
    }


def build_active_service_ids(calendar_result):
    counts = defaultdict(lambda: {"weekday": 0, "weekend": 0})
    date_types = calendar_result.get("dateTypes", {})
    services_by_date = calendar_result.get("serviceIdsByDate", {})

    for date_key, service_ids in services_by_date.items():
        day_type = date_types.get(date_key)
        if day_type not in {"weekday", "weekend"}:
            continue
        for service_id in service_ids:
            counts[normalize(service_id)][day_type] += 1

    return [
        [service_id, values["weekend"] >= values["weekday"]]
        for service_id, values in sorted(counts.items())
    ]


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, separators=(",", ":"))


def sha256_file(path):
    import hashlib
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_split_data(
    routes,
    stops,
    directions,
    logical_trips,
    logical_stop_times,
    trip_aliases,
    calendar_result,
    active_service_ids,
    shapes,
    updated_at,
):
    """Write independently cacheable files instead of transport.json."""
    files = {
        "routes.json": routes,
        "stops.json": stops,
        "directions.json": directions,
        "trips.json": logical_trips,
        "stop_times.json": logical_stop_times,
        "trip_aliases.json": trip_aliases,
        "calendar.json": build_compact_calendar(calendar_result),
        "active_service_ids.json": active_service_ids,
        "shapes.json": shapes,
    }

    # Remove the legacy monolith and any stale generated file not in the split model.
    legacy = DATA_DIR / "transport.json"
    if legacy.exists():
        legacy.unlink()

    for filename, value in files.items():
        write_json(DATA_DIR / filename, value)

    metadata = {
        "version": 1,
        "generatedAt": updated_at,
        "source": "CGM Sofia official GTFS",
        "files": {
            filename: {
                "sha256": sha256_file(DATA_DIR / filename),
                "bytes": (DATA_DIR / filename).stat().st_size,
            }
            for filename in files
        },
    }
    write_json(DATA_DIR / "metadata.json", metadata)

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
        # OSM stop names
        #
        # IMPORTANT:
        # This ONLY enriches stop metadata.
        # It does not affect:
        #   - direction selection
        #   - schedules
        #   - partial courses
        #   - shapes
        # --------------------------------------------------------

        print(
            ""
        )

        print(
            "Fetching OSM stop names..."
        )

        osm_stops = (
            fetch_osm_stops()
        )

        output_stops = (
            merge_osm_stop_names(
                output_stops,
                osm_stops
            )
        )

        # Rebuild the stop index after
        # updating names.
        stops_by_id = build_stop_index(
            output_stops
        )

        print(
            "Stops after OSM merge: "
            f"{len(output_stops)}"
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
        # Split output
        # --------------------------------------------------------

        output_directions = build_output_directions(
            routes_data,
            directions,
            logical_trips,
            trips_by_id,
            stop_times_by_trip,
            stops_by_id,
        )

        output_routes = build_output_routes(
            routes_data,
            logical_trips,
            line_overrides,
        )

        output_stops = build_output_stops(
            output_stops,
            output_directions,
        )

        output_trips = build_output_trips(
            logical_trips,
            output_routes,
        )
        valid_trip_ids = {trip["id"] for trip in output_trips}
        output_stop_times = build_output_stop_times(
            logical_stop_times,
            valid_trip_ids,
        )
        output_trip_aliases = build_trip_aliases(logical_trips)

        selected_shape_ids = {
            normalize(direction.get("shape_id"))
            for direction in output_directions
            if normalize(direction.get("shape_id"))
        }
        shapes_result = load_shapes(selected_shape_ids)

        active_service_ids = build_active_service_ids(calendar_result)
        metadata = write_split_data(
            output_routes,
            output_stops,
            output_directions,
            output_trips,
            output_stop_times,
            output_trip_aliases,
            calendar_result,
            active_service_ids,
            shapes_result,
            today.isoformat(),
        )

        print("")
        print("=== Split data summary ===")
        print(f"Routes: {len(output_routes)}")
        print(f"Stops: {len(output_stops)}")
        print(f"Directions: {len(output_directions)}")
        print(f"Logical trips: {len(output_trips)}")
        print(f"Stop-time rows: {len(output_stop_times)}")
        print(f"Trip aliases: {len(output_trip_aliases)}")
        print(f"Shapes: {len(shapes_result)}")
        print(f"Metadata files: {len(metadata['files'])}")

        print("")
        print("=== Direction diagnostics ===")

        for route in output_routes:
            route_id = normalize(route.get("cgm_id"))
            refs = [
                direction for direction in output_directions
                if normalize(direction.get("cgm_id")) == route_id
            ]
            if not refs:
                continue
            print(f"\n{route.get('route_ref', route_id)}:")
            for direction in refs:
                trip_count = sum(
                    1 for trip in output_trips
                    if normalize(trip.get("cgm_id")) == route_id
                    and normalize(trip.get("direction")) == normalize(direction.get("code"))
                )
                print(
                    f"  direction {direction.get('code')}: "
                    f"{len(direction.get('stops', []))} stops, {trip_count} logical trip groups"
                )

    finally:

        if GTFS_DIR.exists():
            shutil.rmtree(GTFS_DIR)

        print("Temporary GTFS files removed.")


if __name__ == "__main__":
    main()
