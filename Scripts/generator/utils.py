"""Pure normalization and parsing helpers used across generator stages."""

from datetime import datetime
from zoneinfo import ZoneInfo

from .config import SOFIA_TIME_ZONE_NAME

SOFIA_TIME_ZONE = ZoneInfo(SOFIA_TIME_ZONE_NAME)

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
    # GTFS service dates are evaluated in the agency's local time. Sofia's
    # official feed is published for Europe/Sofia, so never use UTC here:
    # around midnight UTC that could select the wrong service date.
    return datetime.now(
        SOFIA_TIME_ZONE
    ).date()

def gtfs_date_string(current):
    return current.strftime("%Y%m%d")

def iso_date_string(current):
    return current.isoformat()

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
