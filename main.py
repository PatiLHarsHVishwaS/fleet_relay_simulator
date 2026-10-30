"""Food Delivery Route Optimizer - entry point.

Pipeline:
    Data Loading -> Data Cleaning -> Graph Construction
        -> Dijkstra -> A* -> Comparison -> CLI Output

Usage:
    python main.py                            # interactive menu
    python main.py --metric distance          # optimise km instead of minutes
    python main.py --source R190 --destination S010   # one-shot comparison
    python main.py --relay                    # direct vs relay delivery
"""

from __future__ import annotations

import argparse
import os
import sys

from src.cli import RouteOptimizerCLI
from src.data_loader import DataError, load_dataset
from src.graph import build_graph
from src.heuristics import calibrate_scale

DEFAULT_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "data")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Food delivery route optimization with Dijkstra and A*.")
    parser.add_argument(
        "--data-dir", default=DEFAULT_DATA_DIR,
        help="folder containing the CSV dataset (default: ./data)")
    parser.add_argument(
        "--metric", choices=["time", "distance"], default="time",
        help="edge weight to minimise (default: time)")
    parser.add_argument(
        "--runs", type=int, default=200,
        help="benchmark repetitions per algorithm for avg/min timing; "
             "0 disables (default: 200)")
    parser.add_argument("--source", help="source location for a one-shot run")
    parser.add_argument("--destination",
                        help="destination location for a one-shot run")
    parser.add_argument(
        "--simulate", action="store_true",
        help="run the greedy-dispatch delivery simulation and exit")
    parser.add_argument(
        "--relay", action="store_true",
        help="compare direct vs relay (hand-off) delivery and exit")
    parser.add_argument(
        "--drivers", type=int, default=None,
        help="number of simulated drivers (default: 50 with --simulate, "
             "25 with --relay)")
    parser.add_argument(
        "--orders", type=int, default=100,
        help="number of simulated orders (default: 100, with --simulate)")
    parser.add_argument(
        "--sim-seed", type=int, default=42,
        help="random seed for the simulation (default: 42)")
    parser.add_argument(
        "--algorithm", choices=["dijkstra", "astar"], default="astar",
        help="routing algorithm used for dispatch (default: astar)")
    return parser.parse_args()


def main() -> int:
    # Location names include Devanagari script; make sure printing them
    # never crashes on a legacy Windows console code page.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    args = parse_args()
    if args.runs < 0:
        print("Error: --runs must be 0 or more.")
        return 2

    try:
        dataset = load_dataset(args.data_dir)
        graph = build_graph(dataset)
    except DataError as exc:
        print(f"Dataset error: {exc}")
        return 1
    for warning in dataset.warnings:
        print(f"[data warning] {warning}")

    heuristic_scale = calibrate_scale(graph, args.metric)
    app = RouteOptimizerCLI(graph, args.metric, heuristic_scale, args.runs)

    if args.simulate:
        app.run_simulation(args.drivers or 50, args.orders, args.sim_seed,
                           args.algorithm)
        return 0

    if args.relay:
        app.run_relay_comparison(args.drivers or 25, args.orders,
                                 args.sim_seed)
        return 0

    if args.source or args.destination:
        if not (args.source and args.destination):
            print("Error: --source and --destination must be used together.")
            return 2
        endpoints = []
        for text in (args.source, args.destination):
            node_id, error = app.resolve_location(text)
            if node_id is None:
                print(f"Error: {error}")
                return 2
            endpoints.append(node_id)
        if endpoints[0] == endpoints[1]:
            print("Error: source and destination are the same location.")
            return 2
        app.compare(*endpoints)
        return 0

    app.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
