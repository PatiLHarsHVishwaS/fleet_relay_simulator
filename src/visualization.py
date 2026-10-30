"""Local web server for the search visualization.

Everything shown in the browser comes from the existing project code:

* ``load_dataset`` + ``build_graph``  -> the real 268-node / 688-road graph
* ``calibrate_scale``                 -> the exact A* heuristic scale
* ``tracing.dijkstra_with_trace`` / ``astar_with_trace``
                                      -> steps of the unmodified algorithms
* ``dijkstra`` / ``astar`` + ``utils.benchmark`` -> real execution times
* ``RouteOptimizerCLI.resolve_location`` -> same ID/number/name matching as
                                          the CLI
* ``relay.compare_strategies``        -> the fleet page (direct vs relay)

Only the Python standard library is used (``http.server``). The server binds
to 127.0.0.1 and serves a fixed whitelist of static files from ``web/``.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import asdict
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from src.astar import astar
from src.cli import RouteOptimizerCLI
from src.data_loader import load_dataset
from src.dijkstra import dijkstra
from src.graph import METRIC_INDEX, METRIC_UNITS, build_graph
from src.heuristics import calibrate_scale
from src.relay import compare_strategies
from src.tracing import astar_with_trace, dijkstra_with_trace
from src.utils import benchmark

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "web")

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/fleet.html": ("fleet.html", "text/html; charset=utf-8"),
    "/fleet.js": ("fleet.js", "text/javascript; charset=utf-8"),
    "/map.js": ("map.js", "text/javascript; charset=utf-8"),
}
FLEET_LIMITS = {"drivers": (1, 200), "orders": (1, 300)}

LAYOUT_WIDTH = 1000.0  # SVG user units across the whole city
ROAD_GEOMETRY_FILE = "road_geometry.json"  # made by fetch_road_geometry.py


def _mercator(lat: float, lon: float) -> tuple[float, float]:
    """Web Mercator world coordinates (0..1 square, north up)."""
    x = (lon + 180.0) / 360.0
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0
    return x, y


def _load_road_shapes(data_dir: str) -> dict[str, list[list[float]]]:
    """Street shapes per "A|B" road, or {} if the file is missing/broken."""
    path = os.path.join(data_dir, ROAD_GEOMETRY_FILE)
    try:
        with open(path, encoding="utf-8") as fh:
            roads = json.load(fh)["roads"]
        return {key: road["coords"] for key, road in roads.items()}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


class VisualizationBackend:
    """Loads the real graph once and answers visualization queries."""

    def __init__(self, data_dir: str, benchmark_runs: int) -> None:
        dataset = load_dataset(data_dir)
        self.graph = build_graph(dataset)
        self.warnings = dataset.warnings
        self.benchmark_runs = benchmark_runs
        self.scales = {metric: calibrate_scale(self.graph, metric)
                       for metric in METRIC_INDEX}
        # Reuse the CLI's location matching (ID, list number or name).
        self._resolver = RouteOptimizerCLI(self.graph, "time", 0.0, 0)
        self.road_shapes = _load_road_shapes(data_dir)
        self.graph_payload = self._build_graph_payload()
        # Direct vs relay runs for the fleet page, cached per parameters.
        self.fleet = lru_cache(maxsize=16)(
            lambda drivers, orders, seed, custom=(): _fleet_payload(
                self, drivers, orders, seed, custom))

    # ------------------------------------------------------------------
    def custom_order(self, text: str) -> tuple[str, str, float]:
        """Parse "restaurant,society,minute" from the fleet page. The
        locations accept the same IDs, list numbers or names as the CLI."""
        parts = [p.strip() for p in text.split(",")]
        if len(parts) != 3:
            raise ValueError("Your order needs a restaurant, a housing "
                             "society and a minute.")
        ids = []
        for label, part in zip(("Restaurant", "Housing society"), parts):
            node_id, error = self._resolver.resolve_location(part)
            if node_id is None:
                raise ValueError(f"{label}: {error}")
            ids.append(node_id)
        try:
            minute = float(parts[2])
        except ValueError:
            raise ValueError("Order minute must be a number.") from None
        return ids[0], ids[1], minute

    # ------------------------------------------------------------------
    def _build_graph_payload(self) -> dict[str, Any]:
        """Nodes positioned by their real lat/lon, plus every road."""
        locations = list(self.graph.locations.values())
        # Web Mercator: the projection used by OpenStreetMap tiles, so the
        # street-map background lines up.
        xs, ys = zip(*(_mercator(loc.latitude, loc.longitude)
                       for loc in locations))
        min_x, min_y = min(xs), min(ys)
        span = max(max(xs) - min_x, max(ys) - min_y) or 1.0
        unit = LAYOUT_WIDTH / span

        def to_svg(lat: float, lon: float) -> list[float]:
            x, y = _mercator(lat, lon)
            return [round((x - min_x) * unit, 2), round((y - min_y) * unit, 2)]

        nodes = []
        for loc, x, y in zip(locations, xs, ys):
            nodes.append({
                "id": loc.node_id, "name": loc.name, "kind": loc.kind,
                "area": loc.area, "cuisine": loc.cuisine,
                "lat": loc.latitude, "lon": loc.longitude,
                "x": round((x - min_x) * unit, 3),
                "y": round((y - min_y) * unit, 3),
            })

        # One visual line per connected pair; both directions' weights kept.
        pairs: dict[tuple[str, str], dict[str, Any]] = {}
        for source, neighbours in self.graph.adjacency.items():
            for target, (km, minutes) in neighbours.items():
                a, b = sorted((source, target))
                pair = pairs.setdefault((a, b), {"a": a, "b": b,
                                                 "ab": None, "ba": None})
                pair["ab" if source == a else "ba"] = [km, minutes]
        # Real street shape (A -> B direction) when it has been downloaded.
        for (a, b), pair in pairs.items():
            shape = self.road_shapes.get(f"{a}|{b}")
            if shape:
                pair["shape"] = [to_svg(lat, lon) for lon, lat in shape]

        societies = sum(1 for loc in locations if loc.kind == "Society")
        return {
            "nodes": nodes,
            "edges": list(pairs.values()),
            "width": round(max(n["x"] for n in nodes), 3),
            "height": round(max(n["y"] for n in nodes), 3),
            # SVG x = (world_x - origin_x) * unit, same for y (map tiles).
            "projection": {"origin_x": min_x, "origin_y": min_y,
                           "unit": unit},
            "stats": {
                "locations": len(locations),
                "societies": societies,
                "restaurants": len(locations) - societies,
                "roads": self.graph.edge_count,
            },
            "street_shapes": sum(1 for p in pairs.values() if "shape" in p),
            "heuristic_scale": self.scales,
            "units": METRIC_UNITS,
            "benchmark_runs": self.benchmark_runs,
            "warnings": self.warnings,
        }

    # ------------------------------------------------------------------
    def search(self, source_text: str, target_text: str,
               metric: str) -> dict[str, Any]:
        """Trace both algorithms for one query. Raises ValueError."""
        if metric not in METRIC_INDEX:
            raise ValueError("Metric must be 'time' or 'distance'.")
        source, error = self._resolver.resolve_location(source_text)
        if source is None:
            raise ValueError(f"Source: {error}")
        target, error = self._resolver.resolve_location(target_text)
        if target is None:
            raise ValueError(f"Destination: {error}")
        if source == target:
            raise ValueError("Source and destination are the same location.")

        scale = self.scales[metric]
        runs = {
            "dijkstra": dijkstra_with_trace(self.graph, source, target,
                                            metric),
            "astar": astar_with_trace(self.graph, source, target, metric,
                                      scale),
        }
        if self.benchmark_runs > 0:
            timed = {
                "dijkstra": lambda: dijkstra(self.graph, source, target,
                                             metric),
                "astar": lambda: astar(self.graph, source, target, metric,
                                       scale),
            }
            for name, search in timed.items():
                avg_s, min_s = benchmark(search, self.benchmark_runs)
                runs[name]["avg_time_ms"] = avg_s * 1000
                runs[name]["min_time_ms"] = min_s * 1000

        return {
            "source": source,
            "target": target,
            "metric": metric,
            "unit": METRIC_UNITS[metric],
            "heuristic_scale": scale,
            "benchmark_runs": self.benchmark_runs,
            **runs,
        }


def _fleet_run(metrics, drivers, orders) -> dict[str, Any]:
    """One strategy's results in a compact form for the browser."""
    return {
        "metrics": asdict(metrics),
        "drivers": [{
            "id": d.driver_id,
            "start": d.segments[0].a if d.segments else d.node,
            "km": round(d.km, 2), "jobs": d.jobs,
            # [t0, t1, from, to, carrying (0/1), order ids]
            "segs": [[s.t0, s.t1, s.a, s.b, int(s.carrying), s.order_ids]
                     for s in d.segments],
        } for d in drivers],
        "orders": [{
            "id": o.order_id, "r": o.restaurant_id, "s": o.society_id,
            "created": o.created, "ready": o.ready,
            "pickup": o.pickup_time, "delivered": o.delivered_time,
            "direct": o.direct_delivered_time,
            "a": o.pickup_driver, "b": o.delivery_driver,
            "h": o.handoff_node, "ht": o.handoff_time,
            "freed": o.minutes_freed, "helper": o.helper_extra_min,
        } for o in orders],
    }


