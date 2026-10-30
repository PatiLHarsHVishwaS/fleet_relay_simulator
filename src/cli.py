"""Interactive command-line interface (pipeline stages: Comparison, Output)."""

from __future__ import annotations

from src.astar import astar
from src.dijkstra import dijkstra
from src.graph import METRIC_UNITS, Graph, Location
from src.relay import compare_strategies
from src.simulation import DeliverySimulation, SimulationMetrics
from src.utils import SearchResult, benchmark, format_duration, format_ms

WIDTH = 66
LABEL_W, COL_W = 24, 21

METRIC_TITLES = {
    "time": ("Minimum Travel Time", "Distance"),
    "distance": ("Minimum Distance", "Travel Time"),
}


def _rule(char: str = "-") -> str:
    return char * WIDTH


def _title(text: str) -> None:
    print("\n" + _rule("="))
    print(text.center(WIDTH))
    print(_rule("="))


class RouteOptimizerCLI:
    """Menu-driven front end around the Dijkstra and A* searches."""

    def __init__(self, graph: Graph, metric: str, heuristic_scale: float,
                 benchmark_runs: int) -> None:
        self.graph = graph
        self.metric = metric
        self.heuristic_scale = heuristic_scale
        self.benchmark_runs = benchmark_runs
        # Stable numbering used by the location list: societies, then
        # restaurants, each sorted by ID.
        self.ordered_ids = sorted(
            graph.locations,
            key=lambda nid: (graph.locations[nid].kind != "Society", nid))
        self.list_number = {nid: i for i, nid in
                            enumerate(self.ordered_ids, start=1)}
        # Label the secondary metric neutrally: it was not minimised.
        self.time_label = ("Minimum Time" if metric == "time"
                           else "Travel Time")
        self.distance_label = ("Minimum Distance" if metric == "distance"
                               else "Total Distance")

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------
    def run(self) -> None:
        _title("FOOD DELIVERY ROUTE OPTIMIZER")
        primary, secondary = METRIC_TITLES[self.metric]
        print(f"  Primary optimization : {primary}")
        print(f"  Secondary metric     : {secondary}")
        print(f"  Graph                : {self.graph.node_count} locations, "
              f"{self.graph.edge_count} directed roads")

        actions = {"1": self.find_route, "2": self.show_locations,
                  "3": self.prompt_run_simulation,
                  "4": self.prompt_relay_comparison}
        while True:
            print("\n" + _rule())
            print("  1. Find Route")
            print("  2. Show Available Locations")
            print("  3. Run Delivery Simulation")
            print("  4. Relay Delivery: Direct vs Relay")
            print("  5. Exit")
            print(_rule())
            choice = self._ask("Select an option (1-5): ")
            if choice is None or choice == "5":
                print("\nThank you for using the Food Delivery Route "
                      "Optimizer. Goodbye!")
                return
            action = actions.get(choice)
            if action is None:
                print("  ! Invalid option. Please enter a number from 1 to 5.")
            else:
                action()

    @staticmethod
    def _ask(prompt: str) -> str | None:
        """input() that returns None on Ctrl+C / end of input."""
        try:
            return input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return None

    # ------------------------------------------------------------------
    # Option 2: list locations
    # ------------------------------------------------------------------
    def _describe(self, node_id: str) -> str:
        loc = self.graph.locations[node_id]
        return f"[{loc.node_id}] {loc.name}"

    def _print_numbered(self, node_ids: list[str]) -> None:
        for node_id in node_ids:
            number = self.list_number[node_id]
            marker = "" if self.graph.is_connected_node(node_id) else "  *"
            print(f"  {number:>3}. {self._describe(node_id)}{marker}")

    def _print_societies(self) -> None:
        societies = [n for n in self.ordered_ids
                     if self.graph.locations[n].kind == "Society"]
        print(f"\nSOCIETIES / DELIVERY POINTS ({len(societies)})")
        print(_rule())
        self._print_numbered(societies)

    def show_locations(self) -> None:
        _title("AVAILABLE LOCATIONS")
        self._print_societies()

        restaurants = [n for n in self.ordered_ids
                       if self.graph.locations[n].kind == "Restaurant"]
        print(f"\nRESTAURANTS ({len(restaurants)}), grouped by area")
        print(_rule())
        by_area: dict[str, list[str]] = {}
        for node_id in restaurants:
            area = self.graph.locations[node_id].area or "Unknown area"
            by_area.setdefault(area, []).append(node_id)
        for area in sorted(by_area):
            print(f"\n  -- {area} --")
            self._print_numbered(by_area[area])
        print("\n  * = no road data for this location in the dataset "
              "(no route possible)")

    # ------------------------------------------------------------------
    # Option 1: find a route
    # ------------------------------------------------------------------
    def resolve_location(self, text: str) -> tuple[str | None, str]:
        """Map user input (ID, list number or name) to a node ID.

        Returns (node_id, "") on success or (None, error message).
        """
        query = text.strip()
        if not query:
            return None, "Please enter a location."
        if query.upper() in self.graph.locations:
            return query.upper(), ""
        if query.isdigit():
            number = int(query)
            if 1 <= number <= len(self.ordered_ids):
                return self.ordered_ids[number - 1], ""
            return None, (f"Location number must be between 1 and "
                          f"{len(self.ordered_ids)}.")

        wanted = query.casefold()
        names = {n: self.graph.locations[n].name.casefold()
                 for n in self.ordered_ids}
        matches = ([n for n, name in names.items() if name == wanted]
                   or [n for n, name in names.items() if wanted in name])
        if len(matches) == 1:
            return matches[0], ""
        if not matches:
            return None, (f"'{query}' is not a known location. Use an ID "
                          f"(e.g. S001, R190), a list number or a name.")
        shown = "\n".join(f"      {self._describe(n)}" for n in matches[:10])
        more = f"\n      ... and {len(matches) - 10} more" \
            if len(matches) > 10 else ""
        return None, (f"'{query}' matches {len(matches)} locations. "
                      f"Please type the ID:\n{shown}{more}")

    def _prompt_location(self, label: str,
                         exclude: str | None = None) -> str | None:
        """Ask until a valid location is given; None means 'go back'."""
        while True:
            text = self._ask(f"Enter {label} location (or 'b' to go back): ")
            if text is None or text.lower() == "b":
                return None
            node_id, error = self.resolve_location(text)
            if node_id is None:
                print(f"  ! {error}")
            elif node_id == exclude:
                print("  ! Source and destination are the same. "
                      "Please choose a different destination.")
            else:
                loc = self.graph.locations[node_id]
                print(f"    -> {self._describe(node_id)} "
                      f"({loc.kind}, {loc.area})")
                return node_id

    def find_route(self) -> None:
        _title("FIND ROUTE")
        self._print_societies()
        restaurant_count = sum(1 for loc in self.graph.locations.values()
                               if loc.kind == "Restaurant")
        print(f"\n  + {restaurant_count} restaurants (numbers "
              f"{len(self.ordered_ids) - restaurant_count + 1}-"
              f"{len(self.ordered_ids)}) - see option 2.")
        print("  Tip: a delivery usually goes restaurant -> society.")
        print("  You can type an ID (R190), a list number or part of a "
              "name.\n")

        source = self._prompt_location("source")
        if source is None:
            return
        target = self._prompt_location("destination", exclude=source)
        if target is None:
            return
        self.compare(source, target)

    # ------------------------------------------------------------------
    # Running and comparing the algorithms
    # ------------------------------------------------------------------
    def compare(self, source: str, target: str) -> None:
        """Run Dijkstra and A*, then print both results and a comparison."""
        results = [
            dijkstra(self.graph, source, target, self.metric),
            astar(self.graph, source, target, self.metric,
                  self.heuristic_scale),
        ]
        if self.benchmark_runs > 0:
            searches = [
                lambda: dijkstra(self.graph, source, target, self.metric),
                lambda: astar(self.graph, source, target, self.metric,
                              self.heuristic_scale),
            ]
            for result, search in zip(results, searches):
                result.avg_time_s, result.min_time_s = benchmark(
                    search, self.benchmark_runs)

        self._print_endpoints(source, target)
        if not results[0].found:
            self._print_no_route(results)
            return
        for result in results:
            self._print_result(result)
        self._print_legs(results)
        self._print_comparison(results)

    def _location_details(self, loc: Location) -> str:
        details = [loc.kind, loc.area]
        if loc.cuisine:
            details.append(loc.cuisine)
        if loc.rating is not None:
            details.append(f"rating {loc.rating:.1f}")
        return ", ".join(d for d in details if d)

    def _print_endpoints(self, source: str, target: str) -> None:
        _title("ROUTE SEARCH")
        for label, node_id in (("From", source), ("To", target)):
            loc = self.graph.locations[node_id]
            print(f"  {label:<5}: {self._describe(node_id)}")
            print(f"         {self._location_details(loc)}")
        primary, secondary = METRIC_TITLES[self.metric]
        print(f"  Optimizing for: {primary} (secondary: {secondary})")

    def _print_no_route(self, results: list[SearchResult]) -> None:
        source, target = results[0].source, results[0].target
        print("\n" + _rule())
        print(f"  NO ROUTE EXISTS from {source} to {target}.")
        for node_id in (source, target):
            if not self.graph.is_connected_node(node_id):
                print(f"  Reason: {self._describe(node_id)} has no road "
                      f"data in the dataset.")
        for result in results:
            print(f"  {result.algorithm:<9} explored {result.nodes_visited} "
                  f"node(s) in {format_ms(result.execution_time_s)} "
                  f"before giving up.")
        print(_rule())

    def _print_result(self, result: SearchResult) -> None:
        print(f"\n--- {result.algorithm} " + "-" * (WIDTH - 5
                                                 - len(result.algorithm)))
        print(f"  Algorithm Used     : {result.algorithm}")
        print(f"  From               : {self._describe(result.source)}")
        print(f"  To                 : {self._describe(result.target)}")
        print(f"  Route / Path       : {' -> '.join(result.path)}")
        print(f"  {self.distance_label:<19}: "
              f"{result.total_distance_km:.3f} km")
        print(f"  {self.time_label:<19}: {result.total_time_min:.1f} min")
        print(f"  Nodes Visited      : {result.nodes_visited}")
        print(f"  Edges Traversed    : {result.edges_traversed}")
        print(f"  Execution Time     : "
              f"{format_duration(result.execution_time_s)}")

    def _print_legs(self, results: list[SearchResult]) -> None:
        """Print the route leg by leg (once if both paths are equal)."""
        dijkstra_result, astar_result = results
        routes = [("Route details", dijkstra_result)]
        if astar_result.path != dijkstra_result.path:
            routes = [("Dijkstra route details", dijkstra_result),
                      ("A* route details", astar_result)]
        for heading, result in routes:
            print(f"\n{heading}:")
            for step, node_id in enumerate(result.path, start=1):
                loc = self.graph.locations[node_id]
                print(f"  {step:>2}. {self._describe(node_id)} "
                      f"({loc.kind})")
                if step <= len(result.legs):
                    _, _, km, minutes = result.legs[step - 1]
                    print(f"        |  {km:.3f} km, {minutes:.1f} min")

    def _print_comparison(self, results: list[SearchResult]) -> None:
        d, a = results
        rows = [
            ("From", d.source, a.source),
            ("To", d.target, a.target),
            ("Optimized For", d.metric.title(), a.metric.title()),
            (self.distance_label, f"{d.total_distance_km:.3f} km",
             f"{a.total_distance_km:.3f} km"),
            (self.time_label, f"{d.total_time_min:.1f} min",
             f"{a.total_time_min:.1f} min"),
            ("Nodes Visited", d.nodes_visited, a.nodes_visited),
            ("Edges Relaxed", d.edges_relaxed, a.edges_relaxed),
            ("Edges Traversed", d.edges_traversed, a.edges_traversed),
            ("Execution Time", format_ms(d.execution_time_s),
             format_ms(a.execution_time_s)),
        ]
        if d.avg_time_s is not None and a.avg_time_s is not None:
            n = self.benchmark_runs
            rows += [
                (f"Avg Time ({n} runs)", format_ms(d.avg_time_s),
                 format_ms(a.avg_time_s)),
                (f"Min Time ({n} runs)", format_ms(d.min_time_s),
                 format_ms(a.min_time_s)),
            ]

        _title("ROUTE COMPARISON")
        print(f"{'':<{LABEL_W}}{'DIJKSTRA':<{COL_W}}{'A*':<{COL_W}}")
        print(_rule())
        for label, left, right in rows:
            print(f"{label:<{LABEL_W}}{str(left):<{COL_W}}{str(right):<{COL_W}}")
        print(_rule())
        self._print_verdict(d, a)

    def _print_verdict(self, d: SearchResult, a: SearchResult) -> None:
        unit = METRIC_UNITS[d.metric]
        same_cost = abs(d.cost - a.cost) < 1e-9
        print(f"Optimal cost         : "
              f"{'Both found ' if same_cost else 'MISMATCH: '}"
              f"{d.cost:.3f} {unit}"
              f"{'' if same_cost else f' vs {a.cost:.3f} {unit}'}")
        if d.path == a.path:
            print("Same route           : Yes")
        else:
            print("Same route           : No (different path, equal cost)")

        if a.nodes_visited < d.nodes_visited:
            saved = 100 * (1 - a.nodes_visited / d.nodes_visited)
            print(f"Fewer nodes visited  : A* ({a.nodes_visited} vs "
                  f"{d.nodes_visited}, {saved:.0f}% fewer)")
        elif a.nodes_visited == d.nodes_visited:
            print(f"Fewer nodes visited  : Tie ({d.nodes_visited} each)")
        else:
            print(f"Fewer nodes visited  : Dijkstra ({d.nodes_visited} vs "
                  f"{a.nodes_visited})")

        # Prefer the benchmark average: a single run of a few microseconds
        # is dominated by timer noise.
        use_avg = d.avg_time_s is not None and a.avg_time_s is not None
        d_time = d.avg_time_s if use_avg else d.execution_time_s
        a_time = a.avg_time_s if use_avg else a.execution_time_s
        basis = "average time" if use_avg else "single run"
        faster, slower = ("A*", "Dijkstra") if a_time < d_time \
            else ("Dijkstra", "A*")
        ratio = max(d_time, a_time) / max(min(d_time, a_time), 1e-12)
        print(f"\nFaster Algorithm: {faster} "
              f"({ratio:.2f}x faster than {slower}, by {basis})")

    # ------------------------------------------------------------------
    # Option 3: run the delivery simulation
    # ------------------------------------------------------------------
    def _ask_int(self, label: str, default: int) -> int:
        text = self._ask(f"{label} [{default}]: ")
        if not text:
            return default
        try:
            value = int(text)
        except ValueError:
            print(f"  ! Not a number, using default ({default}).")
            return default
        if value <= 0:
            print(f"  ! Must be positive, using default ({default}).")
            return default
        return value

    def prompt_run_simulation(self) -> None:
        """Menu-driven wrapper around :meth:`run_simulation`."""
        _title("RUN DELIVERY SIMULATION")
        print("  Press Enter to accept each default.\n")
        num_drivers = self._ask_int("Drivers", 50)
        num_orders = self._ask_int("Orders", 100)
        seed_text = self._ask("Seed [42]: ")
        seed = int(seed_text) if seed_text and seed_text.lstrip("-").isdigit() \
            else 42
        algorithm = self._ask("Algorithm (dijkstra/astar) [astar]: ").lower()
        if algorithm not in ("dijkstra", "astar"):
            algorithm = "astar"
        self.run_simulation(num_drivers, num_orders, seed, algorithm)

    def run_simulation(self, num_drivers: int = 50, num_orders: int = 100,
                       seed: int = 42, algorithm: str = "astar") -> SimulationMetrics:
        """Run the greedy-dispatch delivery simulation and print a report."""
        _title("DELIVERY SIMULATION")
        print(f"  Drivers   : {num_drivers}")
        print(f"  Orders    : {num_orders}")
        print(f"  Algorithm : {algorithm}")
        print(f"  Metric    : {self.metric}")
        print(f"  Seed      : {seed}")

        simulation = DeliverySimulation(self.graph, num_drivers, num_orders,
                                        seed, algorithm, self.metric)
        m = simulation.run()

        _title("SIMULATION RESULTS")
        rows = [
            ("Total Orders", m.total_orders),
            ("Delivered Orders", m.delivered_orders),
            ("Failed Orders", m.failed_orders),
            ("Total Distance (km)", f"{m.total_distance_km:.3f}"),
            ("Avg Distance/Order (km)", f"{m.avg_distance_km:.3f}"),
            ("Total Travel Time (min)", f"{m.total_travel_time_min:.1f}"),
            ("Avg Travel Time/Order (min)", f"{m.avg_travel_time_min:.1f}"),
            ("Drivers Used", f"{m.drivers_used} / {m.num_drivers}"),
            ("Driver Utilization", f"{m.driver_utilization * 100:.1f}%"),
            ("Assignment Compute Time", format_duration(
                m.assignment_computation_time_s)),
            ("Total Simulation Time", format_duration(
                m.total_simulation_time_s)),
            ("P50 Assignment Latency", f"{m.p50_assignment_latency_ms:.4f} ms"),
            ("P95 Assignment Latency", f"{m.p95_assignment_latency_ms:.4f} ms"),
            ("P99 Assignment Latency", f"{m.p99_assignment_latency_ms:.4f} ms"),
        ]
        for label, value in rows:
            print(f"  {label:<30}: {value}")
        print(_rule())
        return m

    # ------------------------------------------------------------------
    # Option 4: relay (hand-off) delivery
    # ------------------------------------------------------------------
    def prompt_relay_comparison(self) -> None:
        """Menu-driven wrapper around :meth:`run_relay_comparison`."""
        _title("RELAY DELIVERY: DIRECT VS RELAY")
        print("  Press Enter to accept each default.\n")
        num_drivers = self._ask_int("Drivers", 25)
        num_orders = self._ask_int("Orders", 100)
        seed_text = self._ask("Seed [42]: ")
        seed = int(seed_text) if seed_text and seed_text.lstrip("-").isdigit() \
            else 42
        self.run_relay_comparison(num_drivers, num_orders, seed)

    def run_relay_comparison(self, num_drivers: int = 25,
                             num_orders: int = 100, seed: int = 42) -> None:
        """Run the same orders with one driver per order and with hand-offs
        between drivers, and print both side by side."""
        results = compare_strategies(self.graph, num_drivers, num_orders, seed)
        direct, relay = results["direct"][0], results["relay"][0]
        _title("RELAY DELIVERY: DIRECT VS RELAY")
        print(f"  Drivers: {num_drivers}   Orders: {num_orders} over 120 min"
              f"   Seed: {seed}")
        print("  Relay: a long order is handed to a driver already going "
              "that way.\n")
        print(f"{'':<30}{'DIRECT':>12}{'RELAY':>12}{'CHANGE':>10}")
        print(_rule())
        rows = [
            ("Avg Delivery Time (min)", direct.avg_delivery_min,
             relay.avg_delivery_min, "{:.1f}"),
            ("90% Delivered Within (min)", direct.p90_delivery_min,
             relay.p90_delivery_min, "{:.1f}"),
            ("Total Distance (km)", direct.total_km, relay.total_km, "{:.1f}"),
            ("Empty Driving (km)", direct.empty_km, relay.empty_km, "{:.1f}"),
            ("Driver Busy Time (min)", direct.driver_busy_min,
             relay.driver_busy_min, "{:.0f}"),
            ("Busiest Driver (km)", direct.max_driver_km,
             relay.max_driver_km, "{:.1f}"),
        ]
        print(f"{'Relays (hand-offs)':<30}{direct.relays:>12}{relay.relays:>12}")
        for label, a, b, fmt in rows:
            change = f"{(b - a) / a * 100:+.1f}%" if a else ""
            print(f"{label:<30}{fmt.format(a):>12}{fmt.format(b):>12}"
                  f"{change:>10}")
        print(_rule())

        relays = [o for o in results["relay"][2] if o.is_relay]
        if relays:
            print("\nHand-offs:")
            for o in relays:
                print(f"  {o.order_id}: {o.restaurant_id} -> {o.society_id}, "
                      f"{o.pickup_driver} hands to {o.delivery_driver} "
                      f"at {o.handoff_node} (minute {o.handoff_time:.0f}); "
                      f"{o.pickup_driver} is free {o.minutes_freed:.0f} min "
                      f"earlier")
        print("\nSee it on the map: python visualize.py --fleet")
