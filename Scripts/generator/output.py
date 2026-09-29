"""Public normalized data writer and generation diagnostics."""

import json

from .config import (
    CORE_OUTPUT_FILES,
    DATA_DIR,
    OUTPUT_CHUNK_COUNT,
    OUTPUT_MANIFEST_FILE,
    SCHEDULES_OUTPUT_PREFIX,
    SHAPES_OUTPUT_PREFIX,
)

def build_public_calendar(calendar_result):
    """
    Keep only calendar data consumed by the frontend.

    The raw GTFS calendar/calendar_dates tables can be very large. They are
    needed while generating service-day assignments, but shipping all raw
    exception rows to the browser is unnecessary and was the main source of
    the old monolithic transport.json size.
    """
    return {
        "referenceDate": calendar_result.get("referenceDate"),
        "endDate": calendar_result.get("endDate"),
        "serviceIdsByDate": calendar_result.get("serviceIdsByDate", {}),
        "dateTypes": calendar_result.get("dateTypes", {}),
        "serviceDayTypes": calendar_result.get("serviceDayTypes", {}),
        "config": calendar_result.get("config", {"dateOverrides": {}, "directionOverrides": []}),
        "appliedDirectionOverrides": calendar_result.get("appliedDirectionOverrides", []),
    }

def _chunk_mapping(mapping, chunk_count=OUTPUT_CHUNK_COUNT):
    items = sorted(mapping.items(), key=lambda item: str(item[0]))
    chunks = [dict() for _ in range(chunk_count)]
    for index, (key, value) in enumerate(items):
        chunks[index % chunk_count][key] = value
    return chunks

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, separators=(",", ":"))


def write_public_data(
    result,
    *,
    data_dir=DATA_DIR,
    core_output_files=None,
    output_manifest_file=OUTPUT_MANIFEST_FILE,
):
    """
    Write the normalized, chunked browser data set.

    Path arguments are injectable so the compatibility wrapper can preserve the
    original module-level testing/API behavior without coupling the stages.
    """
    core_files = core_output_files or {
        key: data_dir / path.name
        for key, path in CORE_OUTPUT_FILES.items()
    }

    data_dir.mkdir(parents=True, exist_ok=True)

    generated_names = {
        "transport.json",
        "core.json",
        "manifest.json",
        "meta.json",
        "calendar.json",
        "routes.json",
        "stops.json",
        "trips.json",
        "directions.json",
        *[f"{SHAPES_OUTPUT_PREFIX}-{i}.json" for i in range(OUTPUT_CHUNK_COUNT)],
        *[f"{SCHEDULES_OUTPUT_PREFIX}-{i}.json" for i in range(OUTPUT_CHUNK_COUNT)],
    }

    for name in generated_names:
        path = data_dir / name
        if path.exists():
            path.unlink()

    public_calendar = build_public_calendar(result["calendar"])

    write_json(
        core_files["meta"],
        {
            "updatedAt": result["updatedAt"],
            "source": result["source"],
            "lineOverrides": result["lineOverrides"],
        },
    )
    write_json(core_files["calendar"], public_calendar)
    write_json(core_files["routes"], result["routes"])
    write_json(core_files["stops"], result["stops"])
    write_json(core_files["trips"], result["trips"])
    write_json(core_files["directions"], result["directions"])

    shape_chunks = _chunk_mapping(result["shapes"])
    schedule_chunks = _chunk_mapping(result["schedules"])

    shape_files = []
    schedule_files = []

    for index, chunk in enumerate(shape_chunks):
        filename = f"{SHAPES_OUTPUT_PREFIX}-{index}.json"
        write_json(data_dir / filename, chunk)
        shape_files.append(filename)

    for index, chunk in enumerate(schedule_chunks):
        filename = f"{SCHEDULES_OUTPUT_PREFIX}-{index}.json"
        write_json(data_dir / filename, chunk)
        schedule_files.append(filename)

    manifest = {
        "version": 2,
        "updatedAt": result["updatedAt"],
        "source": result["source"],
        "meta": core_files["meta"].name,
        "calendar": core_files["calendar"].name,
        "routes": core_files["routes"].name,
        "stops": core_files["stops"].name,
        "trips": core_files["trips"].name,
        "directions": core_files["directions"].name,
        "shapes": shape_files,
        "schedules": schedule_files,
        "legacy": None,
    }
    manifest_path = output_manifest_file
    write_json(manifest_path, manifest)

    return {
        "manifest": manifest_path,
        "core": list(core_files.values()),
        "shapes": shape_files,
        "schedules": schedule_files,
    }


def build_result(
    *,
    today,
    line_overrides,
    calendar_result,
    routes_data,
    output_stops,
    trips_data,
    directions_result,
    shapes_result,
    schedules_result,
):
    """Assemble the stable public result object consumed by the writer."""
    return {
        "updatedAt": today.isoformat(),
        "source": "CGM Sofia official GTFS",
        "lineOverrides": line_overrides,
        "calendar": calendar_result,
        "routes": [dict(row) for row in routes_data],
        "stops": output_stops,
        "trips": [dict(row) for row in trips_data],
        "directions": directions_result,
        "shapes": shapes_result,
        "schedules": schedules_result,
    }


def print_generation_summary(
    *,
    routes_data,
    output_stops,
    directions_result,
    schedules_result,
    shapes_result,
    written,
    output_manifest_file=OUTPUT_MANIFEST_FILE,
):
    print("")
    print("Public normalized data written:")
    print(f"  Core: {written['core']}")
    print(f"  Shapes: {len(written['shapes'])} chunks")
    print(f"  Schedules: {len(written['schedules'])} chunks")

    print("=== Generation summary ===")
    print(f"Routes: {len(routes_data)}")
    print(f"Stops: {len(output_stops)}")
    print(
        "Directions: "
        f"{sum(len(value) for value in directions_result.values())}"
    )
    print(f"Schedule routes: {len(schedules_result)}")
    print(f"Shapes: {len(shapes_result)}")

    print("")
    print(f"Manifest: {output_manifest_file}")


def print_direction_diagnostics(
    *,
    routes_data,
    directions_result,
    schedules_result,
    normalize_fn,
):
    print("")
    print("=== Direction diagnostics ===")

    for route in routes_data:
        route_id = normalize_fn(route.get("route_id"))
        short_name = normalize_fn(route.get("route_short_name"))
        route_directions = directions_result.get(route_id, {})

        if not route_directions:
            continue

        print(f"\n{short_name}:")

        for key, direction in route_directions.items():
            schedule = (
                schedules_result
                .get(route_id, {})
                .get(key, {})
            )
            print(
                "  "
                f"{key}: "
                f"{direction['headsign']} | "
                f"stops={len(direction['stops'])} | "
                f"weekday={len(schedule.get('weekday', []))} | "
                f"weekend={len(schedule.get('weekend', []))}"
            )

    print("")
