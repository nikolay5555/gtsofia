#!/usr/bin/env python3

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent

STAGES = (
    "00-prep.py",
    "01-download.py",
    "02-calendar.py",
    "03-routes.py",
    "04-stops.py",
    "05-schedules.py",
    "06-filter-stops.py",
    "07-shapes.py",
    "08-metadata.py",
    "09-cleanup.py",
)


def run_stage(filename):
    path = ROOT / "Scripts" / filename
    print()
    print("=" * 60)
    print(f"Running {filename}")
    print("=" * 60)

    subprocess.run(
        [sys.executable, str(path)],
        cwd=ROOT,
        check=True,
    )


def main():
    for filename in STAGES:
        run_stage(filename)

    print()
    print("=== Transport data generation complete ===")
    print("Generated data is split into small files under data/.")
    print("The legacy data/transport.json is no longer generated.")


if __name__ == "__main__":
    main()
