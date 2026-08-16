// Shared MapLibre building blocks used by both the main map (js/map.js)
// and the pin-form location picker (js/pinForm.js) so the two stay
// visually and behaviorally consistent — same tile styles, same pin
// artwork, same "style not ready yet, retry" workaround.

// Shared with the map's Tag filter menu — "Other" always sorts last,
// everything else stays alphabetical.
export const CATEGORIES = ["Beach", "Camping", "Cliff Jumping", "Hiking", "Hunting", "Photography", "Roof", "Urban Exploring", "Other"];

export const STYLES = {
  street: "https://tiles.openfreemap.org/styles/liberty",
  parchment: "https://tiles.openfreemap.org/styles/positron",
  satellite: {
    version: 8,
    // Without a glyphs endpoint, any text symbol layer (e.g. cluster-count
    // labels) silently renders no text on this style — reuse OpenFreeMap's
    // font glyphs, which is independent of the tile source itself.
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      esri: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "Esri, Maxar, Earthstar Geographics",
      },
    },
    layers: [{ id: "esri", type: "raster", source: "esri" }],
  },
};

// Draws the same pin-drop shape used across the app onto a canvas so it
// can be registered as a MapLibre image (symbol layers need a raster
// image, not an arbitrary DOM element, to support native clustering).
export function pinCanvas(color) {
  const scale = 3;
  // Extra top/side margin so the drop shadow isn't clipped by the canvas
  // bounds — no bottom margin, so the shape's bottom tip stays exactly at
  // the canvas's bottom edge (icon-anchor: "bottom" relies on that for
  // the marker to sit precisely on its coordinate, not float above it).
  const pad = 4;
  const canvas = document.createElement("canvas");
  canvas.width = (28 + pad * 2) * scale;
  canvas.height = (40 + pad) * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.translate(pad, pad);

  function dropPath() {
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.bezierCurveTo(6.3, 0, 0, 6.3, 0, 14);
    ctx.bezierCurveTo(0, 24.5, 14, 40, 14, 40);
    ctx.bezierCurveTo(14, 40, 28, 24.5, 28, 14);
    ctx.bezierCurveTo(28, 6.3, 21.7, 0, 14, 0);
    ctx.closePath();
  }

  // Soft shadow for a bit of depth, then the crisp shape on top (drawn
  // twice — once for shadow, once clean — since shadow settings also
  // apply to the stroke/fill if left on for those).
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1.5;
  dropPath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();

  dropPath();
  const gradient = ctx.createLinearGradient(0, 0, 0, 40);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, shade(color, -18));
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(14, 14, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();

  // addImage on this MapLibre build only accepts ImageData (or a plain
  // {width,height,data} object) — a raw canvas/HTMLCanvasElement throws a
  // "mismatched image size" RangeError.
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// Darkens (negative amt) or lightens (positive amt) a #rrggbb color by amt
// percent, for a subtle top-to-bottom gradient on the pin drop.
function shade(hex, amt) {
  const num = parseInt(hex.slice(1), 16);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp(((num >> 16) & 0xff) + Math.round((amt / 100) * 255));
  const g = clamp(((num >> 8) & 0xff) + Math.round((amt / 100) * 255));
  const b = clamp((num & 0xff) + Math.round((amt / 100) * 255));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export function retintParchment(map, styleKey) {
  if (styleKey !== "parchment") return;
  try {
    map.setPaintProperty("background", "background-color", "#f2e9d8");
    map.setPaintProperty("water", "fill-color", "#c9bfa0");
    map.setPaintProperty("landcover_wood", "fill-color", "#ddd2b0");
  } catch {
    // layer ids can vary; a missed retint just falls back to the plain style
  }
}

// Dynamically loads the MapLibre GL script+CSS if they're not already on
// the page — index.html (the main map) preloads them via a plain
// <script> tag, but other pages that embed a small map on demand (the
// pin-form location picker) need to pull them in themselves.
export async function ensureMapLibre() {
  if (window.maplibregl) return;
  if (!document.querySelector("link[data-maplibre]")) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/maplibre-gl@5.8.0/dist/maplibre-gl.css";
    link.setAttribute("data-maplibre", "1");
    document.head.appendChild(link);
  }
  const existingScript = document.querySelector("script[data-maplibre]");
  if (!existingScript) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/maplibre-gl@5.8.0/dist/maplibre-gl.js";
      script.setAttribute("data-maplibre", "1");
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  } else {
    await new Promise((resolve) => {
      if (window.maplibregl) return resolve();
      existingScript.addEventListener("load", resolve, { once: true });
    });
  }
}

// Single-color pin clustering — the picker map just needs "here's roughly
// where your other pins are" for context, not per-owner colors or
// click-to-open popups (clicking the picker map places the new pin
// instead), so this is a simpler one-color version of what js/map.js
// itself does with its three owner/friend/other colors.
function addClusterLayers(map, { sourceId, color, features }) {
  const iconId = `${sourceId}-icon`;
  if (!map.hasImage(iconId)) map.addImage(iconId, pinCanvas(color));
  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: "geojson",
      data: { type: "FeatureCollection", features },
      cluster: true,
      clusterMaxZoom: 14,
      clusterRadius: 40,
    });
  }
  if (!map.getLayer(`${sourceId}-clusters`)) {
    map.addLayer({
      id: `${sourceId}-clusters`,
      type: "circle",
      source: sourceId,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": color,
        "circle-radius": 18,
        "circle-stroke-width": 2,
        "circle-stroke-color": "#fff",
      },
    });
    map.addLayer({
      id: `${sourceId}-cluster-count`,
      type: "symbol",
      source: sourceId,
      filter: ["has", "point_count"],
      layout: { "text-field": "{point_count_abbreviated}", "text-size": 13, "text-font": ["Noto Sans Bold"] },
      paint: { "text-color": "#fff" },
    });
    map.addLayer({
      id: `${sourceId}-unclustered-point`,
      type: "symbol",
      source: sourceId,
      filter: ["!", ["has", "point_count"]],
      layout: { "icon-image": iconId, "icon-size": 1 / 3, "icon-anchor": "bottom", "icon-allow-overlap": true },
    });
  }
}

// Neither "load"/"style.load" nor isStyleLoaded() are reliable enough to
// gate on in every environment this runs in — instead of waiting on a
// specific readiness signal, just try the setup and retry on a short
// timer until the image manager stops throwing. Idempotent, so redundant
// successful calls (from styledata ticks or overlapping retries) are
// harmless.
export function tryAddClusterLayers(map, opts, attempt = 0) {
  try {
    addClusterLayers(map, opts);
  } catch (err) {
    if (attempt < 30) setTimeout(() => tryAddClusterLayers(map, opts, attempt + 1), 400);
    else console.error("Giving up on cluster layers:", err);
  }
}
