from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any

OSM_OVERPASS_URL = "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
OSM_NETWORK_NAME = "Градски транспорт София"
OSM_STOP_TYPES = (
    ("subway", "station"),
    ("tram", "stop_position"),
    ("bus", "platform"),
    ("trolleybus", "platform"),
)
OSM_ORDER = {
    "stop_position": 1,
    "platform": 2,
}


def _round_coord(value: Any) -> float:
    return float(f"{float(value):.5f}")


def _transliterate(text: str) -> str:
    cyrillic = "А,Б,В,Г,Д,Е,Ж,З,И,Й,К,Л,М,Н,О,П,Р,С,Т,У,Ф,Х,Ц,Ч,Ш,Щ,Ъ,Ь,Ю,Я".split(",")
    latin = "A,B,V,G,D,E,ZH,Z,I,Y,K,L,M,N,O,P,R,S,T,U,F,H,TS,CH,SH,SHT,A,A,YU,YA".split(",")
    if len(cyrillic) != len(latin):
        raise RuntimeError("Cyrillic/Latin transliteration tables are inconsistent")

    output = []
    for char in str(text):
        is_lower = char == char.lower()
        try:
            index = cyrillic.index(char.upper())
        except ValueError:
            output.append(char)
            continue
        mapped = latin[index]
        output.append(mapped.lower() if is_lower else mapped)
    return "".join(output)


def _query() -> str:
    elements = "".join(
        f'node[{transport}=yes][public_transport={public_transport}][ref][network="{OSM_NETWORK_NAME}"];'
        for transport, public_transport in OSM_STOP_TYPES
    )
    return f"[out:json][timeout:25];({elements});out geom;"


def fetch_osm_stops(timeout: int = 120) -> list[dict]:
    request = urllib.request.Request(
        OSM_OVERPASS_URL,
        data=f"data={urllib.parse.quote(_query())}".encode("utf-8"),
        method="POST",
        headers={"User-Agent": "github/nikolay5555/gtsofia"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))

    elements = payload.get("elements") or []
    result = []
    for element in sorted(
        elements,
        key=lambda item: OSM_ORDER.get((item.get("tags") or {}).get("public_transport"), 999),
    ):
        tags = element.get("tags") or {}
        ref = str(tags.get("ref") or "").strip()
        if not ref:
            continue

        lat = element.get("lat")
        lon = element.get("lon")
        if lat is None or lon is None:
            center = element.get("center") or {}
            lat = center.get("lat")
            lon = center.get("lon")
        if lat is None or lon is None:
            continue

        code = f"M{ref}" if tags.get("subway") == "yes" else ref.zfill(4)
        bg_name = str(tags.get("name") or "").strip()
        en_name = str(tags.get("name:en") or "").strip() or _transliterate(bg_name)

        names = {"bg": bg_name, "en": en_name}
        for source_key, target_key in (
            ("short_name:bg", "bg_short"),
            ("short_name:en", "en_short"),
            ("full_name:bg", "bg_full"),
            ("full_name:en", "en_full"),
        ):
            value = str(tags.get(source_key) or "").strip()
            if value:
                names[target_key] = value

        item = {
            "code": code,
            "coords": [_round_coord(lat), _round_coord(lon)],
            "names": names,
        }
        if tags.get("request_stop") == "yes":
            item["request_stop"] = True
        if tags.get("local_ref"):
            item["local_ref"] = str(tags["local_ref"]).strip()
        if tags.get("local_ref:metro"):
            item["metro_ref"] = str(tags["local_ref:metro"]).strip()
        result.append(item)

    return result
