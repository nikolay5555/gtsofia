"""Calendar interpretation and service-day normalization."""

import json
from collections import defaultdict
from datetime import timedelta

from transport.settings import CALENDAR_CONFIG_FILE, GTFS_WEEKDAY_FIELDS
from transport.utils import gtfs_date_string, iso_date_string, normalize, parse_date


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
    }


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
