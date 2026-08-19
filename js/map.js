import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { openPinForm } from "./pinForm.js";
import { openPinDetail } from "./pinDetailModal.js";
import { searchPlace } from "./geo.js";
import { MAP_OUTLINE_SVG } from "./placeholders.js";
import { getSignedUrl } from "./signedUrlCache.js";
import { STYLES, CATEGORIES, pinCanvas, retintParchment } from "./mapStyles.js";

const PIN_COLORS = {
  mine: "#2f6fed", // blue
  friend: "#2e8b57", // green — pins from people you follow
  other: "#b5651d", // brown/accent — everyone else's public pins
};

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
  if (!focusPinId && !repositionPinId) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(VIEW_KEY) || "null");
      if (saved) {
        initialCenter = [saved.lng, saved.lat];
        initialZoom = saved.zoom;
      }
    } catch {
      // ignore malformed saved state
    }
  }

  // Parchment is the default look; once someone explicitly picks a
  // different style it's remembered (across sessions) as their preference.
  const STYLE_KEY = "hg:mapStyle";
  let currentStyleKey = localStorage.getItem(STYLE_KEY) || "parchment";
  if (!STYLES[currentStyleKey]) currentStyleKey = "parchment";
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

  // "You are here" blue dot — MapLibre's own GeolocateControl handles the
  // dot rendering and, with trackUserLocation on, keeps it live-updating
  // via watchPosition for as long as this map page stays open (once the
  // user has granted permission once, it re-tracks automatically on every
  // visit without asking again). Its default button is hidden; the
  // existing toolbar location button just triggers it instead, so there's
  // one geolocate control in the UI, not two.
  const geolocateControl = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserLocation: true,
  });
  map.addControl(geolocateControl, "top-left");

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

  // Directional: people I follow (accepted), to color markers by
  // relationship to the pin's owner. Whether they follow ME is irrelevant
  // here — same directional model as profile.js's Followers/Following.
  const { data: accepted } = await supabase
    .from("friend_requests")
    .select("recipient_id")
    .eq("status", "accepted")
    .eq("requester_id", session.user.id);
  const followingIds = new Set((accepted || []).map((r) => r.recipient_id));

  let allPins = [];
  let pinsById = {};
  let pendingFeatures = [];

  // Same three-way split as the marker colors: a pin is "mine", from
  // someone I "following", or a stranger's "public" pin — mutually
  // exclusive, so the Accounts filter checkboxes never overlap.
  function bucketFor(pin) {
    if (pin.owner_id === session.user.id) return "mine";
    if (followingIds.has(pin.owner_id)) return "following";
    return "public";
  }
  function iconIdFor(pin) {
    const bucket = bucketFor(pin);
    return bucket === "mine" ? "pin-mine" : bucket === "following" ? "pin-friend" : "pin-other";
  }

  const FILTER_KEY = "hg:mapFilters";
  const filterState = loadFilterState();
  function loadFilterState() {
    try {
      const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || "null");
      if (saved) return { accounts: new Set(saved.accounts), tags: new Set(saved.tags) };
    } catch {
      // fall through to defaults
    }
    return { accounts: new Set(["public", "following", "mine"]), tags: new Set(CATEGORIES) };
  }
  function saveFilterState() {
    localStorage.setItem(
      FILTER_KEY,
      JSON.stringify({ accounts: [...filterState.accounts], tags: [...filterState.tags] })
    );
  }

  function applyFilters() {
    const features = allPins
      .filter((pin) => filterState.accounts.has(bucketFor(pin)) && (!pin.category || filterState.tags.has(pin.category)))
      .map((pin) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
        properties: { id: pin.id, iconId: iconIdFor(pin) },
      }));
    pendingFeatures = features;
    const source = map.getSource("pins");
    if (source) source.setData({ type: "FeatureCollection", features });
  }

  async function loadPins() {
    const { data: pins, error } = await supabase
      .from("pins")
      .select("id, title, category, lat, lng, visibility, owner_id");
    if (error) {
      console.error(error);
      return;
    }
    allPins = pins;
    pinsById = {};
    pins.forEach((pin) => (pinsById[pin.id] = pin));
    applyFilters();
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
        // Tight radius (close to a single marker's own footprint) so
        // points only merge into a cluster once they'd actually overlap
        // on screen, not just because they're roughly nearby.
        clusterRadius: 40,
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
          // Fixed size regardless of point_count — only the number inside
          // changes, so a cluster never visually "grows" as pins gather.
          "circle-radius": 18,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
          // Instant, not the ~300ms default fade — clusters/pins should
          // appear and disappear the moment zoom crosses their threshold,
          // not lag a beat behind it.
          "circle-opacity-transition": { duration: 0 },
          "circle-stroke-opacity-transition": { duration: 0 },
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "pins",
        filter: ["has", "point_count"],
        layout: {
          "text-field": "{point_count_abbreviated}",
          "text-size": 13,
          "text-font": ["Noto Sans Bold"],
          // allow/ignore-placement skip the collision-resolution queue,
          // which is what was making the count fade in a beat behind the
          // circle itself (opacity-transition alone doesn't cover that —
          // symbol placement has its own internal crossfade).
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": "#fff", "text-opacity-transition": { duration: 0 } },
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
        paint: { "icon-opacity-transition": { duration: 0 } },
      });

      map.on("mouseenter", "clusters", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "clusters", () => (map.getCanvas().style.cursor = ""));
      map.on("mouseenter", "unclustered-point", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "unclustered-point", () => (map.getCanvas().style.cursor = ""));
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
      retintParchment(map, currentStyleKey);
    } catch (err) {
      if (attempt < 30) setTimeout(() => trySetupPinLayers(attempt + 1), 400);
      else console.error("Giving up on map pin layers:", err);
    }
  }
  map.on("styledata", () => trySetupPinLayers());
  trySetupPinLayers();

  // Bound once, unconditionally — not nested inside setupPinLayers' "only
  // the first successful run" guard, so it can never end up unregistered
  // if that guard's timing ever changes. queryRenderedFeatures against
  // layers that don't exist yet just returns empty, so this is safe to
  // bind before the pin layers have actually been added.
  map.on("click", (e) => {
    const [feature] = map.queryRenderedFeatures(e.point, { layers: ["clusters", "unclustered-point"] });
    if (!feature) return;
    if (feature.layer.id === "clusters") {
      const clusterId = feature.properties.cluster_id;
      const coords = feature.geometry.coordinates.slice();
      const source = map.getSource("pins");
      if (!source) return;
      source.getClusterExpansionZoom(clusterId, (err, zoom) => {
        // Fall back to a fixed zoom-in step if the exact expansion zoom
        // can't be computed, so a click always visibly does something —
        // worst case it takes one extra click to fully split a cluster.
        map.easeTo({ center: coords, zoom: err ? map.getZoom() + 2.5 : zoom });
      });
    } else {
      openPinPopup(feature.properties.id, feature.geometry.coordinates.slice());
    }
  });

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
      const signedUrl = await getSignedUrl(photo.storage_path);
      const placeholder = el.querySelector(".map-pin-popup-thumb");
      if (signedUrl && placeholder) {
        const img = document.createElement("img");
        img.className = "map-pin-popup-thumb";
        img.src = signedUrl;
        placeholder.replaceWith(img);
      }
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // pinsById is already populated by the loadPins() call above — no need
  // to wait on map's "load" event (unreliable in some environments, see
  // trySetupPinLayers above) just to fly the camera and drop a popup,
  // neither of which touch the custom pin layers it gates.
  if (focusPinId) {
    const pin = pinsById[focusPinId];
    if (pin) {
      map.flyTo({ center: [pin.lng, pin.lat], zoom: 15 });
      openPinPopup(focusPinId, [pin.lng, pin.lat]);
    }
  }

  // Geolocate — triggers the hidden GeolocateControl above, which both
  // flies to the user's position and (with trackUserLocation on) starts
  // the live-updating blue dot.
  document.getElementById("geolocateBtn").addEventListener("click", () => {
    geolocateControl.trigger();
  });
  // Blue dot shows up right away on a normal map visit, without waiting for
  // a manual tap on the 📍 button — matching Google/Apple Maps (this also
  // triggers the permission prompt itself on a first-time visitor, same as
  // tapping the button would). Skipped when landing on a specific pin or in
  // reposition mode, so it doesn't fight that deliberate camera target.
  if (!focusPinId && !repositionPinId) {
    geolocateControl.trigger();
  }

  // Map options menu — Map (style), Accounts, Tag, each an accordion
  // section within the one 3-dot dropdown.
  const menuBtn = document.getElementById("mapMenuBtn");
  const menuDropdown = document.getElementById("mapMenuDropdown");
  menuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    menuDropdown.style.display = menuDropdown.style.display === "none" ? "flex" : "none";
  });
  menuDropdown?.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => {
    if (menuDropdown) menuDropdown.style.display = "none";
  });
  document.querySelectorAll(".map-filter-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sub = document.getElementById(btn.dataset.submenu);
      const wasOpen = sub.classList.contains("open");
      document.querySelectorAll(".map-filter-submenu").forEach((s) => s.classList.remove("open"));
      if (!wasOpen) sub.classList.add("open");
    });
  });

  function markSelectedStyle() {
    document.querySelectorAll("[data-map-style]").forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.mapStyle === currentStyleKey);
    });
  }
  markSelectedStyle();
  document.querySelectorAll("[data-map-style]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.mapStyle;
      if (key !== currentStyleKey) {
        currentStyleKey = key;
        localStorage.setItem(STYLE_KEY, key);
        map.setStyle(STYLES[key]);
        markSelectedStyle();
      }
      menuDropdown.style.display = "none";
    });
  });

  // Accounts filter — buttons that toggle a "selected" state (checkmark),
  // not native checkboxes, so they can share the same icon+label layout
  // as the Map submenu.
  document.querySelectorAll("[data-account-filter]").forEach((btn) => {
    btn.classList.toggle("selected", filterState.accounts.has(btn.dataset.accountFilter));
    btn.addEventListener("click", () => {
      const key = btn.dataset.accountFilter;
      const nowSelected = !filterState.accounts.has(key);
      if (nowSelected) filterState.accounts.add(key);
      else filterState.accounts.delete(key);
      btn.classList.toggle("selected", nowSelected);
      saveFilterState();
      applyFilters();
    });
  });

  // Tag filter — built from the same tag list pins are created with,
  // everything on by default.
  const tagSub = document.getElementById("tagSub");
  if (tagSub) {
    tagSub.innerHTML = CATEGORIES.map(
      (tag) => `<button class="btn dropdown-item map-filter-option ${filterState.tags.has(tag) ? "selected" : ""}" data-tag-filter="${tag}" style="width:100%; text-align:left;"><span class="map-filter-check">✓</span><span>${tag}</span></button>`
    ).join("");
    tagSub.querySelectorAll("[data-tag-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.tagFilter;
        const nowSelected = !filterState.tags.has(key);
        if (nowSelected) filterState.tags.add(key);
        else filterState.tags.delete(key);
        btn.classList.toggle("selected", nowSelected);
        saveFilterState();
        applyFilters();
      });
    });
  }

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

    const repositionPin = pinsById[repositionPinId];
    document.getElementById("repositionLabel").textContent = repositionPin ? `Moving "${repositionPin.title}"` : "Move this pin";
    if (repositionPin) map.flyTo({ center: [repositionPin.lng, repositionPin.lat], zoom: 15 });

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
