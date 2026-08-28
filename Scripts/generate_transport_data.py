#!/usr/bin/env python3

import csv
import io
import json
import shutil
import urllib.request
import urllib.parse
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


GTFS_URL = "https://gtfs.sofiatraffic.bg/api/v1/static"

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
GTFS_DIR = ROOT / ".gtfs"
OUTPUT_FILE = DATA_DIR / "transport.json"

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


def get_today():
    return datetime.now(
        timezone.utc
    ).date()


def is_weekend_date(current):
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
    Preserve the current transport.json structure.

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

def build_active_service_ids(
    calendar_dates,
    today
):
    """
    Python equivalent of Dimitar5555's 03-routes.js.

    service_id -> False  => weekday
    service_id -> True   => weekend/holiday
    """

    end_date = (
        today
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

        current = parse_date(
            row.get(
                "date"
            )
        )

        if current is None:
            continue

        if current < today:
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

        result[
            service_id
        ] = (
            counts[
                "weekday_count"
            ]
            <=
            counts[
                "weekend_count"
            ]
        )

    print(
        "Active service IDs: "
        f"{len(result)}"
    )

    print(
        "Weekday services: "
        f"{sum(value is False for value in result.values())}"
    )

    print(
        "Weekend/holiday services: "
        f"{sum(value is True for value in result.values())}"
    )

    return result


# ============================================================
# Stops
# ============================================================

def build_stops(
    stops_data
):
    """
    Keep the existing stop structure and normalized IDs.

    Names are merged with OSM later.
    """

    result = []
    by_id = {}

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

        by_id[
            normalized_id
        ] = stop

        result.append(
            stop
        )

    return (
        result,
        by_id
    )


# ============================================================
# Trips
# ============================================================

def build_trips(
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

        if (
            service_id
            not in active_service_ids
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
                logical_trip[
                    "is_weekend"
                ]
                != trip[
                    "is_weekend"
                ]
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

                "is_weekend":
                    trip[
                        "is_weekend"
                    ],

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
                    candidate[
                        "is_weekend"
                    ]
                    != trip[
                        "is_weekend"
                    ]
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
    logical_stop_times,
    trips_by_id
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

                destination = (
                    weekend
                    if logical_trip[
                        "is_weekend"
                    ]
                    else weekday
                )

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

                    original_trip_id = item.get("original_trip_id", "")
                    original_trip = trips_by_id.get(original_trip_id, {})

                    destination.append({

                        "trip_id":
                            logical_trip[
                                "id"
                            ],

                        "original_trip_id":
                            original_trip_id,

                        "trip_headsign":
                            original_trip.get(
                                "trip_headsign",
                                ""
                            ),

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
                    })

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

        calendar_dates = read_csv(
            "calendar_dates.txt"
        )

        today = get_today()

        print(
            f"Service reference date: {today}"
        )

        # --------------------------------------------------------
        # Active services
        # --------------------------------------------------------

        active_service_ids = (
            build_active_service_ids(
                calendar_dates,
                today
            )
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
        stops_by_id = {
            normalize(
                stop.get(
                    "stop_id"
                )
            ):
                stop
            for stop in output_stops
            if normalize(
                stop.get(
                    "stop_id"
                )
            )
        }

        print(
            "Stops after OSM merge: "
            f"{len(output_stops)}"
        )

        # --------------------------------------------------------
        # Trips
        # --------------------------------------------------------

        trips_by_id = build_trips(
            trips_data,
            active_service_ids
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
                logical_stop_times,
                trips_by_id
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
