# Transport data model

The generated transport data is split into small, single-purpose JSON files.

## Canonical data

- routes.json — normalized routes. Each route has a primary type (metro, tram, trolley, bus) and may have a subtype (temporary, school, night).
- stops.json — normalized stop model (code, coords, names). OpenStreetMap is authoritative when a matching public stop exists; official CGM GTFS fills codes not represented in OSM.
- trips.json — compact logical trips (id, cgm_id, direction, is_weekend).
- directions.json — unique ordered stop patterns.
- stop_times.json — timetable rows linked to logical trips (trip, numeric-minute times, stop_sequences, original_trip_id, service_id). No vehicle/car field is included.
- active_service_ids.json — compact service-id weekday/weekend classification.
- shapes.json — only shapes referenced by surviving realtime trip mappings.
- realtime-trips.json — minimal source-trip mapping required to match GTFS-Realtime with the compact model.
- calendar.json — exact GTFS calendar evaluation and exceptions for the generated window.
- line-overrides.json — presentation/route overrides.
- metadata.json — model version, source, retrieval date and SHA-256 hashes.
- manifest.json — generated file list and model version.

## Route hierarchy

The route model follows the structure used by Dimitar5555/sofiatraffic-schedules:

- Primary transport class: metro, tram, trolley, bus.
- Secondary route class: temporary, school, night.

Examples:

```json
{
  "cgm_id": "N1",
  "route_ref": "N1",
  "type": "bus",
  "subtype": "night"
}
```

```json
{
  "cgm_id": "TB34",
  "route_ref": "20ТМ",
  "type": "bus",
  "subtype": "temporary"
}
```

This keeps the base vehicle/service type separate from the route's operating subtype.

## Stops and OpenStreetMap

Stop extraction follows the same OSM-first approach as Dimitar's pipeline:

- OSM network: Градски транспорт София.
- Included public transport stop types: subway stations, tram stop positions, bus platforms and trolleybus platforms.
- name and name:en are preferred; English falls back to Bulgarian transliteration.
- Optional OSM metadata such as short/full names, request-stop flag, local_ref and metro reference is retained.
- For matched codes, the OSM record wins; GTFS provides fallback stops that OSM does not contain.
- Metro stop identifiers remain M... exactly as in the current project model.

Coordinates are rounded to 5 decimal places.

## Frontend compatibility

The browser loads the split files through transport-data.js.

transport-data.js builds an in-memory compatibility object named window.transportData, so the existing pages continue to use the same rendering logic:

- schedules.js keeps the existing timetable UI while grouping routes by primary type and secondary subtype.
- virtual-boards.js keeps the existing virtual-board UI and realtime behavior.
- Route, direction and stop display fields are adapted from the canonical model.

The monolithic data/transport.json is only a temporary fallback for the transition. The generator no longer creates it and the data workflow removes the stale file after a successful generation.
