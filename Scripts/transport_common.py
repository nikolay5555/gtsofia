from __future__ import annotations

import json
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

SOFIA_TIME_ZONE = ZoneInfo("Europe/Sofia")
GTFS_WEEKDAY_FIELDS = (
    "monday", "tuesday", "wednesday", "thursday",
    "friday", "saturday", "sunday",
)

# Keep abbreviations and institutional acronyms that occur frequently in the
# Sofia GTFS feed. The normalizer is deliberately conservative: words not in
# this list are title-cased, while structural abbreviations keep their usual
# transport-map spelling.
NAME_ABBREVIATIONS = {
    "БУЛ": "бул.", "УЛ": "ул.", "ПЛ": "пл.", "КВ": "кв.",
    "ЖК": "ж.к.", "БЛ": "бл.", "СВ": "св.", "ГЕН": "ген.",
    "АКАД": "акад.", "ПРОФ": "проф.", "Д-Р": "д-р",
    "ПОДПОР": "подпор.", "КН": "кн.",
}
NAME_ACRONYMS = {
    "АД", "ЕАД", "ООД", "ДКЦ", "НДК", "ОУ", "СОУ", "СУ", "ПГ", "ПГД",
    "НУ", "ТУ", "ВМА", "БНТ", "БАН", "МБАЛ", "УМБАЛ", "УАСГ",
    "ЧСОУ", "ПГТ", "ПГТМ", "ПГДС", "ПК", "ЦГ", "АПИ",
}
NAME_LOWER_WORDS = {
    "и", "в", "във", "с", "със", "за", "на", "по", "от", "до",
    "при", "към", "под", "над", "пред", "след",
}
NAME_STRUCTURAL_LOWER = {
    "МЕТРОСТАНЦИЯ", "ГАРА", "АВТОСТАНЦИЯ", "СЕЛО", "ГРАД",
}
NAME_EXPANSIONS = {
    "ПГД": ["ПГ", "по", "дизайн"],
}


def normalize(value) -> str:
    return str(value).strip() if value is not None else ""


def normalize_stop_id(value) -> str:
    value = normalize(value)
    if not value:
        return ""
    # Metro stop ids are intentionally kept as M-prefixed identifiers.
    if value.upper().startswith("M"):
        return "M" + value[1:]
    digits = "".join(char for char in value if char.isdigit())
    return digits.zfill(4) if digits else ""


def normalize_display_name(value) -> str:
    """Normalize public stop/destination names to Dimitar-style casing.

    The feed contains a mixture of all-caps and already-formatted values.
    Formatting is therefore idempotent for already-normalized text and only
    changes whitespace, common abbreviations, casing and obvious GTFS-style
    compound forms.
    """
    text = unicodedata.normalize("NFC", normalize(value))
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text)
    text = text.replace("–", "-").replace("—", "-")
    text = re.sub(r"(?i)Ж\.?\s*К\.?\.?", "ж.к.", text)
    text = re.sub(r"([А-Яа-яA-Za-z])-(?=\d)", r"\1 ", text)
    text = re.sub(r"\s+", " ", text).strip()

    def format_atom(atom: str, position: int) -> str:
        if not atom:
            return atom
        if atom.startswith("(") and atom.endswith(")"):
            return atom
        if atom.isdigit():
            return atom

        # Ordinals such as 28-МИ -> 28-ми.
        ordinal = re.fullmatch(r"(\d+)-([А-ЯA-Z]+)", atom, flags=re.IGNORECASE)
        if ordinal:
            return f"{ordinal.group(1)}-{ordinal.group(2).lower()}"

        upper = atom.upper().rstrip('.')
        if upper in NAME_ABBREVIATIONS:
            return NAME_ABBREVIATIONS[upper]
        if upper in NAME_ACRONYMS:
            return upper
        if upper in NAME_STRUCTURAL_LOWER:
            return upper.casefold()
        if atom.casefold() in NAME_LOWER_WORDS and position > 0:
            return atom.casefold()

        # Preserve mixed-case source values; normalize only all-caps tokens.
        if atom.isupper():
            return atom[:1] + atom[1:].lower()
        return atom

    tokens = text.split(" ")
    formatted: list[str] = []
    for index, token in enumerate(tokens):
        expansion = NAME_EXPANSIONS.get(token.upper().rstrip('.'))
        if expansion:
            formatted.extend(expansion)
            continue
        # Keep parenthesized route/platform annotations as-is except for
        # simple all-caps latin letters inside them.
        if token.startswith("(") and token.endswith(")"):
            formatted.append(token)
            continue
        if "/" in token:
            parts = token.split("/")
            formatted.append("/".join(format_atom(part, index) for part in parts))
            continue
        formatted.append(format_atom(token, index))

    result = " ".join(formatted)
    result = re.sub(r"\s*,\s*", ", ", result)
    result = re.sub(r"\s+", " ", result).strip()
    return result


