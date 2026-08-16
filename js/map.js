import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { openPinForm } from "./pinForm.js";
import { openPinDetail } from "./pinDetailModal.js";
import { searchPlace } from "./geo.js";
import { MAP_OUTLINE_SVG } from "./placeholders.js";

const PIN_COLORS = {
  mine: "#b5651d", // accent
  friend: "#2f6fed", // blue
  other: "#2e8b57", // green
};

const STYLES = {
  street: "https://tiles.openfreemap.org/styles/liberty",
  parchment: "https://tiles.openfreemap.org/styles/positron",
  satellite: {
    version: 8,
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

// Draws the same pin-drop shape used elsewhere in the app onto a canvas so
// it can be registered as a MapLibre image (symbol layers need a raster
// image, not an arbitrary DOM element, to support native clustering).
function pinCanvas(color) {
  const scale = 3;
  const canvas = document.createElement("canvas");
  canvas.width = 28 * scale;
  canvas.height = 40 * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.bezierCurveTo(6.3, 0, 0, 6.3, 0, 14);
  ctx.bezierCurveTo(0, 24.5, 14, 40, 14, 40);
  ctx.bezierCurveTo(14, 40, 28, 24.5, 28, 14);
  ctx.bezierCurveTo(28, 6.3, 21.7, 0, 14, 0);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(14, 14, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  // addImage on this MapLibre build only accepts ImageData (or a plain
  // {width,height,data} object) — a raw canvas/HTMLCanvasElement throws a
  // "mismatched image size" RangeError.
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

const session = await requireSession();
if (session) {
  const params = new URLSearchParams(window.location.search);
  const focusPinId = params.get("focusPinId");
  const repositionPinId = params.get("repositionPinId");

  // Remember where the map was pointed so switching tabs and coming back
  // leaves it as you left it, instead of resetting every time.
  const VIEW_KEY = "hg:mapView";
  let initialCenter = [0, 20];
  let initialZoom = 2;
  let restoredView = false;
  if (!focusPinId && !repositionPinId) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(VIEW_KEY) || "null");
      if (saved) {
        initialCenter = [saved.lng, saved.lat];
        initialZoom = saved.zoom;
        restoredView = true;
      }
    } catch {
      // ignore malformed saved state
    }
  }

  let currentStyleKey = "street";
  const map = new maplibregl.Map({
    container: "map",
    style: STYLES[currentStyleKey],
    center: initialCenter,
    zoom: initialZoom,
    pitch: 0,
    maxPitch: 70,
    attributionControl: { compact: true },
  });
  map.on("error", (e) => console.error("MapLibre error:", e.error || e));
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "bottom-right");

  map.on("moveend", () => {
    const c = map.getCenter();
    sessionStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
  });

  // Vertical pan is clamped (no scrolling past the poles); horizontal pan
  // wraps seamlessly forever — that's MapLibre's default renderWorldCopies
  // behavior, so longitude is left alone entirely.
  const MAX_LAT = 82;
  map.on("move", () => {
    const c = map.getCenter();
    if (c.lat > MAX_LAT || c.lat < -MAX_LAT) {
      map.jumpTo({ center: [c.lng, Math.max(-MAX_LAT, Math.min(MAX_LAT, c.lat))] });
    }
  });

  // Friend ids, to color markers by relationship to the pin's owner.
  const { data: accepted } = await supabase
    .from("friend_requests")
    .select("requester_id, recipient_id")
    .eq("status", "accepted")
    .or(`requester_id.eq.${session.user.id},recipient_id.eq.${session.user.id}`);
  const friendIds = new Set(
    (accepted || []).map((r) => (r.requester_id === session.user.id ? r.recipient_id : r.requester_id))
  );

  let pinsById = {};
  let pendingFeatures = [];

  function iconIdFor(pin) {
    const isMine = pin.owner_id === session.user.id;
    return isMine ? "pin-mine" : friendIds.has(pin.owner_id) ? "pin-friend" : "pin-other";
  }

  async function loadPins() {
    const { data: pins, error } = await supabase
      .from("pins")
      .select("id, title, category, lat, lng, visibility, owner_id");
    if (error) {
      console.error(error);
      return;
    }
    pinsById = {};
    const features = pins.map((pin) => {
      pinsById[pin.id] = pin;
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
        properties: { id: pin.id, iconId: iconIdFor(pin) },
      };
    });
    pendingFeatures = features;
    const source = map.getSource("pins");
    if (source) source.setData({ type: "FeatureCollection", features });
  }

  // Registers the pin icons + clustering source/layers. Custom images and
  // sources don't survive a style swap (setStyle replaces everything), so
  // this runs again on every style.load, not just the first.
  function setupPinLayers() {
    ["mine", "friend", "other"].forEach((key) => {
      const id = `pin-${key}`;
      // Drawn at 3x and displayed at icon-size 1/3 below (see
      // unclustered-point layer) instead of using the pixelRatio option —
      // passing pixelRatio here throws a "mismatched image size" error on
      // this MapLibre build.
      if (!map.hasImage(id)) map.addImage(id, pinCanvas(PIN_COLORS[key]));
    });

    if (!map.getSource("pins")) {
      map.addSource("pins", {
        type: "geojson",
        data: { type: "FeatureCollection", features: pendingFeatures },
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 50,
      });
    }
    if (!map.getLayer("clusters")) {
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "pins",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#b5651d",
          "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 30, 28],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "pins",
        filter: ["has", "point_count"],
        layout: { "text-field": "{point_count_abbreviated}", "text-size": 13, "text-font": ["Noto Sans Bold"] },
        paint: { "text-color": "#fff" },
      });
      map.addLayer({
        id: "unclustered-point",
        type: "symbol",
        source: "pins",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": ["get", "iconId"],
          "icon-size": 1 / 3,
          "icon-anchor": "bottom",
          "icon-allow-overlap": true,
        },
      });

      map.on("click", "clusters", (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
        const clusterId = features[0].properties.cluster_id;
        map.getSource("pins").getClusterExpansionZoom(clusterId, (err, zoom) => {
          if (err) return;
          map.easeTo({ center: features[0].geometry.coordinates, zoom });
        });
      });
      map.on("click", "unclustered-point", (e) => {
        const f = e.features[0];
        openPinPopup(f.properties.id, f.geometry.coordinates.slice());
      });
      map.on("mouseenter", "clusters", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "clusters", () => (map.getCanvas().style.cursor = ""));
      map.on("mouseenter", "unclustered-point", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "unclustered-point", () => (map.getCanvas().style.cursor = ""));
    }
  }

  function retintParchment() {
    if (currentStyleKey !== "parchment") return;
    try {
      map.setPaintProperty("background", "background-color", "#f2e9d8");
      map.setPaintProperty("water", "fill-color", "#c9bfa0");
      map.setPaintProperty("landcover_wood", "fill-color", "#ddd2b0");
    } catch {
      // layer ids can vary; a missed retint just falls back to the plain style
    }
  }

  // Neither "load"/"style.load" nor isStyleLoaded() are reliable enough to
  // gate on here — in some environments they never fire/flip true even
  // though the style is genuinely usable moments later. So instead of
  // waiting on a specific signal, just try the setup, and if the image
  // manager isn't ready yet (it throws), retry on a short timer until it
  // works. setupPinLayers is idempotent, so redundant successful calls —
  // from styledata ticks or retries overlapping — are harmless.
  function trySetupPinLayers(attempt = 0) {
    try {
      setupPinLayers();
      retintParchment();
    } catch (err) {
      if (attempt < 30) setTimeout(() => trySetupPinLayers(attempt + 1), 400);
      else console.error("Giving up on map pin layers:", err);
    }
  }
  map.on("styledata", () => trySetupPinLayers());
  trySetupPinLayers();

  await loadPins();

  let activePopup = null;
  async function openPinPopup(pinId, coords) {
    activePopup?.remove();
    const pin = pinsById[pinId];
    if (!pin) return;
    const el = document.createElement("div");
    el.className = "map-pin-popup row";
    el.innerHTML = `
      <div style="flex:1; min-width:0;">
        <strong>${escapeHtml(pin.title)}</strong>
        <div class="muted" style="font-size:0.8rem;">${escapeHtml(pin.category || "")}</div>
      </div>
      <div class="map-pin-popup-thumb pin-photo-placeholder">${MAP_OUTLINE_SVG}</div>
    `;
    el.addEventListener("click", () => {
      activePopup?.remove();
      openPinDetail(pinId, { onChange: loadPins });
    });
    // Anchored to the bottom, offset up by the marker's own on-screen
    // height (see pinCanvas — rendered at 28x40 CSS px) so the popup sits
    // directly above the pin instead of overlapping it, with the tip
    // pointing straight down at it.
    activePopup = new maplibregl.Popup({ closeButton: false, className: "hg-popup", maxWidth: "420px", anchor: "bottom", offset: 44 })
      .setLngLat(coords)
      .setDOMContent(el)
      .addTo(map);

    const { data: photo } = await supabase
      .from("pin_photos")
      .select("storage_path")
      .eq("pin_id", pinId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (photo) {
      const { data } = await supabase.storage.from("media").createSignedUrl(photo.storage_path, 3600);
      const placeholder = el.querySelector(".map-pin-popup-thumb");
      if (data?.signedUrl && placeholder) {
        const img = document.createElement("img");
        img.className = "map-pin-popup-thumb";
        img.src = data.signedUrl;
        placeholder.replaceWith(img);
      }
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  if (focusPinId) {
    map.once("load", async () => {
      await loadPins();
      const pin = pinsById[focusPinId];
      if (pin) {
        map.flyTo({ center: [pin.lng, pin.lat], zoom: 15 });
        openPinPopup(focusPinId, [pin.lng, pin.lat]);
      }
    });
  }

  // Geolocate
  document.getElementById("geolocateBtn").addEventListener("click", () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 14 }),
      () => alert("Couldn't get your location.")
    );
  });
  if (!focusPinId && !repositionPinId && !restoredView) {
    navigator.geolocation?.getCurrentPosition(
      (pos) => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 12 }),
      () => {} // silently fall back to world view
    );
  }

  // Style switcher — street / satellite / parchment
  const styleBtn = document.getElementById("mapStyleBtn");
  const styleDropdown = document.getElementById("mapStyleDropdown");
  styleBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    styleDropdown.style.display = styleDropdown.style.display === "none" ? "flex" : "none";
  });
  document.addEventListener("click", () => {
    if (styleDropdown) styleDropdown.style.display = "none";
  });
  document.querySelectorAll("[data-map-style]").forEach((btn) => {
    btn.addEventListener("click", () => {
      styleDropdown.style.display = "none";
      const key = btn.dataset.mapStyle;
      if (key === currentStyleKey) return;
      currentStyleKey = key;
      map.setStyle(STYLES[key]);
    });
  });

  // Hold anywhere on the map to drop a new pin there. Pointer Events unify
  // mouse + touch; detection lives on the map's own DOM container rather
  // than MapLibre's click handling so a real long-press (minimal movement,
  // held ~550ms) is unambiguous from a pan/drag.
  const mapContainer = map.getContainer();
  let pressStart = null;
  let pressTimer = null;
  let pressFired = false;
  const activePointers = new Set();

  mapContainer.addEventListener("pointerdown", (e) => {
    activePointers.add(e.pointerId);
    if (repositionPinId) return;
    if (e.target.closest(".maplibregl-popup, .maplibregl-marker, .maplibregl-ctrl")) return;
    // A second finger landing — whether it starts this gesture or joins one
    // already pending — means it's a pinch/rotate, not a long-press to add
    // a pin, so bail out entirely.
    if (activePointers.size > 1) {
      clearTimeout(pressTimer);
      pressStart = null;
      return;
    }
    pressStart = { x: e.clientX, y: e.clientY };
    pressFired = false;
    pressTimer = setTimeout(() => {
      pressFired = true;
      const rect = mapContainer.getBoundingClientRect();
      const point = [pressStart.x - rect.left, pressStart.y - rect.top];
      const lngLat = map.unproject(point);
      openPinForm({ lat: lngLat.lat, lng: lngLat.lng, onSaved: loadPins });
    }, 550);
  });
  mapContainer.addEventListener("pointermove", (e) => {
    if (!pressStart) return;
    if (Math.abs(e.clientX - pressStart.x) > 10 || Math.abs(e.clientY - pressStart.y) > 10) {
      clearTimeout(pressTimer);
    }
  });
  ["pointerup", "pointercancel"].forEach((evt) =>
    mapContainer.addEventListener(evt, (e) => {
      activePointers.delete(e.pointerId);
      clearTimeout(pressTimer);
      pressStart = null;
    })
  );

  // Search
  const searchForm = document.getElementById("searchForm");
  searchForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = document.getElementById("searchInput").value.trim();
    if (!q) return;
    try {
      const results = await searchPlace(q);
      if (results[0]) map.flyTo({ center: [results[0].lng, results[0].lat], zoom: 13 });
    } catch (err) {
      console.error(err);
    }
  });

  // Reposition mode — reached via "Change location on map" when editing a
  // pin. Shows a fixed center-pin overlay (map pans underneath it) instead
  // of an in-form draggable picker.
  if (repositionPinId) {
    document.getElementById("holdHint").style.display = "none";
    const banner = document.getElementById("repositionBanner");
    const markerOverlay = document.getElementById("repositionMarker");
    banner.style.display = "flex";
    markerOverlay.style.display = "block";

    map.once("load", async () => {
      await loadPins();
      const pin = pinsById[repositionPinId];
      document.getElementById("repositionLabel").textContent = pin ? `Moving "${pin.title}"` : "Move this pin";
      if (pin) map.flyTo({ center: [pin.lng, pin.lat], zoom: 15 });
    });

    document.getElementById("repositionCancelBtn").addEventListener("click", () => {
      window.location.href = "index.html";
    });
    document.getElementById("repositionConfirmBtn").addEventListener("click", async () => {
      const center = map.getCenter();
      await supabase.from("pins").update({ lat: center.lat, lng: center.lng }).eq("id", repositionPinId);
      window.location.href = `index.html?focusPinId=${repositionPinId}`;
    });
  }
}
