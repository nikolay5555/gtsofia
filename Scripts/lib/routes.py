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
    type_mapping = {"0": "tram", "1": "metro", "3": "bus", "11": "trolley"}
    model_type = type_mapping.get(normalize(route_type), "other")
    if route_ref.endswith(("ТБ", "ТМ")) or (
        route_ref.startswith("М") and model_type == "bus"
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

        route_ref = determine_model_route_ref(route.get("route_short_name", ""))
        route_type = determine_model_route_type(route_ref, route.get("route_type", ""))

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
