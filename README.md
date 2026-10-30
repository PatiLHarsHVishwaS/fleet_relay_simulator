# Food Delivery Route Optimizer (Dijkstra vs A*)

A command-line application that finds the best delivery route between
restaurants and housing societies in **Sangli–Miraj–Kupwad (Maharashtra)**.
Each query is solved twice, once with **Dijkstra's algorithm** and once with
**A\***. Both are implemented from scratch with `heapq`, and the CLI compares
their route, distance, time, search effort and execution time.

---

## Project Structure

```text
GroupMiniPro/
├── data/
│   ├── societies (2).csv
│   ├── restaurants (1).csv
│   ├── society_connections (1).csv
│   └── society_restaurants (1).csv
├── src/
│   ├── __init__.py
│   ├── data_loader.py   # stage 1-2: load CSVs, validate columns, clean values
│   ├── graph.py         # stage 3: build the directed weighted graph
│   ├── heuristics.py    # Haversine distance + heuristic calibration
│   ├── dijkstra.py      # Dijkstra from scratch
│   ├── astar.py         # A* from scratch
│   ├── utils.py         # SearchResult, path reconstruction, benchmarking
│   ├── cli.py           # menu, input validation, output, comparison
│   ├── tracing.py       # (visualization) records steps of the real algorithms
│   └── visualization.py # (visualization) local web server + JSON API
├── web/                 # (visualization) index.html, app.js, style.css
├── main.py              # entry point (argparse)
├── visualize.py         # visualization entry point
├── requirements.txt
└── README.md
```

Pipeline: `Data Loading → Data Cleaning → Graph Construction → Dijkstra → A* → Comparison → CLI Output`

---

## Dataset

Files are located by pattern (`societies*.csv`, …), so the `(1)`/`(2)`
suffixes in the file names do not matter.

| File | Rows | Role | Important columns |
|---|---|---|---|
| `societies (2).csv` | 20 | **Nodes**: delivery destinations (customers) | `Society_ID` (S001–S020), `Society_Name`, `Area`, `Latitude`, `Longitude` |
| `restaurants (1).csv` | 248 | **Nodes**: food pickup points | `Restaurant_ID` (R001–R248), `Restaurant_Name`, `Area`, `Cuisine`, `Latitude`, `Longitude`, `Phone`, `Rating` (mostly empty) |
| `society_connections (1).csv` | 44 | **Edges**: society ↔ society roads | `Society_A`, `Society_B`, `Distance_km`, `Travel_Time_min`, `In_MST` |
| `society_restaurants (1).csv` | 300 | **Edges**: society ↔ restaurant roads (15 nearest restaurants per society) | `Society_ID`, `Restaurant_ID`, `Rank`, `Distance_km`, `Travel_Time_min`, `Return_Distance_km`, `Return_Travel_Time_min` |

Observations from inspecting the data:

* **Every location has latitude/longitude**, so a geographic heuristic is possible.
* **Both distance and travel time are given for every road.** They are not
  proportional: S001→S004 is 3.16 km / 15.8 min, but S002→S018 is 2.43 km / 6.3 min.
  Traffic, road type and turns clearly affect time.
* **Society↔restaurant roads are asymmetric.** `Distance_km`/`Travel_Time_min` is the
  society→restaurant direction and `Return_*` is restaurant→society. For example,
  S001→R187 is 0.694 km, but R187→S001 is 3.172 km (one-way streets). The graph must
  therefore be **directed**.
* `In_MST` (minimum spanning tree flag) and `Rank` (nearest-restaurant rank) are
  not needed for shortest paths, so they are not used as weights.
* There are no missing IDs, coordinates or weights in the current files. The loader
  still handles such cases (see *Error handling*).
* Some names are in Devanagari script, so output is forced to UTF-8.

### Choice of optimization metric

**Primary optimization: Minimum Travel Time. Secondary metric: Distance.**

In food delivery, time is what matters to the customer (food temperature, ETA).
Distance is only a proxy for time, and in this dataset it is a poor proxy.
Both totals are always reported. To optimize distance instead, run
`python main.py --metric distance`.

---

## Graph Representation