def canonical_route_ref(value) -> str:
    """Return the public route ref using Dimitar's normalization rules.

    Application-specific exception: metro refs M1..M4 are exposed as 1..4,
    because the site deliberately does not display a leading M.
    """
    ref = normalize(value)
    if not ref:
        return ""
    ref = re.sub(r"\s+", "", ref).upper()
    number = re.sub(r"[A-ZА-Я]+", "", ref)

    if ref.startswith(("E", "Е")):
        return number
    if ref.startswith("N"):
        return f"N{number}"
    if ref.startswith(("Y", "У")):
        return f"У{number}"
    if ref.endswith(("ТБ", "TB")):
        return f"{number}ТБ"
    if ref.endswith(("ТМ", "TM", "Т", "T")):
        return f"{number}ТМ"

    metro = re.fullmatch(r"[MМ](\d+)", ref)
    if metro:
        return metro.group(1)
    return ref


def classify_route(route_row: dict, override: dict | None = None) -> tuple[str, str | None, str]:
    """Return (main type, subtype, canonical route_ref) in Dimitar's model."""
    override = override or {}
    source_ref = override.get("route_ref") or route_row.get("route_short_name")
    route_ref = canonical_route_ref(source_ref)

    route_type = normalize(override.get("type"))
    if route_type:
        type_map = {"trolleybus": "trolley", "subway": "metro"}
        route_type = type_map.get(route_type.lower(), route_type.lower())
    else:
        route_type = {
            "0": "tram",
            "1": "metro",
            "3": "bus",
            "11": "trolley",
        }.get(normalize(route_row.get("route_type")), "other")

    upper_ref = route_ref.upper()
    # Dimitar treats replacement and M-prefixed bus refs as bus routes.
    if upper_ref.endswith(("ТБ", "ТМ")) or (upper_ref.startswith("М") and route_type == "bus"):
        route_type = "bus"

    # Some temporary CGM trolley route ids are represented as trolley in GTFS
    # but belong in the bus section in the public timetable. Preserve the same
    # rule used by Dimitar for refs >= 50.
    digits = re.sub(r"[^0-9]", "", upper_ref)
    if digits and int(digits) >= 50 and route_type == "trolley":
        route_type = "bus"

    subtype = None
    if route_type == "bus":
        if upper_ref.endswith(("ТБ", "ТМ")):
            subtype = "temporary"
        elif upper_ref.startswith("N"):
            subtype = "night"
        elif upper_ref.startswith("У"):
            subtype = "school"

    return route_type, subtype, route_ref

def parse_date(value):
    value = normalize(value)
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y%m%d").date()
    except ValueError:
        return None


def parse_time(value):
    value = normalize(value)
    if not value:
        return None
    try:
        hours, minutes, seconds = map(int, value.split(":"))
        return hours * 3600 + minutes * 60 + seconds
    except (TypeError, ValueError):
        return None


def get_today():
    return datetime.now(SOFIA_TIME_ZONE).date()


def gtfs_date_string(current):
    return current.strftime("%Y%m%d")


def iso_date_string(current):
    return current.isoformat()


def load_json(path: Path, default):
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)
