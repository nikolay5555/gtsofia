#!/usr/bin/env python3

from lib.calendar import build_active_service_ids, build_calendar_context
from lib.common import DATA_DIR, get_today, load_calendar_config, load_line_overrides, write_json
from lib.gtfs import read_csv


def main():
    calendar = read_csv("calendar.txt") if (DATA_DIR.parent / ".gtfs" / "calendar.txt").exists() else []
    calendar_dates = read_csv("calendar_dates.txt") if (DATA_DIR.parent / ".gtfs" / "calendar_dates.txt").exists() else []

    today = get_today()
    calendar_config = load_calendar_config()
    _, calendar_result = build_calendar_context(
        calendar,
        calendar_dates,
        today,
        calendar_config=calendar_config,
    )

    write_json(DATA_DIR / "calendar.json", calendar_result)
    write_json(
        DATA_DIR / "active_service_ids.json",
        build_active_service_ids(calendar_result),
    )

    # Copy the presentation config into the generated data set so the
    # browser does not need to load configuration files independently.
    write_json(
        DATA_DIR / "line-overrides.json",
        load_line_overrides(),
    )

    print(
        f"Calendar window: {calendar_result['referenceDate']} -> "
        f"{calendar_result['endDate']}"
    )


if __name__ == "__main__":
    main()
