"""Service calendar and operational date override stage."""

import json
from collections import defaultdict
from datetime import timedelta

from .config import CALENDAR_CONFIG_FILE, GTFS_WEEKDAY_FIELDS
from .utils import (
    gtfs_date_string,
    iso_date_string,
    normalize,
    parse_date,
)

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

    direction_overrides = raw.get("directionOverrides", [])
    if not isinstance(direction_overrides, list):
        raise ValueError("calendar.json directionOverrides must be an array.")

    normalized_direction_overrides = []
    for index, rule in enumerate(direction_overrides):
        if not isinstance(rule, dict):
            raise ValueError(
                f"calendar.json directionOverrides[{index}] must be an object."
            )

        start_date = parse_date(
            str(rule.get("startDate", "")).replace("-", "")
        )
        end_date = parse_date(
            str(rule.get("endDate", "")).replace("-", "")
        )

        if start_date is None or end_date is None or start_date > end_date:
            raise ValueError(
                f"Invalid direction override date range at index {index}."
            )

        route_id = normalize(rule.get("routeId"))
        if not route_id:
            raise ValueError(
                f"directionOverrides[{index}] requires routeId."
            )

        exclude_codes = rule.get("excludeCodes", [])
        include_codes = rule.get("includeCodes")

        if not isinstance(exclude_codes, list):
            raise ValueError(
                f"directionOverrides[{index}].excludeCodes must be an array."
            )

        if include_codes is not None and not isinstance(include_codes, list):
            raise ValueError(
                f"directionOverrides[{index}].includeCodes must be an array."
            )

        normalized_rule = {
            "startDate": iso_date_string(start_date),
            "endDate": iso_date_string(end_date),
            "routeId": route_id,
            "excludeCodes": sorted({normalize(code) for code in exclude_codes if normalize(code)}),
        }

        if include_codes is not None:
            normalized_rule["includeCodes"] = sorted({
                normalize(code) for code in include_codes if normalize(code)
            })

        if not normalized_rule["excludeCodes"] and "includeCodes" not in normalized_rule:
            raise ValueError(
                f"directionOverrides[{index}] requires excludeCodes or includeCodes."
            )

        normalized_direction_overrides.append(normalized_rule)

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
        "directionOverrides": normalized_direction_overrides,
    }

def _date_inclusive_range(current, start_date, end_date):
    return start_date <= current <= end_date

def apply_direction_overrides(
    directions_result,
    calendar_config,
    current_date
):
    """
    Apply date-specific operational direction changes after GTFS service
    filtering. This is intentionally generic: it can target any route and
    any direction codes, not just a single line.

    GTFS calendar/calendar_dates remains the primary source of truth. These
    rules are only needed when the feed keeps multiple operational patterns
    under the same service_id and therefore cannot express a temporary
    direction change through calendar exceptions alone.
    """

    config = calendar_config or {}
    rules = config.get("directionOverrides", [])

    if not rules:
        return directions_result, []

    result = {}
    applied = []

    for route_id, route_directions in directions_result.items():
        current_directions = dict(route_directions)

        for rule in rules:
            if normalize(rule.get("routeId")) != normalize(route_id):
                continue

            start_date = parse_date(
                str(rule.get("startDate", "")).replace("-", "")
            )
            end_date = parse_date(
                str(rule.get("endDate", "")).replace("-", "")
            )

            if (
                start_date is None
                or end_date is None
                or not _date_inclusive_range(current_date, start_date, end_date)
            ):
                continue

            exclude_codes = {
                normalize(code)
                for code in rule.get("excludeCodes", [])
                if normalize(code)
            }
            include_codes = rule.get("includeCodes")

            before = set(current_directions)

            if include_codes is not None:
                include_codes = {
                    normalize(code)
                    for code in include_codes
                    if normalize(code)
                }
                current_directions = {
                    key: direction
                    for key, direction in current_directions.items()
                    if normalize(direction.get("code")) in include_codes
                }

            if exclude_codes:
                current_directions = {
                    key: direction
                    for key, direction in current_directions.items()
                    if normalize(direction.get("code")) not in exclude_codes
                }

            removed = sorted(before - set(current_directions))
            if removed:
                applied.append({
                    "routeId": route_id,
                    "startDate": rule["startDate"],
                    "endDate": rule["endDate"],
                    "removedDirectionKeys": removed,
                    "excludedCodes": sorted(exclude_codes),
                })

        if current_directions:
            result[route_id] = current_directions

    return result, applied

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