def _fleet_payload(backend: "VisualizationBackend", drivers: int,
                   orders: int, seed: int,
                   custom: tuple = ()) -> dict[str, Any]:
    results = compare_strategies(backend.graph, drivers, orders, seed,
                                 custom_orders=custom)
    return {"drivers": drivers, "orders": orders, "seed": seed,
            "custom": [f"MY{i:02d}" for i in range(1, len(custom) + 1)],
            **{name: _fleet_run(*res) for name, res in results.items()}}



def make_handler(backend: VisualizationBackend) -> type:
    """Create a request handler class bound to ``backend``."""

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, status: int, payload: Any) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._send(status, body, "application/json; charset=utf-8")

        def do_GET(self) -> None:  # noqa: N802 (http.server naming)
            url = urlparse(self.path)
            if url.path == "/api/graph":
                self._send_json(200, backend.graph_payload)
            elif url.path == "/api/search":
                query = parse_qs(url.query)

                def arg(name: str, default: str = "") -> str:
                    return query.get(name, [default])[0]

                try:
                    payload = backend.search(arg("source"), arg("target"),
                                             arg("metric", "time"))
                except ValueError as exc:
                    self._send_json(400, {"error": str(exc)})
                else:
                    self._send_json(200, payload)
            elif url.path == "/api/fleet":
                query = parse_qs(url.query)
                try:
                    values = {}
                    for name, default in (("drivers", 25), ("orders", 100),
                                          ("seed", 42)):
                        values[name] = int(query.get(name, [default])[0])
                    for name, (low, high) in FLEET_LIMITS.items():
                        if not low <= values[name] <= high:
                            raise ValueError(
                                f"{name} must be between {low} and {high}.")
                    custom = tuple(backend.custom_order(text)
                                   for text in query.get("custom", [])
                                   if text.strip())
                    payload = backend.fleet(values["drivers"],
                                            values["orders"], values["seed"],
                                            custom)
                except ValueError as exc:
                    self._send_json(400, {"error": str(exc)})
                else:
                    self._send_json(200, payload)
            elif url.path in STATIC_FILES:
                filename, content_type = STATIC_FILES[url.path]
                try:
                    with open(os.path.join(WEB_DIR, filename), "rb") as fh:
                        self._send(200, fh.read(), content_type)
                except OSError:
                    self._send_json(500, {"error": f"{filename} missing"})
            else:
                self._send_json(404, {"error": "Not found"})

        def log_message(self, *args: Any) -> None:
            """Keep the terminal quiet; errors surface in the browser."""

    return Handler


class _Server(ThreadingHTTPServer):
    # Threaded so one idle browser connection cannot block the others.
    # No address reuse: on Windows it lets a second server silently bind a
    # busy port; this way a busy port raises OSError instead.
    allow_reuse_address = False
    daemon_threads = True


def serve(backend: VisualizationBackend, host: str, port: int) -> _Server:
    """Create (but do not start) the HTTP server."""
    return _Server((host, port), make_handler(backend))