* **Nodes (268):** 20 societies + 248 restaurants. Every node has at least one road.
* **Edges (688 directed):**
  * each society connection → 2 edges (A→B and B→A) with the same weights: 88
  * each society–restaurant row → S→R (forward values) + R→S (`Return_*` values): 600
* Each edge stores **both** weights, `(distance_km, time_min)`. The algorithms pick
  one of them with `METRIC_INDEX`.

```python
graph.adjacency = {
    "R190": {"S001": (0.549, 7.0)},                  # neighbour: (km, min)
    "S001": {"S003": (2.691, 9.3), "R190": (0.549, 6.8), ...},
    ...
}
```

Restaurants are ordinary nodes, so a route may pass a restaurant's location
when that road segment is part of the fastest path (for example, society →
restaurant → another society).

---

## Dijkstra (`src/dijkstra.py`)

1. `distance[source] = 0`, then push `(0, source)` onto the **priority queue** (min-heap).
2. Pop the node with the smallest cost. Skip it if it is already in **visited**
   (outdated heap entry: `heapq` has no decrease-key).
3. Mark it visited. If it is the destination, stop early because its cost is final.
4. **Relax** every outgoing edge: if `cost + w(u,v) < distance[v]`, update the
   **distance map**, set `parent[v] = u` and push `v`.
5. Rebuild the route by following **parent/predecessor** links back from the destination.

## A* (`src/astar.py`)

A* is the same loop, but the open set is ordered by

```
f(n) = g(n) + h(n)
```

* `g_score[n]`: exact cost from the source (what Dijkstra calls `distance`)
* `h_score[n]`: heuristic estimate from `n` to the destination
* `f_score[n]`: estimated total cost of a route through `n`

The **open set** is a min-heap of `(f, h, node)`. Ties on `f` go to the node
nearer the goal. A **closed set** holds expanded nodes, and **parent** links
rebuild the path.

## Heuristic (`src/heuristics.py`)

```
h(n) = scale × haversine_km(n, destination)
```

* **Haversine** gives the great-circle ("as the crow flies") distance between two
  lat/lon points. No road route can be shorter than the straight line.
* `scale` converts straight-line km into the optimized metric. It is **calibrated
  from the data** as `min over all edges of weight(u,v) / haversine(u,v)`:
  * time: `scale = 0.911 min/km`, which means no road in the data is traveled faster
    than ~65.8 km/h in straight-line terms
  * distance: `scale = 0.364`
* Because every edge satisfies `w(u,v) ≥ scale·hav(u,v)` and Haversine obeys the
  triangle inequality, the heuristic is **consistent** and therefore **admissible**.
  A* is then guaranteed to return the optimal cost, and each node is expanded at most once.

**Why not simply `h = haversine` for distance?** The data has a few inconsistent
records. For example, S006→R133 is listed as a 0.12 km road, but the two
coordinates are 0.33 km apart. With plain Haversine, h would *over*-estimate there,
and A* could return a non-optimal route. Calibration keeps A* provably correct.
The cost is a weaker heuristic.

**Verification:** Dijkstra and A* were run on **all 71,556 ordered pairs of
locations, for both metrics**. A* returned the same optimal cost in every case.

---

## Complexity

V = nodes (268), E = directed edges (688).

| Algorithm | Time | Space |
|---|---|---|
| Dijkstra (binary heap, lazy deletion) | O((V + E) log V) | O(V + E) for heap entries, plus O(V) for maps |
| A* (binary heap, consistent heuristic) | O((V + E) log V) worst case, same as Dijkstra | O(V + E) |

In the worst case (h = 0, or a useless heuristic) A* behaves exactly like
Dijkstra. With a good heuristic it expands only the nodes whose `f(n)` is below
the optimal cost, which is typically a region stretched toward the destination
instead of a full circle around the source. Each A* expansion costs slightly
more because it computes h(n), a Haversine with trigonometry.

---

## Running the Project

**Easiest (Windows):** double-click `run.bat`. It checks Python, installs
`pandas` if needed, and shows a menu for the route finder, the browser
visualization, the delivery simulation, a demo route and the tests.

