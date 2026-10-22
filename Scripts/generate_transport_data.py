#!/usr/bin/env python3
"""Compatibility entry point for the modular GTSofia GTFS generator."""

import sys
from pathlib import Path

# Keep both direct execution and importlib-based tests working.
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# Re-export the existing helper functions for tests and small ad-hoc tools.
from transport_generator.calendar import build_calendar_context, load_calendar_config  # noqa: E402
from transport_generator.common import (  # noqa: E402
    get_today,
    gtfs_date_string,
    iso_date_string,
    load_line_overrides,
    normalize,
    normalize_stop_id,
    parse_date,
    parse_time,
)
from transport_generator.direction_inference import (  # noqa: E402
    build_reference_directions,
    extract_car_number,
)
from transport_generator.direction_merging import (  # noqa: E402
    merge_logical_trips,
    merge_partial_directions,
)
from transport_generator.direction_output import (  # noqa: E402
    build_output_directions,
    choose_direction_name,
    choose_shape_id,
)
from transport_generator.pipeline import main  # noqa: E402
from transport_generator.schedules import build_schedules  # noqa: E402
from transport_generator.shapes import load_shapes  # noqa: E402
from transport_generator.stops import build_stop_index, build_stops  # noqa: E402
from transport_generator.trips import build_stop_times, build_trips  # noqa: E402


if __name__ == "__main__":
    main()
