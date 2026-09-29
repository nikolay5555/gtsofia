#!/usr/bin/env python3
"""CLI entry point for the modular Sofia GTFS generator.

The stage modules under Scripts/generator/ contain the actual implementation.
This file deliberately keeps the historical function names available so tests
and external tooling that imported the old generator continue to work.
"""

from pathlib import Path
import sys

# When this file is executed directly (python Scripts/generate_transport_data.py),
# make the Scripts directory importable. Package imports remain normal when the
# project is imported as a package.
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from generator.config import (  # noqa: E402,F401
    CALENDAR_CONFIG_FILE,
    CORE_OUTPUT_FILES,
    DATA_DIR,
    GTFS_DIR,
    GTFS_URL,
    LINE_OVERRIDES_CONFIG_FILE,
    OSM_NETWORK_NAME,
    OSM_STOPS_TYPES,
    OUTPUT_CHUNK_COUNT,
    OUTPUT_MANIFEST_FILE,
    ROOT,
    SCHEDULES_OUTPUT_PREFIX,
    SHAPES_OUTPUT_PREFIX,
    GTFS_WEEKDAY_FIELDS,
    SOFIA_TIME_ZONE_NAME,
)
from generator.utils import SOFIA_TIME_ZONE  # noqa: E402,F401
from generator.calendar import (  # noqa: E402,F401
    _apply_calendar_date_exceptions,
    _calendar_row_covers_date,
    _date_inclusive_range,
    apply_direction_overrides,
    build_calendar_context,
    load_calendar_config,
)
from generator.directions import (  # noqa: E402,F401
    build_output_directions,
    build_reference_directions,
    choose_direction_name,
    choose_shape_id,
    extract_car_number,
    merge_logical_trips,
    merge_partial_directions,
)
from generator.gtfs import download_gtfs, read_csv  # noqa: E402,F401
from generator.output import (  # noqa: E402,F401
    _chunk_mapping,
    build_public_calendar,
    write_json,
)
from generator.shapes import load_shapes  # noqa: E402,F401
from generator.stops import (  # noqa: E402,F401
    build_stop_index,
    build_stops,
    fetch_osm_stops,
    merge_osm_stop_names,
    stop_preference_score,
)
from generator.trips import build_stop_times, build_trips  # noqa: E402,F401
from generator.utils import (  # noqa: E402,F401
    get_today,
    gtfs_date_string,
    iso_date_string,
    normalize,
    normalize_stop_id,
    parse_date,
    parse_time,
    round_coordinate,
    transliterate,
)
from generator.config import load_line_overrides  # noqa: E402,F401
from generator.schedules import build_schedules  # noqa: E402,F401
from generator import output as _output  # noqa: E402


def write_public_data(result):
    """Compatibility wrapper around the split output writer."""
    return _output.write_public_data(
        result,
        data_dir=DATA_DIR,
        core_output_files=CORE_OUTPUT_FILES,
        output_manifest_file=OUTPUT_MANIFEST_FILE,
    )


def main():
    """CLI entry point."""
    from generator.pipeline import generate
    return generate()


if __name__ == "__main__":
    main()
