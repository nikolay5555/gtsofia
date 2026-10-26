import json
from collections import Counter, defaultdict
from datetime import date, timedelta

from .common import (
    CALENDAR_CONFIG_FILE, GTFS_WEEKDAY_FIELDS, gtfs_date_string, iso_date_string,
    normalize, parse_date,
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


def _compress_service_ids_by_weekday(service_ids_by_date):
    """Represent mostly recurring daily service sets as weekday bases + deltas.

    GTFS feeds that encode each service date in calendar_dates.txt can contain
    hundreds of thousands of repeated service IDs. A weekday baseline plus
    exact per-date additions/removals keeps the representation lossless while
    avoiding the repeated ID list for every date.
    """
    weekday_names = (
        "monday", "tuesday", "wednesday", "thursday",
        "friday", "saturday", "sunday",
    )
    sets_by_weekday = defaultdict(Counter)

    for date_key, service_ids in service_ids_by_date.items():
        weekday = date.fromisoformat(date_key).weekday()
        sets_by_weekday[weekday][frozenset(service_ids)] += 1

    base_by_weekday = {}
    for weekday in range(7):
        patterns = sets_by_weekday.get(weekday)
        base_by_weekday[weekday] = (
            patterns.most_common(1)[0][0]
            if patterns
            else frozenset()
        )

    service_ids_by_weekday = {
        weekday_names[weekday]: sorted(base_by_weekday[weekday])
        for weekday in range(7)
    }
    overrides_by_date = {}

    for date_key, service_ids in service_ids_by_date.items():
        actual = set(service_ids)
        baseline = base_by_weekday[date.fromisoformat(date_key).weekday()]
        additions = sorted(actual - baseline)
        removals = sorted(baseline - actual)
        if additions or removals:
            overrides_by_date[date_key] = {
                "add": additions,
                "remove": removals,
            }

    return service_ids_by_weekday, overrides_by_date


def build_calendar_context(
    calendar,
    calendar_dates,
    today,
    horizon_days=15,
    calendar_config=None
):
    """Build an application calendar without shipping raw GTFS exception rows.

    GTFS feeds that omit calendar.txt may encode every operating date as a
    calendar_dates.txt exception. Resolve active services for the feed coverage,
    then compact the membership index into weekday baseline sets plus exact
    per-date additions/removals. The web app can reconstruct membership without
    sending hundreds of thousands of repeated exception objects or daily arrays.
    """

    window_end = today + timedelta(days=horizon_days)
    has_calendar = bool(calendar)
    calendar_config = calendar_config or {"dateOverrides": {}}
    date_overrides = calendar_config.get("dateOverrides", {})

    calendar_by_service = {}
    coverage_candidates = [window_end]
    for row in calendar:
        service_id = normalize(row.get("service_id"))
        if service_id:
            calendar_by_service[service_id] = dict(row)
        row_end = parse_date(row.get("end_date"))
        if row_end and row_end > today:
            coverage_candidates.append(row_end)

    calendar_dates_by_date = defaultdict(list)
    for row in calendar_dates:
        service_id = normalize(row.get("service_id"))
        date_value = parse_date(row.get("date"))
        exception_type = normalize(row.get("exception_type"))

        if not service_id or date_value is None:
            continue
        if exception_type not in {"1", "2"}:
            continue

        calendar_dates_by_date[gtfs_date_string(date_value)].append(dict(row))
        if date_value > today:
            coverage_candidates.append(date_value)

    coverage_end = max(coverage_candidates)
    date_types = {}
    service_ids_by_date = {}
    service_day_types = defaultdict(set)

    current = today
    while current <= coverage_end:
        base_service_ids = {
            service_id
            for service_id, row in calendar_by_service.items()
            if _calendar_row_covers_date(row, current)
        }
        effective_service_ids = _apply_calendar_date_exceptions(
            base_service_ids,
            calendar_dates_by_date,
            current,
        )

        date_key = iso_date_string(current)
        day_type = date_overrides.get(
            date_key,
            "weekend" if current.weekday() >= 5 else "weekday",
        )
        date_types[date_key] = day_type
        service_ids_by_date[date_key] = sorted(effective_service_ids)

        # Only services active within the short operational window determine
        # the weekday/weekend schedule buckets and the trips emitted below.
        if current <= window_end:
            for service_id in effective_service_ids:
                service_day_types[service_id].add(day_type)

        current += timedelta(days=1)

    result = {
        service_id: sorted(
            day_types,
            key=lambda value: 0 if value == "weekday" else 1,
        )
        for service_id, day_types in service_day_types.items()
    }

    service_ids_by_weekday, service_id_overrides_by_date = (
        _compress_service_ids_by_weekday(service_ids_by_date)
    )

    calendar_result = {
        "referenceDate": today.isoformat(),
        "endDate": coverage_end.isoformat(),
        "servicePatterns": [dict(row) for row in calendar],
        # No raw exception rows or repeated daily lists are sent to the browser.
        # Baseline weekday sets + exact date deltas reconstruct the same result.
        "serviceIdsByWeekday": service_ids_by_weekday,
        "serviceIdOverridesByDate": service_id_overrides_by_date,
        "dateTypes": date_types,
        "serviceDayTypes": result,
        "config": calendar_config,
    }

    print(f"Service date window: {today} -> {window_end}")
    print(f"Calendar coverage: {today} -> {coverage_end}")
    print(f"Calendar services: {len(calendar_by_service)}")
    print(f"GTFS calendar exception records indexed: {len(calendar_dates)}")
    print(f"Weekday service IDs: {sum('weekday' in types for types in result.values())}")
    print(f"Weekend/holiday service IDs: {sum('weekend' in types for types in result.values())}")

    return result, calendar_result
