"""Download real street shapes for every road in the dataset (one-time step).

The CSVs give each road's distance and travel time but not the streets it
follows. This script asks the public OSRM routing service (OpenStreetMap
road data) for the driving path between the two ends of every connected
pair, and saves the shapes to ``data/road_geometry.json``. The search
visualization then draws roads along these streets instead of as straight
lines. The routing algorithms and their costs are NOT affected: Dijkstra
and A* still use the dataset's own distances and times.

Usage:
    python fetch_road_geometry.py            # resumes if interrupted
    python fetch_road_geometry.py --refresh  # download everything again

Only the public latitude/longitude of locations is sent to OSRM.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

from main import DEFAULT_DATA_DIR
from src.data_loader import DataError, load_dataset
from src.graph import build_graph

OSRM_URL = ("https://router.project-osrm.org/route/v1/driving/"
            "{lon1},{lat1};{lon2},{lat2}?overview=full&geometries=geojson")
OUTPUT_NAME = "road_geometry.json"
DELAY_S = 1.0  # the public demo server allows about one request per second


def fetch_route(a, b) -> dict:
    """Driving route from location ``a`` to ``b`` as {coords, km}."""
    url = OSRM_URL.format(lon1=a.longitude, lat1=a.latitude,
                          lon2=b.longitude, lat2=b.latitude)
    request = urllib.request.Request(
        url, headers={"User-Agent": "food-delivery-route-optimizer/1.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
            break
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == 3:
                raise
            print(f"  retrying after error: {exc}")
            time.sleep(5 * (attempt + 1))
    if payload.get("code") != "Ok" or not payload.get("routes"):
        raise RuntimeError(payload.get("message", payload.get("code")))
    route = payload["routes"][0]
    coords = [[round(lon, 5), round(lat, 5)]
              for lon, lat in route["geometry"]["coordinates"]]
    # OSRM starts/ends on the nearest road; join it to the exact locations.
    coords = ([[a.longitude, a.latitude]] + coords
              + [[b.longitude, b.latitude]])
    return {"coords": coords, "km": round(route["distance"] / 1000, 3)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR)
    parser.add_argument("--refresh", action="store_true",
                        help="ignore saved shapes and download all again")
    args = parser.parse_args()

    try:
        graph = build_graph(load_dataset(args.data_dir))
    except DataError as exc:
        print(f"Dataset error: {exc}")
        return 1

    pairs = sorted({tuple(sorted((u, v)))
                    for u, nbrs in graph.adjacency.items() for v in nbrs})
    out_path = os.path.join(args.data_dir, OUTPUT_NAME)
    shapes: dict = {}
    if os.path.exists(out_path) and not args.refresh:
        with open(out_path, encoding="utf-8") as fh:
            shapes = json.load(fh).get("roads", {})

    todo = [p for p in pairs if f"{p[0]}|{p[1]}" not in shapes]
    print(f"{len(pairs)} roads, {len(pairs) - len(todo)} already saved, "
          f"{len(todo)} to download (~{len(todo) * DELAY_S / 60:.0f} min).")

    def save() -> None:
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump({"source": "OSRM (router.project-osrm.org), "
                                 "OpenStreetMap road data",
                       "roads": shapes}, fh, separators=(",", ":"))

    try:
        for i, (a, b) in enumerate(todo, 1):
            try:
                shapes[f"{a}|{b}"] = fetch_route(graph.locations[a],
                                                 graph.locations[b])
            except Exception as exc:  # keep going; that road stays straight
                print(f"  {a} -> {b}: failed ({exc})")
            if i % 25 == 0 or i == len(todo):
                save()
                print(f"  {i}/{len(todo)} done")
            time.sleep(DELAY_S)
    except KeyboardInterrupt:
        save()
        print("\nStopped. Run again to continue where it left off.")
        return 1

    save()
    print(f"Saved {len(shapes)} road shapes to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
