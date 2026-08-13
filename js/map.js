import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { openPinForm } from "./pinForm.js";
import { searchPlace } from "./geo.js";

const session = await requireSession();
if (session) {
  const map = L.map("map", { zoomControl: false }).setView([20, 0], 2);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  let markers = [];
  function clearMarkers() {
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
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
    for (const pin of pins) {
      const isMine = pin.owner_id === session.user.id;
      const marker = L.marker([pin.lat, pin.lng]).addTo(map);
      marker.bindPopup(
        `<strong>${escapeHtml(pin.title)}</strong><br/>
         <span class="muted">${escapeHtml(pin.category || "")}</span><br/>
         ${isMine ? '<span class="pill">yours</span>' : ""} ${pin.visibility === "public" ? '<span class="pill">public</span>' : ""}<br/>
         <a href="pin.html?id=${pin.id}">View pin →</a>`
      );
      markers.push(marker);
    }
  }
  await loadPins();

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Geolocate
  document.getElementById("geolocateBtn").addEventListener("click", () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 14),
      () => alert("Couldn't get your location.")
    );
  });
  navigator.geolocation?.getCurrentPosition(
    (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 12),
    () => {} // silently fall back to world view
  );

  // Tap-to-drop-pin mode
  let addingPin = false;
  const addPinBtn = document.getElementById("addPinBtn");
  addPinBtn.addEventListener("click", () => {
    addingPin = !addingPin;
    addPinBtn.classList.toggle("btn-primary", addingPin);
    addPinBtn.textContent = addingPin ? "Tap the map to place your pin…" : "+ Add pin";
  });
  map.on("click", (e) => {
    if (!addingPin) return;
    addingPin = false;
    addPinBtn.classList.remove("btn-primary");
    addPinBtn.textContent = "+ Add pin";
    openPinForm({
      lat: e.latlng.lat,
      lng: e.latlng.lng,
      onSaved: loadPins,
    });
  });

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
}
