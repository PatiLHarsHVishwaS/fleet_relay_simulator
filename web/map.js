/*
 * Street-map background shared by the search visualizer (index.html) and
 * the fleet page (fleet.html).
 *
 * Tiles come from the standard OpenStreetMap tile server. The server places
 * nodes in Web Mercator, so tile (z, tx, ty) covers world
 * [tx / 2^z, (tx + 1) / 2^z] and maps to SVG units through `projection`
 * ({origin_x, origin_y, unit} from /api/graph).
 */
"use strict";

const StreetMap = (() => {
  const SVG = "http://www.w3.org/2000/svg";
  const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

  function toUser(svg, clientX, clientY) {
    return new DOMPoint(clientX, clientY).matrixTransform(svg.getScreenCTM().inverse());
  }

  /** Show the tiles covering `svg`'s visible area in `layer`. `cache` is a
   *  Map kept per SVG so unchanged tiles are not reloaded. */
  function draw(svg, layer, cache, projection, enabled) {
    svg.classList.toggle("map-on", enabled);
    const keep = new Set();
    const rect = svg.getBoundingClientRect();
    if (enabled && projection && rect.width > 0) {
      const proj = projection;
      // Visible area in SVG units (wider than the viewBox when aspect differs).
      const a = toUser(svg, rect.left, rect.top), b = toUser(svg, rect.right, rect.bottom);
      const dpr = window.devicePixelRatio || 1;
      const screenPxPerWorld = (rect.width / (b.x - a.x)) * proj.unit;
      let z = Math.round(Math.log2(screenPxPerWorld / 256));
      z = Math.min(Math.max(z + (dpr > 1 ? 1 : 0), 3), 19);
      const x0 = proj.origin_x + a.x / proj.unit, x1 = proj.origin_x + b.x / proj.unit;
      const y0 = proj.origin_y + a.y / proj.unit, y1 = proj.origin_y + b.y / proj.unit;
      let n, tx0, tx1, ty0, ty1;
      for (;; z--) {   // never request an unreasonable number of tiles
        n = 2 ** z;
        tx0 = Math.max(0, Math.floor(x0 * n)); tx1 = Math.min(n - 1, Math.floor(x1 * n));
        ty0 = Math.max(0, Math.floor(y0 * n)); ty1 = Math.min(n - 1, Math.floor(y1 * n));
        if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 64 || z <= 3) break;
      }
      const size = proj.unit / n;
      for (let tx = tx0; tx <= tx1; tx++) {
        for (let ty = ty0; ty <= ty1; ty++) {
          const key = `${z}/${tx}/${ty}`;
          keep.add(key);
          if (cache.has(key)) continue;
          const img = document.createElementNS(SVG, "image");
          img.setAttribute("x", (tx / n - proj.origin_x) * proj.unit);
          img.setAttribute("y", (ty / n - proj.origin_y) * proj.unit);
          // a hair of overlap hides seams between neighbouring tiles
          img.setAttribute("width", size * 1.004);
          img.setAttribute("height", size * 1.004);
          img.setAttribute("preserveAspectRatio", "none");
          img.addEventListener("error", () => img.remove());   // offline: plain graph
          img.setAttribute("href", TILE_URL.replace("{z}", z).replace("{x}", tx).replace("{y}", ty));
          layer.appendChild(img);
          cache.set(key, img);
        }
      }
    }
    for (const [key, img] of cache) {
      if (!keep.has(key)) { img.remove(); cache.delete(key); }
    }
  }

  return { draw, toUser };
})();
