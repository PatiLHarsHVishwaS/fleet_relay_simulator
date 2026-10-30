/*
 * Fleet page: animates the direct vs relay delivery simulation
 * (src/relay.py) on the street map.
 *
 * The browser does not simulate anything. /api/fleet returns, for each
 * strategy, every driver's schedule as road segments
 *   [t0, t1, from, to, carrying (0/1), order ids]
 * and every order's times. Here we only interpolate positions at the
 * current minute along the real street shapes.
 */
"use strict";

const SVGNS = "http://www.w3.org/2000/svg";
const HANDOFF_MIN = 2;          // must match src/relay.py
const STRATEGY_LABEL = { direct: "Direct (one driver per order)", relay: "Relay (hand-offs allowed)" };

const app = {
  graph: null,
  nodes: new Map(),
  pairs: new Map(),
  routeCache: new Map(),
  data: null,
  runners: [],
  view: null,
  t: 0,
  tEnd: 0,
  playing: false,
  lastFrame: 0,
  selected: null,       // selected order id
  custom: null,         // the user's own order: "R115,S019,12"
};

const $ = (sel) => document.querySelector(sel);
const pairKey = (u, v) => (u < v ? `${u}|${v}` : `${v}|${u}`);

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showError(msg) {
  const box = $("#error");
  box.textContent = msg;
  box.hidden = !msg;
}

function nodeName(id) {
  const n = app.nodes.get(id);
  return n ? `${id} ${n.name}` : id;
}

// ---------------------------------------------------------------- setup
async function init() {
  try {
    app.graph = await (await fetch("/api/graph")).json();
  } catch (err) {
    showError("Could not load the graph from the server. Is visualize.py running?");
    return;
  }
  for (const n of app.graph.nodes) app.nodes.set(n.id, n);
  for (const e of app.graph.edges) app.pairs.set(pairKey(e.a, e.b), e);
  const s = app.graph.stats;
  $("#info").textContent =
    `Real dataset: ${s.societies} societies, ${s.restaurants} restaurants, ` +
    `${s.roads} one-way roads` +
    (app.graph.street_shapes ? ` · roads drawn along real streets` : "") +
    ` · drivers start on random locations, orders arrive over 120 minutes`;

  // Dropdowns with every restaurant (grouped by area) and every society.
  const option = (n) => `<option value="${esc(n.id)}">${esc(n.id)} — ${esc(n.name)}</option>`;
  const ofKind = (kind) => app.graph.nodes.filter((n) => n.kind === kind);
  const areas = new Map();
  for (const n of ofKind("Restaurant").sort((a, b) => a.id.localeCompare(b.id))) {
    if (!areas.has(n.area)) areas.set(n.area, []);
    areas.get(n.area).push(n);
  }
  $("#myRestaurant").innerHTML = [...areas].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([area, list]) => `<optgroup label="${esc(area)} (${list.length})">${list.map(option).join("")}</optgroup>`)
    .join("");
  $("#mySociety").innerHTML = ofKind("Society").sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => `<option value="${esc(n.id)}">${esc(n.id)} — ${esc(n.name)} (${esc(n.area)})</option>`).join("");
  // Default example: a long order that gets shared with seed 42.
  $("#myRestaurant").value = "R115";
  $("#mySociety").value = "S019";

  const params = new URLSearchParams(location.search);
  for (const name of ["drivers", "orders", "seed"]) {
    if (params.get(name)) $(`#${name}`).value = params.get(name);
  }
  if (params.get("my")) app.custom = params.get("my");
  if (params.get("view")) {
    const radio = document.querySelector(`input[name=view][value=${CSS.escape(params.get("view"))}]`);
    if (radio) radio.checked = true;
  }
  wireControls();
  await runSimulation();
  if (app.custom && app.data && app.data.custom.length) trackOrder(app.data.custom[0]);
  else if (params.get("order")) trackOrder(params.get("order"));
  else renderStory();
  if (params.get("t")) setTime(Number(params.get("t")) || 0);
}

function wireControls() {
  $("#runBtn").addEventListener("click", runSimulation);
  $("#playBtn").addEventListener("click", () => (app.playing ? pause() : play()));
  $("#restartBtn").addEventListener("click", () => { pause(); setTime(0); });
  $("#timeline").addEventListener("input", (e) => { pause(); setTime(Number(e.target.value)); });
  $("#speed").addEventListener("input", updateSpeedLabel);
  $("#fitAllBtn").addEventListener("click", () => fitView());
  $("#nextShared").addEventListener("click", () => tourStep(+1));
  $("#prevShared").addEventListener("click", () => tourStep(-1));
  $("#focusSel").addEventListener("change", render);
  $("#trackBtn").addEventListener("click", () => trackOrder($("#trackOrder").value));
  $("#placeBtn").addEventListener("click", placeMyOrder);
  $("#removeMyBtn").addEventListener("click", removeMyOrder);
  $("#myMinute").addEventListener("keydown", (e) => { if (e.key === "Enter") placeMyOrder(); });
  $("#trackOrder").addEventListener("keydown", (e) => { if (e.key === "Enter") trackOrder(e.target.value); });
  document.querySelectorAll("input[name=view]").forEach((r) =>
    r.addEventListener("change", () => { if (app.data) { buildPanels(); renderOrderCard(); } }));
  try { $("#streetMap").checked = localStorage.getItem("showStreetMap") !== "off"; } catch (_) { /* ignore */ }
  $("#streetMap").addEventListener("change", () => {
    try { localStorage.setItem("showStreetMap", $("#streetMap").checked ? "on" : "off"); } catch (_) { /* ignore */ }
    applyView();
  });
  for (const id of ["#drivers", "#orders", "#seed"]) {
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") runSimulation(); });
  }
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input[type=number]")) return;
    if (e.key === " ") { e.preventDefault(); app.playing ? pause() : play(); }
    else if (e.key === "r" || e.key === "R") { pause(); setTime(0); }
  });
  window.addEventListener("resize", () => applyView());
  updateSpeedLabel();
}