```bash
pip install -r requirements.txt
python main.py                                      # interactive menu
python main.py --metric distance                    # optimize km instead of minutes
python main.py --source R190 --destination S010     # one-shot comparison
python main.py --runs 0                             # skip the averaged benchmark
```

At the location prompts you can type an **ID** (`R190`, `s010`), the **list number**
shown in option 2, or **part of a name** (`sahyadri`). Type `b` to go back.

Options: `--data-dir PATH` (default `./data`), `--metric {time,distance}`,
`--runs N` (benchmark repetitions, default 200).

### Execution time

Only the algorithm body is timed with `time.perf_counter()`. The timer starts
after the graph is built and stops right after path reconstruction. Loading,
graph construction, heuristic calibration, input, totals and printing are not
included. A single search on this graph takes tens of microseconds, so one
measurement is noisy. The CLI therefore also repeats each search `--runs` times and
reports the **average** and **minimum**. The "Faster Algorithm" verdict uses the average.

### Error handling

* Invalid source/destination, out-of-range numbers, ambiguous names (lists the matches)
* Source = destination (asks again)
* No route exists (reported, with the reason if a location has no roads)
* Missing data folder or file, empty file, header-only file, unparsable CSV,
  missing required columns (clear message, exit code 1)
* Missing or non-numeric weights, invalid coordinates, duplicate IDs, edges to unknown
  locations, self-loops, negative weights (skipped with a `[data warning]`)
* Ctrl+C / end of input exit cleanly

---

## Example Output

Real output of `python main.py --source R190 --destination S010`. The interactive
menu (option 1) prints the same report after you pick the two locations.

```text
==================================================================
                           ROUTE SEARCH
==================================================================
  From : [R190] Hotel The Sayyad
         Restaurant, Tilak Nagar Rural, restaurant
  To   : [S010] KNP Housing Society
         Society, Trimurti Colony / Vijaynagar
  Optimizing for: Minimum Travel Time (secondary: Distance)

--- Dijkstra -----------------------------------------------------
  Algorithm Used     : Dijkstra
  From               : [R190] Hotel The Sayyad
  To                 : [S010] KNP Housing Society
  Route / Path       : R190 -> S001 -> S010
  Total Distance     : 3.018 km
  Minimum Time       : 18.3 min
  Nodes Visited      : 19
  Edges Traversed    : 2
  Execution Time     : 0.0957 ms (0.000096 s)

--- A* -----------------------------------------------------------
  Algorithm Used     : A*
  ...                  (same route and totals)
  Execution Time     : 0.2171 ms (0.000217 s)

Route details:
   1. [R190] Hotel The Sayyad (Restaurant)
        |  0.549 km, 7.0 min
   2. [S001] Arihant Nano Emerald by Akus Construction and Developers (Society)
        |  2.469 km, 11.3 min
   3. [S010] KNP Housing Society (Society)

==================================================================
                         ROUTE COMPARISON
==================================================================
                        DIJKSTRA             A*
------------------------------------------------------------------
From                    R190                 R190
To                      S010                 S010
Optimized For           Time                 Time
Total Distance          3.018 km             3.018 km
Minimum Time            18.3 min             18.3 min
Nodes Visited           19                   19
Edges Relaxed           43                   43
Edges Traversed         2                    2
Execution Time          0.0957 ms            0.2171 ms
Avg Time (200 runs)     0.0580 ms            0.1618 ms
Min Time (200 runs)     0.0224 ms            0.0679 ms
------------------------------------------------------------------
Optimal cost         : Both found 18.300 min
Same route           : Yes
Fewer nodes visited  : Tie (19 each)

Faster Algorithm: Dijkstra (2.79x faster than A*, by average time)
```

For this short trip the heuristic
prunes nothing, so both algorithms expand the same 19 nodes and Dijkstra wins on
raw speed. Try a cross-city pair (e.g. an Othonial Colony restaurant in Miraj to
S019 in Ganeshdurga) to see A* expand fewer nodes.

---

## Comparison: why A* may visit fewer nodes

