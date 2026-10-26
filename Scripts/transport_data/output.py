"""Write generated transport datasets as separate, browser-loadable JSON files."""

import hashlib
import json

from .common import DATA_DIR

DATASET_KEYS = (
    "calendar",
    "routes",
    "stops",
    "trips",
    "directions",
    "shapes",
    "schedules",
)


def _serialize(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _write_bytes(path, content):
    temporary_path = path.with_suffix(".json.tmp")
    with temporary_path.open("wb") as file:
        file.write(content)
    temporary_path.replace(path)


def write_output_files(result):
    """Write the large transport payload in independently cacheable files."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    datasets = {key: result[key] for key in DATASET_KEYS}
    hashes = {}

    # Write payload files first; the metadata manifest records their SHA-256
    # hashes, as in the companion Sofia transport-schedules project.
    for name, value in datasets.items():
        content = _serialize(value)
        _write_bytes(DATA_DIR / f"{name}.json", content)
        hashes[name] = hashlib.sha256(content).hexdigest()

    metadata = {
        "updatedAt": result["updatedAt"],
        "source": result["source"],
        "lineOverrides": result["lineOverrides"],
        "hashes": hashes,
    }
    _write_bytes(DATA_DIR / "metadata.json", _serialize(metadata))

    return [DATA_DIR / "metadata.json"] + [
        DATA_DIR / f"{name}.json" for name in DATASET_KEYS
    ]