function updateSpeedLabel() {
  $("#speedLabel").textContent = `${$("#speed").value} min/s`;
}

function viewMode() { return document.querySelector("input[name=view]:checked").value; }

async function runSimulation() {
  pause();
  showError("");
  const q = new URLSearchParams({
    drivers: $("#drivers").value, orders: $("#orders").value, seed: $("#seed").value,
  });
  if (app.custom) q.set("custom", app.custom);
  $("#runBtn").disabled = true;
  $("#runBtn").textContent = "Running…";
  try {
    const res = await fetch(`/api/fleet?${q}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Simulation failed.");
    app.data = data;
  } catch (err) {
    showError(err.message);
    return false;
  } finally {
    $("#runBtn").disabled = false;
    $("#runBtn").textContent = "Run Simulation";
  }
  for (const name of ["direct", "relay"]) prepareRun(app.data[name]);
  app.tEnd = Math.ceil(Math.max(...["direct", "relay"].flatMap((k) =>
    app.data[k].orders.map((o) => o.delivered)))) + 2;
  $("#timeline").max = app.tEnd;
  app.selected = null;
  $("#orderList").innerHTML = app.data.relay.orders.map((o) =>
    `<option value="${esc(o.id)} ${esc(o.r)} → ${esc(o.s)}${o.id.startsWith("MY") ? " (your order)" : ""}${o.h ? " (shared)" : ""}">`).join("");
  buildPanels();
  renderMetrics();
  renderRelayList();
  renderOrderCard();
  $("#removeMyBtn").hidden = !app.custom;
  setTime(0);
  return true;
}

/** "Place order & watch": add the user's order and follow it. */
async function placeMyOrder() {
  const r = $("#myRestaurant").value, s = $("#mySociety").value, minute = $("#myMinute").value;
  if (!r || !s) { showError("Choose a restaurant and a housing society for your order."); return; }
  const previous = app.custom;
  app.custom = `${r},${s},${minute}`;
  if (!(await runSimulation())) { app.custom = previous; return; }
  trackOrder(app.data.custom[0]);
}

async function removeMyOrder() {
  app.custom = null;
  await runSimulation();
}

/** Index orders and work out each order's journey: the roads its food
 *  travels on (with the driver carrying it) from restaurant to customer. */
function prepareRun(run) {
  run.ordersById = new Map(run.orders.map((o) => [o.id, o]));
  run.shared = run.orders.filter((o) => o.h);
  run.driversById = new Map(run.drivers.map((d) => [d.id, d]));
  for (const o of run.orders) {
    o.journey = [];
    for (const id of o.h ? [o.a, o.b] : [o.a]) {
      for (const s of run.driversById.get(id).segs) {
        if (s[4] && s[5].includes(o.id)) {
          o.journey.push({ t0: s[0], t1: s[1], a: s[2], b: s[3], driver: id });
        }
      }
    }
    o.journey.sort((x, y) => x.t0 - y.t0);
    const toRestaurant = run.driversById.get(o.a).segs.filter((s) => !s[4] && s[5].includes(o.id));
    o.aAtRestaurant = toRestaurant.length ? toRestaurant[toRestaurant.length - 1][1] : o.created;
    const aCarry = o.journey.filter((j) => j.driver === o.a);
    o.aArrive = aCarry.length ? aCarry[aCarry.length - 1].t1 : (o.ht ?? o.pickup);
  }
}

function storyRun() { return app.data[viewMode() === "direct" ? "direct" : "relay"]; }

/** km and minutes of the road u -> v. */
function roadCost(u, v) {
  const e = app.pairs.get(pairKey(u, v));
  return (e.a === u ? e.ab : e.ba) || [0, 0];
}

// ---------------------------------------------------------------- geometry
/** Points (SVG units) of the road u -> v, following the street shape. */
function route(u, v) {
  const key = `${u}>${v}`;
  let r = app.routeCache.get(key);
  if (!r) {
    const e = app.pairs.get(pairKey(u, v));
    const a = app.nodes.get(u), b = app.nodes.get(v);
    let pts = e && e.shape ? e.shape.map((p) => [p[0], p[1]]) : [[a.x, a.y], [b.x, b.y]];
    if (e && e.shape && e.a !== u) pts = pts.reverse();
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    r = { pts, cum, len: cum[cum.length - 1] };
    app.routeCache.set(key, r);
  }
  return r;
}

function pointAlong(u, v, frac) {
  const r = route(u, v);
  const d = r.len * Math.min(Math.max(frac, 0), 1);
  let i = 1;
  while (i < r.cum.length - 1 && r.cum[i] < d) i++;
  const seg = r.cum[i] - r.cum[i - 1] || 1;
  const k = (d - r.cum[i - 1]) / seg;
  const p = r.pts[i - 1], q = r.pts[i];
  return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
}

function routePoints(u, v) { return route(u, v).pts.map((p) => p.join(",")).join(" "); }

/** Points of the first `frac` of the road u -> v. */
function partialPoints(u, v, frac) {
  const r = route(u, v);
  const d = r.len * Math.min(Math.max(frac, 0), 1);
  const pts = [r.pts[0]];
  for (let i = 1; i < r.pts.length && r.cum[i] < d; i++) pts.push(r.pts[i]);
  pts.push(pointAlong(u, v, frac));
  return pts.map((p) => p.join(",")).join(" ");
}

// ---------------------------------------------------------------- panels
function buildPanels() {
  const mode = viewMode();
  const strategies = mode === "both" ? ["direct", "relay"] : [mode];
  $("#stage").className = `stage ${mode === "both" ? "compare" : "single"}`;
  const host = $("#panels");
  host.innerHTML = "";
  app.runners = strategies.map((strategy) => {
    const run = app.data[strategy];
    const panel = document.createElement("div");
    panel.className = "card panel";
    panel.innerHTML = `
      <div class="panel-head">
        <h2>${STRATEGY_LABEL[strategy]}</h2>
        <span class="pstats"></span>
      </div>
      <div class="mapbox">
        <svg class="graph" role="img" aria-label="${strategy} delivery simulation on the street map"></svg>
        <div class="attrib">Map &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</div>
      </div>`;
    host.appendChild(panel);
    const svg = panel.querySelector("svg");
    const r = {
      strategy, run, svg,
      tileLayer: svgEl("g", { class: "tiles" }, svg), tiles: new Map(),
      roadLayer: svgEl("g", {}, svg),
      selLayer: svgEl("g", {}, svg),
      nodeLayer: svgEl("g", {}, svg),
      journeyLayer: svgEl("g", {}, svg),
      eventLayer: svgEl("g", {}, svg),
      driverLayer: svgEl("g", {}, svg),
      stats: panel.querySelector(".pstats"),
      driverEls: new Map(),
    };
    for (const e of app.graph.edges) {
      svgEl("polyline", { points: routePoints(e.a, e.b), class: "road" }, r.roadLayer);
    }
    for (const n of app.graph.nodes) {
      const c = svgEl("circle", { cx: n.x, cy: n.y, r: 1, class: `loc k-${n.kind}` }, r.nodeLayer);
      svgEl("title", {}, c).textContent = `${n.id} ${n.name} (${n.kind}, ${n.area})`;
    }
    for (const d of run.drivers) {
      // Orders this driver received in a hand-off: drawn in the relay colour.
      d.relayIn = new Set(run.orders.filter((o) => o.h && o.b === d.id).map((o) => o.id));
      // A waits at the hand-off point from arrival until the hand-off ends.
      d.waits = run.orders.filter((o) => o.h && o.a === d.id).map((o) => {
        const last = d.segs.filter((s) => s[4] && s[5].includes(o.id)).pop();
        return [last ? last[1] : o.ht, o.ht + HANDOFF_MIN];
      });
      const g = svgEl("g", { class: "drv" }, r.driverLayer);
      const circle = svgEl("circle", { r: 1 }, g);
      const label = svgEl("text", { class: "drv-label" }, g);
      label.textContent = d.id;
      const title = svgEl("title", {}, g);
      g.addEventListener("click", () => {
        const o = currentOrderOf(d, app.t);
        if (o) selectOrder(o);
      });
      r.driverEls.set(d.id, { g, circle, label, title, d });
    }
    attachPanZoom(svg);
    return r;
  });
  if (!app.view) fitView(); else applyView();
  drawSelection();
  render();
}

// ---------------------------------------------------------------- state
/** Driver position and state at minute t. */
function driverAt(d, t) {
  const segs = d.segs;
  let lo = 0, hi = segs.length - 1, i = -1;
  while (lo <= hi) {                  // last segment with t0 <= t
    const mid = (lo + hi) >> 1;
    if (segs[mid][0] <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (i < 0) {
    const n = app.nodes.get(d.start);
    return { x: n.x, y: n.y, state: "idle", seg: null };
  }
  const s = segs[i];
  if (t < s[1]) {
    const [x, y] = pointAlong(s[2], s[3], (t - s[0]) / (s[1] - s[0]));
    let state = "empty";
    if (s[4]) state = s[5].some((id) => d.relayIn.has(id)) ? "relay" : "carry";
    return { x, y, state, seg: s };
  }
  const n = app.nodes.get(s[3]);
  const next = segs[i + 1];
  const waiting = (next && next[0] > t && next[5].some((id) => s[5].includes(id))) ||
    d.waits.some(([from, to]) => t >= from && t < to);
  return { x: n.x, y: n.y, state: waiting ? "wait" : "idle", seg: s };
}

function currentOrderOf(d, t) {
  const st = driverAt(d, t);
  return st.seg && st.state !== "idle" ? st.seg[5][st.seg[5].length - 1] : null;
}

const STATE_TEXT = {
  idle: "idle", empty: "going to pick up", wait: "waiting",
  carry: "carrying food", relay: "carrying a handed-over order",
};

// ---------------------------------------------------------------- render
function pxPerUnit(svg) {
  const v = app.view;
  return Math.min((svg.clientWidth || 800) / v.w, (svg.clientHeight || 500) / v.h);
}

function render() {
  const t = app.t;
  $("#clock").textContent = t.toFixed(1);
  $("#timeline").value = t;
  for (const r of app.runners) {
    const ppu = pxPerUnit(r.svg);
    let busy = 0;
    const stacked = new Map();   // drivers standing on the same spot
    // Roles in shared orders that are under way: "gives O0004" / "takes O0004".
    const roles = new Map();
    for (const o of r.run.shared) {
      if (t < o.created || t > o.delivered) continue;
      if (t < o.ht + HANDOFF_MIN) roles.set(o.a, `gives ${o.id}`);
      roles.set(o.b, `takes ${o.id}`);
    }
    const sel = app.selected && r.run.ordersById.get(app.selected);
    const focus = sel && $("#focusSel").checked && t <= sel.delivered + 3
      ? new Set([sel.a, sel.b]) : null;
    for (const { g, circle, label, title, d } of r.driverEls.values()) {
      const st = driverAt(d, t);
      if (st.state !== "idle") busy++;
      const spot = `${Math.round(st.x * ppu)},${Math.round(st.y * ppu)}`;
      const below = stacked.get(spot) || 0;
      stacked.set(spot, below + 1);
      circle.setAttribute("cx", st.x);
      circle.setAttribute("cy", st.y);
      circle.setAttribute("r", 6 / ppu);
      label.setAttribute("x", st.x + 8 / ppu);
      label.setAttribute("y", st.y + (4 + 13 * below) / ppu);
      label.setAttribute("font-size", (roles.has(d.id) ? 12.5 : 11) / ppu);
      label.textContent = roles.has(d.id) ? `${d.id} · ${roles.get(d.id)}` : d.id;
      const inSel = focus && focus.has(d.id);
      const dim = focus && !focus.has(d.id);
      g.setAttribute("class", `drv drv-${st.state}${inSel ? " drv-sel" : ""}` +
        `${dim ? " dim" : ""}${roles.has(d.id) ? " has-role" : ""}`);
      if (inSel) g.parentNode.appendChild(g);   // keep on top
      title.textContent = `${d.id}: ${STATE_TEXT[st.state]} · ${d.jobs} jobs · ${d.km} km in total`;
    }

    // New orders whose food is still being prepared / not picked up yet.
    const ev = r.eventLayer;
    ev.innerHTML = "";
    let waitingOrders = 0;
    for (const o of r.run.orders) {
      if (o.created <= t && t < o.pickup) {
        waitingOrders++;
        const n = app.nodes.get(o.r);
        svgEl("circle", { cx: n.x, cy: n.y, r: 9 / ppu, class: `pending${focus ? " dim" : ""}` }, ev);
      }
      // Planned hand-off point, visible from the moment the order is placed.
      if (o.h && t >= o.created && t < o.ht - 1 && o.id !== app.selected) {
        const n = app.nodes.get(o.h);
        const star = svgEl("text", { x: n.x, y: n.y + 6 / ppu, class: "handoff-star planned", "font-size": 18 / ppu }, ev);
        star.textContent = "★";
        const txt = svgEl("text", { x: n.x, y: n.y - 14 / ppu, class: "handoff-label planned", "font-size": 11.5 / ppu }, ev);
        txt.textContent = `${o.id} hand-off at min ${o.ht.toFixed(0)}`;
      }
      if (o.h && t >= o.ht - 1 && t <= o.ht + HANDOFF_MIN + 4) {
        const n = app.nodes.get(o.h);
        const other = focus && o.id !== app.selected ? " dim" : "";
        svgEl("circle", { cx: n.x, cy: n.y, r: 16 / ppu, class: `handoff-ring${other}` }, ev);
        const star = svgEl("text", { x: n.x, y: n.y + 7 / ppu, class: `handoff-star${other}`, "font-size": 22 / ppu }, ev);
        star.textContent = "★";
        const txt = svgEl("text", { x: n.x, y: n.y - 20 / ppu, class: `handoff-label${other}`, "font-size": 13 / ppu }, ev);
        txt.textContent = `${o.a} → ${o.b} (${o.id})`;
      }
    }
    renderJourney(r, ppu);
    const delivered = r.run.orders.filter((o) => o.delivered <= t).length;
    r.stats.textContent = `Delivered ${delivered}/${r.run.orders.length} · ` +
      `drivers busy ${busy}/${r.run.drivers.length} · waiting for pickup ${waitingOrders}`;
  }
  renderStory();
}

// ---------------------------------------------------------------- journey
/** Where the food of order `o` is at minute t. */
function foodAt(o, t) {
  const at = (id, state) => ({ ...xy(id), state });
  if (t < o.created) return null;
  if (t < o.pickup || !o.journey.length) {
    return t >= o.delivered ? at(o.s, "delivered") : at(o.r, "restaurant");
  }
  for (const j of o.journey) {
    if (t < j.t0) return at(j.a, j.a === o.h ? "handoff" : "waiting");
    if (t < j.t1) {
      const [x, y] = pointAlong(j.a, j.b, (t - j.t0) / (j.t1 - j.t0));
      return { x, y, state: "moving", driver: j.driver };
    }
  }
  return at(o.s, "delivered");
}

function xy(id) { const n = app.nodes.get(id); return { x: n.x, y: n.y }; }

/** Paint the part of the food's route already travelled, and the food. */
function renderJourney(r, ppu) {
  const layer = r.journeyLayer;
  layer.innerHTML = "";
  const o = app.selected && r.run.ordersById.get(app.selected);
  if (!o) return;
  const t = app.t;
  for (const j of o.journey) {
    if (t <= j.t0) break;
    const cls = o.h && j.driver === o.b ? "sel-relay" : "sel-carry";
    const points = t >= j.t1 ? routePoints(j.a, j.b)
      : partialPoints(j.a, j.b, (t - j.t0) / (j.t1 - j.t0));
    svgEl("polyline", { points, class: `sel ${cls}` }, layer);
  }
  const food = foodAt(o, t);
  if (!food) return;
  const g = svgEl("g", { class: `food food-${food.state}` }, layer);
  svgEl("rect", { x: food.x - 9 / ppu, y: food.y - 9 / ppu, width: 18 / ppu, height: 18 / ppu,
    rx: 4 / ppu, class: "food-box" }, g);
  const icon = svgEl("text", { x: food.x, y: food.y + 4.5 / ppu, "font-size": 12 / ppu, class: "food-icon" }, g);
  icon.textContent = food.state === "delivered" ? "✓" : "🍱";
  const lbl = svgEl("text", { x: food.x, y: food.y - 14 / ppu, "font-size": 12 / ppu, class: "food-label" }, g);
  lbl.textContent = food.state === "delivered" ? `${o.id} delivered`
    : food.state === "restaurant" ? `${o.id} being prepared` : o.id;
}

// ---------------------------------------------------------------- story
// One name per phase; phase i lasts until ends[i] in renderStory().
const STEP_NAMES = ["Order placed", "A carries it to the hand-off", "A waits for B",
  "Hand-off", "B delivers", "Delivered"];

/** Plain-language explanation of the selected order at the current minute. */
function renderStory() {
  if (!app.data) return;
  document.querySelectorAll("[data-status-for]").forEach((el) => {
    const o = app.data.relay.ordersById.get(el.dataset.statusFor);
    const [text, cls] = app.t < o.created ? ["upcoming", "up"]
      : app.t < o.ht ? ["placed, hand-off planned", "plan"]
      : app.t < o.delivered ? ["handed over", "live"] : ["delivered", "done"];
    el.textContent = text;
    el.className = `status ${cls}`;
  });
  const run = storyRun();
  const o = app.selected && run.ordersById.get(app.selected);
  const t = app.t;
  const steps = $("#storySteps"), text = $("#storyText");
  if (!o) {
    const shared = app.data.relay.shared.length;
    $("#storyTitle").textContent = shared
      ? `${shared} of ${run.orders.length} orders are shared between two drivers`
      : "No order was worth sharing in this run";
    steps.innerHTML = "";
    text.innerHTML =
      `A long order is <b>shared</b> when another driver is <b>already driving past</b> a point on its way. ` +
      `Driver <b>A</b> picks up the food and hands it over there; driver <b>B</b> takes it on to the housing society, and A is free early. ` +
      `Press <b>Next shared order ▶</b> to watch one step by step, or pick any order under <b>Track any order</b> to follow its food from the restaurant to the housing society. ` +
      `Faint ★ on the map are hand-offs that are planned but have not happened yet.`;
    return;
  }
  if (!o.h) { renderDirectStory(o, t, steps, text); return; }
  const ends = [o.pickup, o.aArrive, o.ht, o.ht + HANDOFF_MIN, o.delivered, Infinity];
  let phase = t < o.created ? -1 : ends.findIndex((end) => t < end);
  if (t >= o.delivered) phase = 5;
  $("#storyTitle").textContent = `${isMine(o) ? "Your order" : "Shared order"} ${o.id}: ${o.r} → ${o.s}${isMine(o) ? " (shared)" : ""}`;
  steps.innerHTML = STEP_NAMES.map((name, i) =>
    `<li class="${i < phase ? "done" : i === phase ? "now" : ""}">${name}</li>`).join("");
  const A = `<b class="role-a">${esc(o.a)}</b>`, B = `<b class="role-b">${esc(o.b)}</b>`;
  const H = `<b>${esc(nodeName(o.h))}</b>`;
  const plan = `Plan: ${A} picks it up and drives to ${H}. ${B} is already going to pass ${H} ` +
    `at minute ${o.ht.toFixed(0)}, so ${A} hands the food over there instead of driving all the way.`;
  const lines = [
    `Order will be placed at minute ${o.created.toFixed(1)} at ${esc(nodeName(o.r))} for ${esc(nodeName(o.s))}.`,
    `New order at ${esc(nodeName(o.r))} for ${esc(nodeName(o.s))}, far away. ${plan}`,
    `${A} has the food (🍱) and drives it towards the hand-off point ${H} (green line; grey is the road still ahead). ${B} is still doing its own job on the dotted line, which passes ${H}.`,
    `${A} is at ${H}, waiting for ${B}, who arrives at minute ${o.ht.toFixed(0)}.`,
    `<b>Hand-off at ${H}:</b> ${A} gives order ${esc(o.id)} to ${B}.`,
    `${A} is free again, <b>${o.freed.toFixed(0)} min earlier</b> than driving to the customer, and takes new orders. ` +
      `${B} has the food (🍱), finishes its own delivery on the way, then brings ${esc(o.id)} to ${esc(nodeName(o.s))} (purple line; ${o.helper.toFixed(0)} min extra work for ${B}).`,
    `Delivered at minute ${o.delivered.toFixed(1)}, ${(o.delivered - o.created).toFixed(0)} min after ordering ` +
      `(one driver alone: minute ${o.direct.toFixed(1)}). ${A} gained ${o.freed.toFixed(0)} min for other orders.`,
  ];
  text.innerHTML = lines[phase + 1];
}

const DIRECT_STEPS = ["Order placed, driver on the way", "Food being prepared",
  "Driver carries it", "Delivered"];

/** Story of an order carried by one driver from restaurant to customer. */
function renderDirectStory(o, t, steps, text) {
  const ends = [o.aAtRestaurant, o.pickup, o.delivered, Infinity];
  let phase = t < o.created ? -1 : ends.findIndex((end) => t < end);
  if (t >= o.delivered) phase = 3;
  $("#storyTitle").textContent = `${isMine(o) ? "Your order" : "Order"} ${o.id}: ${o.r} → ${o.s} (one driver)`;
  steps.innerHTML = DIRECT_STEPS.map((name, i) =>
    `<li class="${i < phase ? "done" : i === phase ? "now" : ""}">${name}</li>`).join("");
  const A = `<b class="role-a">${esc(o.a)}</b>`;
  const R = `<b>${esc(nodeName(o.r))}</b>`, S = `<b>${esc(nodeName(o.s))}</b>`;
  const lines = [
    `Order will be placed at minute ${o.created.toFixed(1)} at ${R} for ${S}.`,
    `New order at ${R} for ${S}. ${A} is the driver who can deliver it soonest and drives to the restaurant (dashed blue line).`,
    `${A} is at the restaurant; the food is ready at minute ${o.ready.toFixed(1)}.`,
    `${A} has the food (🍱) and drives it to ${S} along the green line. Grey shows the road still ahead.`,
    `Delivered at minute ${o.delivered.toFixed(1)}, ${(o.delivered - o.created).toFixed(0)} min after ordering.`,
  ];
  text.innerHTML = lines[phase + 1];
  if (isMine(o) && viewMode() !== "direct") {
    text.innerHTML += ` <span class="muted">Not shared: no other driver was passing its route at the right time` +
      (o.direct - o.created < 15 ? " (and the trip is short)" : "") +
      `. Try another minute or a housing society farther away.</span>`;
  }
}

function isMine(o) { return o.id.startsWith("MY"); }

/** Guided tour: jump to the previous/next shared order and play it. */
function tourStep(dir) {
  if (!app.data) return;
  const list = app.data.relay.shared;
  if (!list.length) return;
  let i = list.findIndex((o) => o.id === app.selected);
  i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  const o = list[i];
  pause();
  if (viewMode() === "direct") {
    document.querySelector("input[name=view][value=relay]").checked = true;
    buildPanels();
  }
  selectOrder(o.id);
  focusOrder(o);
  setTime(o.created);   // paused on the plan; Play continues the story
}

/** Zoom to the order's whole journey and the drivers taking part. */
function focusOrder(o) {
  const ids = [o.r, o.s];
  for (const run of app.runners.map((r) => r.run)) {
    const ro = run.ordersById.get(o.id);
    for (const j of ro.journey) ids.push(j.a, j.b);
    for (const s of run.driversById.get(ro.a).segs) if (s[5].includes(o.id)) ids.push(s[2]);
    if (ro.h) {
      for (const s of run.driversById.get(ro.b).segs) {
        if (s[0] >= ro.created - 1 && s[0] <= ro.ht) ids.push(s[2]);
      }
    }
  }
  fitView(ids);
}

/** "Track any order": follow one order's food from restaurant to customer. */
function trackOrder(text) {
  const id = String(text).trim().split(/\s/)[0].toUpperCase();
  const o = app.data && storyRun().ordersById.get(id);
  if (!o) { showError(`Unknown order "${text}". Pick one from the list, e.g. O0004.`); return; }
  showError("");
  pause();
  selectOrder(o.id);
  focusOrder(o);
  setTime(o.created);
}

// ---------------------------------------------------------------- selection
function selectOrder(orderId) {
  app.selected = orderId;
  drawSelection();
  renderOrderCard();
  renderRelayList();
  render();
}

function drawSelection() {
  for (const r of app.runners) {
    const layer = r.selLayer;
    layer.innerHTML = "";
    const o = app.selected && r.run.ordersById.get(app.selected);
    if (!o) continue;
    // Driver A on its way to the restaurant (no food yet).
    for (const s of r.run.driversById.get(o.a).segs) {
      if (!s[4] && s[5].includes(o.id)) {
        svgEl("polyline", { points: routePoints(s[2], s[3]), class: "sel sel-empty" }, layer);
      }
    }
    // The food's whole route, restaurant -> customer, shown from the start;
    // renderJourney() paints over it as the food moves.
    for (const j of o.journey) {
      svgEl("polyline", { points: routePoints(j.a, j.b), class: "sel sel-ahead" }, layer);
    }
    if (o.h) {
      // B's own job up to the hand-off point: shows B was going there anyway.
      const b = r.run.drivers.find((d) => d.id === o.b);
      for (const s of b.segs) {
        if (s[1] <= o.created || s[0] >= o.ht || s[5].includes(o.id)) continue;
        svgEl("polyline", { points: routePoints(s[2], s[3]), class: "sel sel-b-own" }, layer);
      }
    }
    const ppu = pxPerUnit(r.svg);
    const mark = (id, text, cls) => {
      const n = app.nodes.get(id);
      svgEl("circle", { cx: n.x, cy: n.y, r: 9 / ppu, class: `sel-mark ${cls}` }, layer);
      const tx = svgEl("text", { x: n.x, y: n.y + 24 / ppu, class: "sel-text", "font-size": 12 / ppu }, layer);
      tx.textContent = text;
    };
    mark(o.r, `Restaurant ${o.r}`, "m-r");
    mark(o.s, `Housing society ${o.s}`, "m-s");
    if (o.h) mark(o.h, `★ Hand-off ${o.h} (min ${o.ht.toFixed(0)})`, "m-h");
  }
}

function fmtMin(v) { return v == null ? "–" : `min ${Number(v).toFixed(1)}`; }

function renderOrderCard() {
  const card = $("#orderCard");
  const strategy = viewMode() === "direct" ? "direct" : "relay";
  const o = app.selected && app.data && app.data[strategy].ordersById.get(app.selected);
  if (!o) { card.hidden = true; return; }
  card.hidden = false;
  const steps = [
    `Order placed at ${fmtMin(o.created)}; food ready at ${fmtMin(o.ready)}`,
    `<b>${esc(o.a)}</b> picks it up at ${esc(nodeName(o.r))}, ${fmtMin(o.pickup)}`,
  ];
  if (o.h) {
    steps.push(`<b>${esc(o.a)}</b> hands it to <b>${esc(o.b)}</b> at ${esc(nodeName(o.h))}, ${fmtMin(o.ht)}. ` +
      `${esc(o.a)} is free <b>${o.freed.toFixed(0)} min earlier</b> than driving all the way`);
    steps.push(`<b>${esc(o.b)}</b> finishes its own job, then delivers (extra work for ${esc(o.b)}: ${o.helper.toFixed(0)} min)`);
  }
  steps.push(`Delivered to ${esc(nodeName(o.s))} at ${fmtMin(o.delivered)} ` +
    `(${(o.delivered - o.created).toFixed(0)} min after ordering` +
    (o.h ? `; a direct delivery would have arrived at ${fmtMin(o.direct)}` : "") + ")");
  card.innerHTML = `<h3>Order ${esc(o.id)} <span class="muted">(${strategy})</span></h3>
    <ol class="timeline-list">${steps.map((s) => `<li>${s}</li>`).join("")}</ol>
    <h3>Route of the food</h3>${journeyTable(o, app.data[strategy])}
    <div class="btns"><button type="button" id="watchBtn">Watch it</button>
    <button type="button" id="clearSel">Clear</button></div>`;
  $("#watchBtn").addEventListener("click", () => { trackOrder(o.id); play(); });
  $("#clearSel").addEventListener("click", () => selectOrder(null));
}

/** Every place the food passes, with time, driver, km and minutes. */
function journeyTable(o, run) {
  if (!o.journey.length) return "";
  const own = (driver, node, time) => run.orders.filter((x) =>
    x.id !== o.id && x.b === driver && x.s === node && Math.abs(x.delivered - time) < 0.05);
  const rows = [`<tr><td>1</td><td><b>${esc(o.r)}</b> restaurant<br><span class="muted">${esc(app.nodes.get(o.r).name)}</span></td>
    <td>min ${o.pickup.toFixed(1)}</td><td class="role-a">${esc(o.a)}</td><td></td></tr>`];
  let km = 0, mins = 0;
  o.journey.forEach((j, i) => {
    const [dk, dm] = roadCost(j.a, j.b);
    km += dk; mins += dm;
    const notes = [];
    if (j.b === o.h) notes.push(`★ hand-off to <b class="role-b">${esc(o.b)}</b> at min ${o.ht.toFixed(1)}`);
    for (const x of own(j.driver, j.b, j.t1)) notes.push(`${esc(j.driver)} drops its own order ${esc(x.id)} here`);
    if (j.b === o.s) notes.push("<b>delivered</b>");
    const who = o.h && j.driver === o.b ? "role-b" : "role-a";
    rows.push(`<tr><td>${i + 2}</td><td><b>${esc(j.b)}</b> ${app.nodes.get(j.b).kind.toLowerCase()}<br>
      <span class="muted">${esc(app.nodes.get(j.b).name)}</span>${notes.length ? `<br>${notes.join("<br>")}` : ""}</td>
      <td>min ${j.t1.toFixed(1)}</td><td class="${who}">${esc(j.driver)}</td>
      <td class="muted">${dk.toFixed(2)} km<br>${dm.toFixed(1)} min</td></tr>`);
  });
  return `<table class="journey"><tr><th>#</th><th>Place</th><th>Arrives</th><th>Driver</th><th>Road</th></tr>${rows.join("")}</table>
    <p class="muted small">Food travelled ${km.toFixed(2)} km in ${mins.toFixed(1)} min of driving, from restaurant ${esc(o.r)} to housing society ${esc(o.s)}.</p>`;
}

function renderRelayList() {
  if (!app.data) return;
  const relays = app.data.relay.orders.filter((o) => o.h);
  $("#relayCount").textContent = `(${relays.length})`;
  $("#relayList").innerHTML = relays.map((o) => `
    <li data-id="${esc(o.id)}" class="${o.id === app.selected ? "active" : ""}">
      <b>${esc(o.id)}</b> ${esc(o.r)} → ${esc(o.s)}<br>
      <span class="muted">${esc(o.a)} → ${esc(o.b)} at ${esc(o.h)}, minute ${o.ht.toFixed(0)} ·
      ${esc(o.a)} free ${o.freed.toFixed(0)} min earlier</span>
      <span class="status" data-status-for="${esc(o.id)}"></span>
    </li>`).join("") || `<li class="muted">No hand-off was worth it for these orders.</li>`;
  document.querySelectorAll("#relayList li[data-id]").forEach((li) =>
    li.addEventListener("click", () => {
      const o = app.data.relay.ordersById.get(li.dataset.id);
      pause();
      if (viewMode() === "direct") {
        document.querySelector("input[name=view][value=relay]").checked = true;
        buildPanels();
      }
      selectOrder(o.id);
      focusOrder(o);
      setTime(Math.max(0, o.created - 0.5));
    }));
}

function renderMetrics() {
  const d = app.data.direct.metrics, r = app.data.relay.metrics;
  const rows = [
    ["Hand-offs", d.relays, r.relays, 0, null],
    ["Avg delivery time", d.avg_delivery_min, r.avg_delivery_min, 1, "min"],
    ["90% delivered within", d.p90_delivery_min, r.p90_delivery_min, 1, "min"],
    ["Total driving", d.total_km, r.total_km, 1, "km"],
    ["Empty driving", d.empty_km, r.empty_km, 1, "km"],
    ["Driver busy time", d.driver_busy_min, r.driver_busy_min, 0, "min"],
    ["Longest single carry", d.longest_drive_min, r.longest_drive_min, 1, "min"],
  ];
  $("#metrics").innerHTML = `<tr><th></th><th>Direct</th><th>Relay</th><th>Change</th></tr>` +
    rows.map(([label, a, b, dp, unit]) => {
      const change = unit && a ? (b - a) / a * 100 : null;
      const cls = change == null || Math.abs(change) < 0.05 ? "" : change < 0 ? "win" : "lose";
      return `<tr><td>${label}${unit ? ` <span class="muted">(${unit})</span>` : ""}</td>
        <td>${a.toFixed(dp)}</td><td>${b.toFixed(dp)}</td>
        <td class="${cls}">${change == null ? "" : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`}</td></tr>`;
    }).join("");
}

// ---------------------------------------------------------------- playback
function setTime(t) {
  app.t = Math.min(Math.max(t, 0), app.tEnd);
  render();
}

function play() {
  if (!app.data) return;
  if (app.t >= app.tEnd) setTime(0);
  app.playing = true;
  $("#playBtn").innerHTML = "&#9208; Pause";
  app.lastFrame = performance.now();
  requestAnimationFrame(frame);
}

function pause() {
  app.playing = false;
  $("#playBtn").innerHTML = "&#9654; Play";
}

function frame(now) {
  if (!app.playing) return;
  const dt = Math.min((now - app.lastFrame) / 1000, 0.1);
  app.lastFrame = now;
  const before = app.t;
  let t = before + dt * Number($("#speed").value);
  // Follow the selected order: while it is under way, stop at its pickup,
  // hand-off and delivery and ignore other orders. Otherwise pick up the
  // next shared order when it is placed, so its plan is shown first.
  const stops = $("#pauseAtHandoff").checked;
  const current = app.selected && storyRun().ordersById.get(app.selected);
  const crossed = (time) => time > before && time <= t;
  if (current && before < current.delivered) {
    const at = [current.pickup, current.ht, current.delivered].find((x) => x != null && crossed(x));
    if (at !== undefined && stops) { setTime(at); pause(); return; }
  } else if (app.runners.some((r) => r.strategy === "relay")) {
    const placed = app.data.relay.shared.find((o) => crossed(o.created));
    if (placed) {
      setTime(placed.created);
      selectOrder(placed.id);
      focusOrder(placed);
      if (stops) { pause(); return; }
    }
  }
  setTime(t);
  if (app.t >= app.tEnd) { pause(); return; }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- view
function fitView(ids) {
  const pts = ids ? ids.map((id) => app.nodes.get(id)) : app.graph.nodes;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of pts) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const w = Math.max(maxX - minX, 60), h = Math.max(maxY - minY, 60), pad = 0.1;
  app.view = {
    x: (minX + maxX) / 2 - w * (0.5 + pad), y: (minY + maxY) / 2 - h * (0.5 + pad),
    w: w * (1 + 2 * pad), h: h * (1 + 2 * pad),
  };
  applyView();
}

function focusOn(ids) { fitView(ids); }

function applyView() {
  const v = app.view;
  if (!v) return;
  for (const r of app.runners) {
    r.svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
    StreetMap.draw(r.svg, r.tileLayer, r.tiles, app.graph.projection, $("#streetMap").checked);
    const ppu = pxPerUnit(r.svg);
    r.nodeLayer.querySelectorAll("circle").forEach((c) =>
      c.setAttribute("r", (c.classList.contains("k-Society") ? 4 : 2.2) / ppu));
  }
  drawSelection();
  render();
}

function attachPanZoom(svg) {
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const pt = StreetMap.toUser(svg, e.clientX, e.clientY);
    const f = e.deltaY < 0 ? 0.85 : 1 / 0.85;
    const v = app.view;
    const w = Math.min(Math.max(v.w * f, 8), app.graph.width * 3);
    const k = w / v.w;
    app.view = { x: pt.x - (pt.x - v.x) * k, y: pt.y - (pt.y - v.y) * k, w, h: v.h * k };
    applyView();
  }, { passive: false });

  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".drv")) return;    // clicking a driver selects it
    drag = { x: e.clientX, y: e.clientY, view: { ...app.view }, ppu: pxPerUnit(svg) };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    app.view = {
      ...drag.view,
      x: drag.view.x - (e.clientX - drag.x) / drag.ppu,
      y: drag.view.y - (e.clientY - drag.y) / drag.ppu,
    };
    for (const r of app.runners) r.svg.setAttribute("viewBox", `${app.view.x} ${app.view.y} ${app.view.w} ${app.view.h}`);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    svg.classList.remove("dragging");
    applyView();      // load tiles for the new area
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
}

init();