Dijkstra has no idea where the destination is. It expands nodes in order of their
distance from the source, like a ripple spreading in every direction, so it also
explores restaurants and societies *behind* the source. A* adds `h(n)`. A node
that is far from the destination gets a large `f(n)` and is postponed, often past
the moment the destination is reached, so it is never expanded.

What to expect in this project:

* **Distance and Minimum Time:** always identical for both algorithms, because both
  are optimal. The *route* can differ only when two routes have exactly the same cost.
* **Nodes Visited:** A* ≤ Dijkstra. Over all pairs, the average is 135.0 vs 117.3
  (time) and 135.0 vs 111.3 (distance). The saving is largest for long trips across
  the city and zero for short hops next to the source.
* **Execution Time:** on this small graph (268 nodes), A* often **is not** faster in
  wall-clock time. Each expansion computes a Haversine, and the heuristic is
  deliberately conservative (see above), so fewer expansions do not always pay for
  the extra work. On large road networks with a tighter heuristic, the smaller
  search space dominates, and that is where A* shines.

---

## Search Visualization (optional add-on)

An interactive browser view that animates Dijkstra and A* on the real graph.
It is a separate tool. `python main.py` works exactly as before.

```bash
python visualize.py                  # opens http://127.0.0.1:8050
python visualize.py --port 8051 --no-browser
```

It uses only the Python standard library (`http.server`) and plain HTML/JS/SVG,
with no CDN, so it also works offline during a presentation.

### Street map background

With **Street map** ticked (the default), the graph is drawn on top of
OpenStreetMap tiles. Nodes are placed in Web Mercator, the projection the
tiles use, so each restaurant and society sits on its real street. Roads
are drawn along the real streets they follow. The dataset has distances and
times but no street geometry, so `python fetch_road_geometry.py` downloaded
each road's driving path once from the public OSRM router (OpenStreetMap
roads) into `data/road_geometry.json`. Re-run it only if the CSVs change.
These shapes are for display only: Dijkstra and A* still use the dataset's
own distances and times. If the file is missing, roads are drawn as straight
lines. The map tiles need an internet connection; without one, the graph is
shown on a plain background.

### Where the data comes from

`src/visualization.py` calls the project's own `load_dataset()`, `build_graph()`
and `calibrate_scale()`. Nodes are placed by their real latitude/longitude,
and every road in `graph.adjacency` is drawn. No demo data is created.

### How the algorithms are traced, without changing them

`src/tracing.py` runs the **unmodified** `dijkstra()` / `astar()` functions and
observes them from the outside:

1. The global `heapq` inside the algorithm module is temporarily replaced
   (`unittest.mock.patch`) by a recorder. The recorder forwards every
   `heappush`/`heappop` to the real `heapq` and logs the entry: Dijkstra's
   `(g, node)` and A*'s `(f, h, node)`, which gives g = f − h. The h values are
   therefore the exact heuristic that `astar.py` uses.
2. The algorithm gets a shallow copy of the graph whose `adjacency` dict logs
   each `adjacency[node]` lookup, which is when a node's roads are relaxed.

Each heap pop becomes one **step** (expand / skip outdated entry / reach goal),
with the roads examined, the neighbours improved, and a snapshot of the priority
queue. Each trace is checked against a normal run (same path, cost, node count
and edge count), and the UI shows **"trace verified ✓"**. This check passed on
13,988 traced runs. Execution times come from normal, untraced runs and the
same `benchmark()` the CLI uses.

### Using it in a presentation

* Pick **Single algorithm** (Dijkstra or A*) or **Dijkstra vs A\*** (side by side,
  same graph, source and destination, stepping together).
* **Play / Pause / Next / Prev / Restart**, plus a speed slider.
  Keys: `Space`, `→`, `←`, `R`. Scroll to zoom, drag to pan.
* The right-hand panel shows `Step k / N`, the current node, a plain-English
  **Action** ("Pop S006 (lowest f = g + h = 3.0 + 8.5 = 11.5)…"), live counts,
  g/h/f for A*, and the **priority queue** in pop order.
* After the destination is popped, the route is traced back through the parent
  links one road at a time. A final-route card and a comparison table
  (actual values) then appear.
