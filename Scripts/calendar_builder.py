from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

from transport_common import GTFS_WEEKDAY_FIELDS, gtfs_date_string, iso_date_string, normalize, parse_date


def _calendar_row_covers_date(row, current):
    start_date = parse_date(row.get("start_date"))
    end_date = parse_date(row.get("end_date"))
    if start_date is None or end_date is None or current < start_date or current > end_date:
        return False
    field = GTFS_WEEKDAY_FIELDS[current.weekday()]
    return normalize(row.get(field)) == "1"


def _apply_calendar_date_exceptions(service_ids, calendar_dates_by_date, current):
    effective = set(service_ids)
    for row in calendar_dates_by_date.get(gtfs_date_string(current), []):
        service_id = normalize(row.get("service_id"))
        exception_type = normalize(row.get("exception_type"))
        if not service_id:
            continue
        if exception_type == "1":
            effective.add(service_id)
        elif exception_type == "2":
            effective.discard(service_id)
    return effective


def build_calendar_context(calendar, calendar_dates, today, horizon_days=15, calendar_config=None):
    end_date = today + timedelta(days=horizon_days)
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
        if not service_id or date_value is None or exception_type not in {"1", "2"}:
            continue
        calendar_dates_by_date[gtfs_date_string(date_value)].append(dict(row))

    date_types = {}
    service_ids_by_date = {}
    service_day_types = defaultdict(set)

    current = today
    while current <= end_date:
        base_service_ids = {
            service_id for service_id, row in calendar_by_service.items()
            if _calendar_row_covers_date(row, current)
        }
        effective_service_ids = _apply_calendar_date_exceptions(base_service_ids, calendar_dates_by_date, current)
        date_key = iso_date_string(current)
        day_type = date_overrides.get(date_key, "weekend" if current.weekday() >= 5 else "weekday")
        date_types[date_key] = day_type
        service_ids_by_date[date_key] = sorted(effective_service_ids)
        for service_id in effective_service_ids:
            service_day_types[service_id].add(day_type)
        current += timedelta(days=1)

    if not calendar:
        service_day_types.clear()
        for date_key, day_type in date_types.items():
            for service_id in service_ids_by_date[date_key]:
                service_day_types[service_id].add(day_type)

    result = {
        service_id: sorted(day_types, key=lambda value: 0 if value == "weekday" else 1)
        for service_id, day_types in service_day_types.items()
    }
    # Publish only the compact effective service calendar. The raw
    # calendar_dates table can be hundreds of thousands of rows and is not
    # needed by the browser because serviceIdsByDate is evaluated from the
    # same GTFS source during generation.
    calendar_result = {
        "referenceDate": today.isoformat(),
        "endDate": end_date.isoformat(),
        "serviceIdsByDate": service_ids_by_date,
        "dateTypes": date_types,
        "serviceDayTypes": result,
        "config": calendar_config,
    }
    return result, calendar_result
