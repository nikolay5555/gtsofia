#!/usr/bin/env python3

import shutil

from lib.common import GTFS_DIR


def main():
    if GTFS_DIR.exists():
        shutil.rmtree(GTFS_DIR)
    print("Temporary GTFS files removed.")


if __name__ == "__main__":
    main()