* Deep link to a prepared slide:
  `http://127.0.0.1:8050/?source=R128&target=S019&mode=compare&step=40`
  (`step=end` shows the result; `algo=astar`, `metric=distance` also work).

Good demo pair: **R128 → S019** (Miraj to Ganeshdurga). Dijkstra explores 197
nodes and A* explores 167, both finding the same 45.1 min route.

---

## Relay Delivery: Drivers Cooperating on One Order (`src/relay.py`)

On a long order, the driver who picks the food up (A) should not have to drive
the whole way if another driver (B) is **already going that way**. A carries
the food to a point H on B's planned route and hands it over. A is free early,
near the restaurants where the next orders start. B finishes its own job (its
customer waits only the 2-minute hand-off) and then delivers this order.

This is a **time-based** simulation: orders arrive over 120 minutes, food is
ready 10 minutes after ordering, and drivers stay busy while they drive. The
same drivers and orders are run twice:

* **Direct:** one driver per order, the one that can deliver soonest.
* **Relay:** same, but a long order (fastest trip of 15 min or more) is handed
  over when

  ```
  net benefit = minutes driver A gets back
              - B's extra work (waiting + hand-off + drive to this customer)
              - extra wait for this customer and for B's own customers
              > 0
  ```

  A waits at most 10 min at H, B at most 5 min, and the customer gets the
  food at most 10 min later than with a direct delivery.

Averaged over 20 random runs of 100 orders:

| Drivers | Relays / 100 orders | Avg delivery time | Total km | Driver busy time |
|---|---|---|---|---|
| 15 | 4.0 | 79.1 → 77.2 min | 981 → 950 | −2.1% |
| 25 | 5.6 | 39.2 → 38.5 min | 915 → 875 | −2.6% |
| 50 | 6.7 | 32.0 → 32.5 min | 797 → 754 | −2.9% |

Relay always saves driving (about 3–5% fewer km) and shortens deliveries
when drivers are scarce. With many drivers, customers wait about half a
minute longer on average. A first version that also let an idle driver
drive out to meet the order made every result worse, because that driver's
empty trip cancelled the saving. That is why B must already be going that way.

```bash
python main.py --relay                    # console table + list of hand-offs
python main.py --relay --drivers 15 --orders 120 --sim-seed 7
python visualize.py --fleet               # animated map
```

The fleet page (`web/fleet.html`) animates every driver along the real
streets. Press **Next shared order ▶** for a guided walk-through of one shared
order. The story box above the map explains each step in plain words and
highlights it: placed → A carries it to the hand-off → A waits for B →
hand-off → B delivers → delivered. The plan is visible from the moment the
order is placed:

* the hand-off point (★) and its time,
* the labels "D021 · gives O0004" and "D015 · takes O0004" on the drivers,
* B's own route as a dotted line, showing it already passes the hand-off point,
* the order's route: dashed blue to the restaurant, green with driver A,
  purple with driver B.

**Track any order** (shared or not) follows its food from the restaurant to
the housing society. A 🍱 marker moves with the food. The whole road ahead is
grey from the start and fills in as the food travels (green with driver A,
purple with driver B). The order card lists the **route of the food** place by
place, with arrival time, driver, km and minutes, including where driver B
drops its own order on the way. In **Side by side**, the same order is
followed in Direct and Relay at once.

**Place your own order:** pick a restaurant (all 248, grouped by area) and a
housing society (all 20) from the dropdowns and the minute the order is
placed, then press **Place order & watch**. The
order (MY01) is added to the simulated orders and dispatched like them, and
the page follows its food to the housing society. It is shared only when a
driver happens to pass its route at the right time. Example: R115 → S019 at
minute 12 is shared (D005 hands it to D004 at S006); R036 → S004 at minute 20
is delivered by one driver. Adding an order can change how the other orders
are assigned. Deep link: `fleet.html?my=R115,S019,12`.

Other drivers fade out while an order is followed. Playback pauses at the
plan, the pickup, the hand-off and the delivery. Faint ★ mark hand-offs of other orders
that are planned but have not happened yet. **Side by side** plays Direct and
Relay together on the same clock.
#   f o o d _ d e l i v e r y _ v i s u a l i z e r  
 