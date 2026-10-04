from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path

from transport_common import normalize


def load_shapes(gtfs_dir: Path, selected_shape_ids: set[str]):
    path = gtfs_dir / "shapes.txt"
    if not path.exists() or not selected_shape_ids:
        return {}
    groups = defaultdict(list)
    with path.open("r", encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            shape_id = normalize(row.get("shape_id"))
            if shape_id not in selected_shape_ids:
                continue
            try:
                sequence = int(row.get("shape_pt_sequence", 0))
                lat = float(row.get("shape_pt_lat"))
                lon = float(row.get("shape_pt_lon"))
            except (TypeError, ValueError):
                continue
            groups[shape_id].append((sequence, {"lat": lat, "lon": lon}))
    return {shape_id: [point for _, point in sorted(points, key=lambda item: item[0])] for shape_id, points in groups.items()}
