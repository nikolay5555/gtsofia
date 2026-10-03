# Transport data model

The generated transport data is split into small, single-purpose JSON files.

## Canonical data

- `routes.json` — normalized route model (`cgm_id`, `route_ref`, `type`, plus metro colors when supplied by GTFS).
- `stops.json` — normalized stop model (`code`, `coords`, `names.bg`, `names.en`). Coordinates are rounded to 5 decimal places and English names use Bulgarian transliteration when GTFS does not provide one.
- `trips.json` — compact logical trips (`id`, `cgm_id`, `direction`, `is_weekend`).
- `directions.json` — unique ordered stop patterns.
- `stop_times.json` — timetable rows linked to logical trips (`trip`, numeric-minute `times`, `stop_sequences`, `original_trip_id`, `service_id`). No vehicle/car field is included.
- `active_service_ids.json` — compact service-id weekday/weekend classification.
- `shapes.json` — only shapes referenced by surviving directions.
- `realtime-trips.json` — minimal source-trip mapping required to match GTFS-Realtime with the compact model.
- `calendar.json` — exact GTFS calendar evaluation and exceptions for the generated window.
- `line-overrides.json` — presentation overrides.
- `metadata.json` — model version, source, retrieval date and SHA-256 hashes.
- `manifest.json` — generated file list and model version.

## Normalization

The normalized model follows the route-reference/type, stop-code, coordinate and English-name transformations used by Dimitar5555/sofiatraffic-schedules, while retaining the existing project's GTFS-calendar handling and Sofia timezone semantics.

The schedule model intentionally does not carry vehicle/car information.

## Frontend compatibility

The browser loads the split files through `transport-data.js`.

`transport-data.js` builds an in-memory compatibility object named `window.transportData`, so the existing pages continue to use the same rendering logic:

- `schedules.js` keeps the existing timetable UI.
- `virtual-boards.js` keeps the existing virtual-board UI.
- Route, direction and stop display fields are adapted from the normalized model.

The monolithic `data/transport.json` is only a temporary fallback for the transition. The generator no longer creates it and the data workflow removes the stale file after a successful generation.
