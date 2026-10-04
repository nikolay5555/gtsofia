from __future__ import annotations

from transport_common import classify_route, normalize


def build_override_index(line_overrides):
    return {normalize(item.get("cgm_id")): item for item in line_overrides if normalize(item.get("cgm_id"))}


def build_routes(routes_data, line_overrides, active_route_ids):
    overrides = build_override_index(line_overrides)
    result = []
    for row in routes_data:
        cgm_id = normalize(row.get("route_id"))
        if not cgm_id or cgm_id not in active_route_ids:
            continue
        override = overrides.get(cgm_id, {})
        route_type, subtype, route_ref = classify_route(row, override)
        if not route_ref:
            continue

        bg_color = normalize(override.get("color"))
        if bg_color and not bg_color.startswith("#"):
            bg_color = f"#{bg_color}"
        if not bg_color and not override.get("type"):
            raw_color = normalize(row.get("route_color"))
            if raw_color:
                bg_color = f"#{raw_color.lstrip('#')}"
        if not bg_color:
            bg_color = {
                "metro": "#1C75BC", "tram": "#F7941D",
                "trolley": "#27AAE1", "bus": "#BE1E2D",
            }.get(route_type, "#BE1E2D")

        text_color = normalize(row.get("route_text_color"))
        if override.get("text_color"):
            text_color = normalize(override.get("text_color"))
        if text_color and not text_color.startswith("#"):
            text_color = f"#{text_color}"
        if not text_color:
            text_color = "#FFFFFF"

        item = {
            "cgm_id": cgm_id,
            "route_ref": route_ref,
            "type": route_type,
        }
        if subtype:
            item["subtype"] = subtype
        if text_color:
            item["text_color"] = text_color
        if bg_color:
            item["bg_color"] = bg_color
        result.append(item)
    return result
