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
    """Return the public route ref used by the application.

    Mirrors Dimitar's normalization rules while preserving X-prefixed tourist
    routes and normal service lettering. Metro refs are the one deliberate
    application-specific exception: M1..M4 are exposed as 1..4.
    """
    ref = normalize(value)
    if not ref:
        return ""
    ref = re.sub(r"\s+", "", ref).upper()
    ref = ref.replace("Y", "У", 1) if ref.startswith("Y") else ref

    metro = re.fullmatch(r"[MМ](\d+)", ref)
    if metro:
        return metro.group(1)

    if re.fullmatch(r"E\d+", ref):
        return ref[1:]

    school = re.fullmatch(r"[УY](\d+)", ref)
    if school:
        return f"У{school.group(1)}"

    night = re.fullmatch(r"N\d+", ref)
    if night:
        return night.group(0)

    temporary = re.fullmatch(r"(\d+)(?:T|TM|Т|ТМ|TB|ТВ)", ref)
    if temporary:
        return f"{temporary.group(1)}ТМ"

    return ref


def classify_route(route_row: dict, override: dict | None = None) -> tuple[str, str | None, str]:
    """Return (main type, subtype, canonical route_ref)."""
    override = override or {}
    source_ref = override.get("route_ref") or route_row.get("route_short_name")
    route_ref = canonical_route_ref(source_ref)

    route_type = normalize(override.get("type"))
    if route_type:
        type_map = {"trolleybus": "trolley", "subway": "metro"}
        route_type = type_map.get(route_type, route_type)
    else:
        route_type = {
            "0": "tram",
            "1": "metro",
            "3": "bus",
            "11": "trolley",
        }.get(normalize(route_row.get("route_type")), "other")

    upper_ref = route_ref.upper()
    subtype = None
    if route_type == "bus":
        if upper_ref.startswith("N"):
            subtype = "night"
        elif upper_ref.startswith("У"):
            subtype = "school"
        elif "Т" in upper_ref or "T" in upper_ref:
            subtype = "temporary"

    if subtype:
        route_type = "bus"

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
