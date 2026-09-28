# Data structure

The transport data pipeline is intentionally split into three conceptual layers:

1. **Raw GTFS** — downloaded temporarily by `Scripts/generate_transport_data.py` into `.gtfs/` during generation. It is never served to the browser and is removed after generation.
2. **Normalized public data** — generated under `data/`. Duplicate stop IDs are resolved to one canonical stop record, service-calendar details are reduced to the fields used by the application, and large collections are split into manageable files.
3. **Frontend model** — `transport-data.js` loads the manifest and reconstructs the same `window.transportData` shape used by the existing pages, so the rest of the frontend does not need to know how the files are stored.

## Generated files

- `manifest.json` — version and file map.
- `meta.json` — update date, source and line overrides.
- `calendar.json` — compact calendar information used by the UI.
- `routes.json` — GTFS routes.
- `stops.json` — one canonical record per normalized `stop_id`.
- `trips.json` — active GTFS trips.
- `directions.json` — normalized route directions and stop patterns.
- `shapes-0.json` ... `shapes-3.json` — route geometry chunks.
- `schedules-0.json` ... `schedules-3.json` — schedule chunks.

The old generated `data/transport.json` is deliberately no longer produced.

## Stop normalization

A GTFS feed can contain multiple records with the same `stop_id`, for example a physical boarding stop and a station/parent record. The generator chooses a canonical record using public-facing name/code information and `location_type=0` as a tie-breaker.

This prevents a later empty station record from replacing a real stop. For example, `0024` resolves to **28-МИ ДКЦ**.

## Compatibility

The browser still receives one logical `transportData` object. `transport-data.js` combines the split files after loading them. This keeps existing consumers such as the schedules and virtual-board pages unchanged.
