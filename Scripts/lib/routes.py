import re

from .common import normalize


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

    # Replacement services remain buses in the primary transport class.
    if route_ref.endswith(("ТБ", "ТМ")) or (
        route_ref.startswith(("М", "M")) and model_type == "bus"
    ):
        model_type = "bus"

    digits = re.sub(r"[A-ZА-Я]", "", route_ref)
    try:
        sort_ref = int(digits)
    except ValueError:
        sort_ref = 0

    # Trolleybus route numbers >= 50 are operated as bus-like services
    # in Dimitar's model.
    if sort_ref >= 50 and model_type == "trolley":
        model_type = "bus"

    return model_type


def determine_model_route_subtype(route_ref, route_type):
    route_ref = normalize(route_ref).upper()
    route_type = normalize(route_type).lower()

    if route_ref.startswith("N"):
        return "night"

    if route_ref.startswith(("У", "Y")):
        return "school"

    if route_type == "bus" and (
        route_ref.endswith(("ТБ", "ТМ"))
        or route_ref.startswith(("М", "M"))
    ):
        return "temporary"

    return None


def build_model_routes(
    routes_data,
    active_route_ids,
    line_overrides=None,
):
    result = []
    overrides = {
        normalize(item.get("cgm_id")): item
        for item in (line_overrides or [])
        if normalize(item.get("cgm_id"))
    }

    for route in routes_data:
        route_id = normalize(route.get("route_id"))
        if route_id not in active_route_ids:
            continue

        route_ref = determine_model_route_ref(
            route.get("route_short_name", "")
        )
        route_type = determine_model_route_type(
            route_ref,
            route.get("route_type", ""),
        )

        override = overrides.get(route_id)
        if override:
            if normalize(override.get("route_ref")):
                route_ref = normalize(override["route_ref"]).upper()
            if normalize(override.get("type")):
                route_type = normalize(override["type"]).lower()

        model_route = {
            "cgm_id": route_id,
            "route_ref": route_ref,
            "type": route_type,
        }

        subtype = determine_model_route_subtype(
            route_ref,
            route_type,
        )
        if subtype:
            model_route["subtype"] = subtype

        if route_type == "metro":
            text_color = normalize(route.get("route_text_color"))
            bg_color = normalize(route.get("route_color"))
            if text_color:
                model_route["text_color"] = text_color
            if bg_color:
                model_route["bg_color"] = bg_color

        result.append(model_route)

    return result
