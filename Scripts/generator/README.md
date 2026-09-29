# Modular GTFS generator

The generator is split by responsibility, following the same stage-oriented idea
used by `Dimitar5555/sofiatraffic-schedules`.

- `config.py` — shared paths, constants and line override loading.
- `utils.py` — pure normalization, parsing, date/time and transliteration helpers.
- `gtfs.py` — GTFS download and CSV loading.
- `calendar.py` — `calendar.txt`, `calendar_dates.txt` and operational date/direction overrides.
- `stops.py` — GTFS stop normalization plus optional OSM name enrichment.
- `trips.py` — active trip and stop-time preparation.
- `directions/` — direction detection, partial/logical merges, and public direction metadata.
- `schedules.py` — weekday/weekend schedule materialization.
- `shapes.py` — selected shape loading.
- `output.py` — stable public result assembly and split-file output.
- `pipeline.py` — orchestration only.

`Scripts/generate_transport_data.py` remains the command-line entry point and
re-exports the historical helper names for compatibility with the existing
tests and tooling.
