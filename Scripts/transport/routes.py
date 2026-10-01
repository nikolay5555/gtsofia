"""Route normalization."""

from transport.utils import normalize, normalize_route_ref, route_type_from_gtfs


def normalize_route_record(route, line_overrides=None):
    """Create Dimitar-compatible route metadata while retaining raw GTFS."""

    route_id = normalize(route.get("route_id"))
    route_ref = normalize_route_ref(route.get("route_short_name"))
    route_type = route_type_from_gtfs(route.get("route_type"))

    override = None
    for item in line_overrides or []:
        if normalize(item.get("cgm_id")) == route_id:
            override = item
            break

    if override and normalize(override.get("route_ref")):
        route_ref = normalize_route_ref(override.get("route_ref"))

    override_type = normalize(override.get("type")) if override else ""
    if override_type in {"bus", "tram", "trolley", "metro"}:
        route_type = override_type

    if (
        route_ref.endswith(("ТБ", "ТМ"))
        or (route_ref.startswith("М") and route_type == "bus")
    ):
        route_type = "bus"

    try:
        sort_ref = int("".join(ch for ch in route_ref if ch.isdigit()))
    except ValueError:
        sort_ref = None

    if sort_ref is not None and sort_ref >= 50 and route_type == "trolley":
        route_type = "bus"

    subtype = None
    if route_ref.endswith(("ТБ", "ТМ")):
        subtype = "temporary"
    elif route_ref.startswith("N"):
        subtype = "night"
    elif route_ref.startswith("У"):
        subtype = "school"

    return {
        "cgm_id": route_id,
        "route_ref": route_ref,
        "type": route_type,
        **({"subtype": subtype} if subtype else {}),
        **({
            "text_color": normalize(route.get("route_text_color")),
            "bg_color": normalize(route.get("route_color")),
        } if route_type == "metro" else {}),
    }
