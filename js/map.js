import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { openPinForm } from "./pinForm.js";
import { openPinDetail } from "./pinDetailModal.js";
import { searchPlace } from "./geo.js";

const PIN_COLORS = {
  mine: "#b5651d", // accent
  friend: "#2f6fed", // blue
  other: "#2e8b57", // green
};

function coloredIcon(color) {
  const svg = `<svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg"><path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.3 21.7 0 14 0z" fill="${color}" stroke="#fff" stroke-width="1.5"/><circle cx="14" cy="14" r="5" fill="#fff"/></svg>`;
  return L.divIcon({
    className: "custom-pin-icon",
    html: svg,
    iconSize: [28, 40],
    iconAnchor: [14, 40],
    popupAnchor: [0, -36],
  });
}

const session = await requireSession();
if (session) {
  const params = new URLSearchParams(window.location.search);
  const focusPinId = params.get("focusPinId");
  const repositionPinId = params.get("repositionPinId");

  const map = L.map("map", { zoomControl: false }).setView([20, 0], 2);
  L.control.zoom({ position: "bottomright" }).addTo(map);

  // Remember where the map was pointed so switching tabs and coming back
  // (e.g. Discover -> a pin's map link -> Discover) leaves the map as you
  // left it, instead of resetting to the world view every time.
  const VIEW_KEY = "hg:mapView";
  map.on("moveend", () => {
    const c = map.getCenter();
    sessionStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
  });
  let restoredView = false;
  if (!focusPinId && !repositionPinId) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(VIEW_KEY) || "null");
      if (saved) {
        map.setView([saved.lat, saved.lng], saved.zoom);
        restoredView = true;
      }
    } catch {
      // ignore malformed saved state
    }
  }
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // Friend ids, to color markers by relationship to the pin's owner.
  const { data: accepted } = await supabase
    .from("friend_requests")
    .select("requester_id, recipient_id")
    .eq("status", "accepted")
    .or(`requester_id.eq.${session.user.id},recipient_id.eq.${session.user.id}`);
  const friendIds = new Set(
    (accepted || []).map((r) => (r.requester_id === session.user.id ? r.recipient_id : r.requester_id))
  );

  let markers = {}; // pinId -> marker
  let pinsById = {};
  function clearMarkers() {
    Object.values(markers).forEach((m) => map.removeLayer(m));
    markers = {};
  }

  async function loadPins() {
    const { data: pins, error } = await supabase
      .from("pins")
      .select("id, title, category, lat, lng, visibility, owner_id");
    if (error) {
      console.error(error);
      return;
    }
    clearMarkers();
    pinsById = {};
    for (const pin of pins) {
      pinsById[pin.id] = pin;
      const isMine = pin.owner_id === session.user.id;
      const color = isMine ? PIN_COLORS.mine : friendIds.has(pin.owner_id) ? PIN_COLORS.friend : PIN_COLORS.other;
      const marker = L.marker([pin.lat, pin.lng], { icon: coloredIcon(color) }).addTo(map);
      marker.bindPopup(
        `
        <div class="map-pin-popup row" data-pin-id="${pin.id}">
          <div style="flex:1; min-width:0;">
            <strong>${escapeHtml(pin.title)}</strong>
            <div class="muted" style="font-size:0.8rem;">${escapeHtml(pin.category || "")}</div>
          </div>
          <img class="map-pin-popup-thumb" style="display:none;" />
        </div>
      `,
        { closeButton: false, maxWidth: 420, minWidth: 140 }
      );
      markers[pin.id] = marker;
    }
  }
  await loadPins();

  map.on("popupopen", async (e) => {
    const el = e.popup.getElement()?.querySelector(".map-pin-popup");
    if (!el) return;
    const pinId = el.dataset.pinId;

    el.addEventListener("click", () => {
      markers[pinId]?.closePopup();
      openPinDetail(pinId, { onChange: loadPins });
    });

    const { data: photo } = await supabase
      .from("pin_photos")
      .select("storage_path")
      .eq("pin_id", pinId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (photo) {
      const { data } = await supabase.storage.from("media").createSignedUrl(photo.storage_path, 3600);
      const img = el.querySelector(".map-pin-popup-thumb");
      if (data?.signedUrl && img) {
        img.src = data.signedUrl;
        img.style.display = "block";
      }
    }
  });

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  if (focusPinId && markers[focusPinId]) {
    map.setView(markers[focusPinId].getLatLng(), 15);
    markers[focusPinId].openPopup();
  }

  // Geolocate
  document.getElementById("geolocateBtn").addEventListener("click", () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 14),
      () => alert("Couldn't get your location.")
    );
  });
  if (!focusPinId && !repositionPinId && !restoredView) navigator.geolocation?.getCurrentPosition(
    (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 12),
    () => {} // silently fall back to world view
  );

  // Hold anywhere on the map to drop a new pin there. Pointer Events unify
  // mouse + touch; detection lives on the map's own DOM container rather
  // than Leaflet's event system so a real long-press (minimal movement,
  // held ~550ms) is unambiguous from a pan/drag.
  const mapContainer = map.getContainer();
  let pressStart = null;
  let pressTimer = null;
  let pressFired = false;

  mapContainer.addEventListener("pointerdown", (e) => {
    if (repositionPinId) return;
    if (e.target.closest(".leaflet-popup, .leaflet-marker-icon, .leaflet-control")) return;
    pressStart = { x: e.clientX, y: e.clientY };
    pressFired = false;
    pressTimer = setTimeout(() => {
      pressFired = true;
      const rect = mapContainer.getBoundingClientRect();
      const point = L.point(pressStart.x - rect.left, pressStart.y - rect.top);
      const latlng = map.containerPointToLatLng(point);
      openPinForm({ lat: latlng.lat, lng: latlng.lng, onSaved: loadPins });
    }, 550);
  });
  mapContainer.addEventListener("pointermove", (e) => {
    if (!pressStart) return;
    if (Math.abs(e.clientX - pressStart.x) > 10 || Math.abs(e.clientY - pressStart.y) > 10) {
      clearTimeout(pressTimer);
    }
  });
  ["pointerup", "pointercancel"].forEach((evt) =>
    mapContainer.addEventListener(evt, () => {
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
      if (results[0]) map.setView([results[0].lat, results[0].lng], 13);
    } catch (err) {
      console.error(err);
    }
  });

  // Reposition mode — reached via "Change location on map" when editing a
  // pin. Shows a fixed center-pin overlay (map pans underneath it) instead
  // of the old in-form draggable picker.
  if (repositionPinId) {
    document.getElementById("holdHint").style.display = "none";
    const banner = document.getElementById("repositionBanner");
    const markerOverlay = document.getElementById("repositionMarker");
    const pin = pinsById[repositionPinId];
    banner.style.display = "flex";
    markerOverlay.style.display = "block";
    document.getElementById("repositionLabel").textContent = pin ? `Moving "${pin.title}"` : "Move this pin";
    if (pin) map.setView([pin.lat, pin.lng], 15);

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
