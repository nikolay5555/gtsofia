#!/usr/bin/env python3
"""Compatibility entry point for the modular transport-data generator.

Implementation stages live in ``Scripts/transport_data``. The commonly used
helpers are re-exported here so existing tests and imports keep working.
"""

from pathlib import Path
import sys

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from transport_data.calendar import build_calendar_context, load_calendar_config  # noqa: E402
from transport_data.common import (  # noqa: E402
    DATA_DIR,
    GTFS_DIR,
    GTFS_URL,
    get_today,
    gtfs_date_string,
    iso_date_string,
    load_line_overrides,
    normalize,
    normalize_stop_id,
    parse_date,
    parse_time,
)
from transport_data.direction_output import (  # noqa: E402
    build_output_directions, choose_direction_name, choose_shape_id,
)
from transport_data.directions_core import (  # noqa: E402
    build_reference_directions, extract_car_number,
)
from transport_data.direction_merges import (  # noqa: E402
    merge_logical_trips, merge_partial_directions,
)
from transport_data.gtfs import download_gtfs, read_csv  # noqa: E402
from transport_data.pipeline import main  # noqa: E402
from transport_data.schedules import build_schedules  # noqa: E402
from transport_data.shapes import load_shapes  # noqa: E402 - legacy helper export; pipeline does not publish shape geometry
from transport_data.stops import (  # noqa: E402
    build_stop_index, build_stops, filter_stops_for_directions, stop_preference_score,
)
from transport_data.trips import build_stop_times, build_trips  # noqa: E402


if __name__ == "__main__":
    main()
