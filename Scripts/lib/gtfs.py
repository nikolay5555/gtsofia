from pathlib import Path
import io
import shutil
import urllib.request
import zipfile

from .common import GTFS_DIR, GTFS_URL


def download_gtfs():
    print(f"Downloading official GTFS: {GTFS_URL}")
    request = urllib.request.Request(
        GTFS_URL,
        headers={"User-Agent": "GTSofia/1.0"},
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        payload = response.read()

    if not payload.startswith(b"PK"):
        raise RuntimeError("GTFS endpoint did not return a ZIP archive.")

    print(f"Downloaded GTFS archive: {len(payload) / 1024 / 1024:.2f} MB")

    if GTFS_DIR.exists():
        shutil.rmtree(GTFS_DIR)

    GTFS_DIR.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = {Path(name).name for name in archive.namelist()}
        required = {"routes.txt", "stops.txt", "trips.txt", "stop_times.txt"}
        missing = required - names
        if missing:
            raise RuntimeError(
                "GTFS archive is missing required files: "
                + ", ".join(sorted(missing))
            )

        if "calendar.txt" not in names and "calendar_dates.txt" not in names:
            raise RuntimeError(
                "GTFS archive must contain calendar.txt or calendar_dates.txt."
            )

        archive.extractall(GTFS_DIR)

    print(f"GTFS extracted to: {GTFS_DIR}")


def read_csv(filename):
    path = GTFS_DIR / filename
    if not path.exists():
        raise FileNotFoundError(f"Missing GTFS file: {path}")
    with path.open("r", encoding="utf-8-sig", newline="") as file:
        import csv
        return list(csv.DictReader(file))
