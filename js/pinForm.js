import { supabase } from "./supabaseClient.js";
import { cropImageToAspect } from "./imageCrop.js";
import { setupSheetDrag } from "./sheetDrag.js";
import { STYLES, ensureMapLibre, retintParchment, tryAddClusterLayers } from "./mapStyles.js";

const MAX_PHOTOS = 3;
const CATEGORIES = ["Camping", "Hiking", "Urban Exploring", "Cliff Jumping", "Roof", "Beach"];
const PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const MAP_STYLE_KEY = "hg:mapStyle"; // shared with js/map.js — one preference across the app

// The location-picker marker (the pin being placed/edited) — same
// orange-flag artwork as before, just as a plain DOM element for
// maplibregl.Marker instead of a Leaflet divIcon.
function locationMarkerEl() {
  const wrap = document.createElement("div");
  wrap.innerHTML = `<svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg"><path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.3 21.7 0 14 0z" fill="#b5651d" stroke="#fff" stroke-width="1.5"/><circle cx="14" cy="14" r="5" fill="#fff"/></svg>`;
  const el = wrap.firstElementChild;
  el.style.cursor = "grab";
  return el;
}

// Half-screen popup (drag handle, defaults to fullscreen since there's a
// lot to fill in) — a small map + editable coordinate fields live inside
// the form, kept in sync both ways: click the map to set the marker
// (fills the coordinate inputs), or type coordinates directly (moves the
// marker).
export async function openPinForm({ lat, lng, editingPin, onSaved }) {
  const isEdit = !!editingPin;
  let pinLat, pinLng;

  if (isEdit) {
    pinLat = editingPin.lat;
    pinLng = editingPin.lng;
  } else if (lat != null && lng != null) {
    pinLat = lat;
    pinLng = lng;
  } else if (navigator.geolocation) {
    const pos = await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve(p),
        () => resolve(null)
      );
    });
    pinLat = pos?.coords.latitude ?? 0;
    pinLng = pos?.coords.longitude ?? 0;
  } else {
    pinLat = 0;
    pinLng = 0;
  }

  let existingPhotos = [];
  if (isEdit) {
    const { data } = await supabase.from("pin_photos").select("id, storage_path, created_at").eq("pin_id", editingPin.id).order("created_at", { ascending: true });
    existingPhotos = data || [];
  }
  let removedPhotoIds = [];

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal pin-detail-modal pin-form-modal stack">
      <div class="post-header">
        <strong class="post-title">${isEdit ? "Edit pin" : "New pin"}</strong>
        <div class="post-header-center"><span class="post-drag-handle" aria-hidden="true"></span></div>
        <div class="post-header-end"><button class="post-close-btn" aria-label="Close">✕</button></div>
      </div>
      <form id="pinForm" class="pin-form-body stack">
        <div>
          <label class="field-label" for="pinTitle">Name</label>
          <input id="pinTitle" required maxlength="25" value="${attr(editingPin?.title)}" />
        </div>

        <div>
          <label class="field-label">Photos (up to ${MAX_PHOTOS} — first one is the cover photo)</label>
          <div id="pinPhotoPreviews" class="photo-grid"></div>
          <input id="pinPhotosInput" type="file" accept="image/*" multiple style="display:none;" />
        </div>

        <div>
          <label class="field-label" for="pinDescription">Description</label>
          <textarea id="pinDescription" rows="2">${escapeHtml(editingPin?.description)}</textarea>
        </div>
        <div>
          <label class="field-label" for="pinDirections">How to get there</label>
          <textarea id="pinDirections" rows="2">${escapeHtml(editingPin?.directions)}</textarea>
        </div>
        <div>
          <label class="field-label" for="pinCategory">Category</label>
          <select id="pinCategory" required>
            <option value="">Choose a category…</option>
            ${CATEGORIES.map((c) => `<option value="${c}" ${editingPin?.category === c ? "selected" : ""}>${c}</option>`).join("")}
          </select>
        </div>

        <div>
          <label class="field-label">Location</label>
          <div style="position:relative; height:240px; border-radius: var(--radius); overflow:hidden;">
            <div id="pinLocationMap" style="height:100%;"></div>
            <div style="position:absolute; top:0.5rem; right:0.5rem; z-index:1;">
              <button type="button" id="pinMapStyleBtn" class="btn" style="padding:0.35rem 0.5rem;">🗺️</button>
              <div id="pinMapStyleDropdown" class="card stack" style="display:none; position:absolute; right:0; top:110%; z-index:1; min-width:120px; padding:0.4rem; gap:0.25rem;">
                <button type="button" class="btn" data-pin-map-style="street" style="width:100%; text-align:left; border:none;">Street</button>
                <button type="button" class="btn" data-pin-map-style="satellite" style="width:100%; text-align:left; border:none;">Satellite</button>
                <button type="button" class="btn" data-pin-map-style="parchment" style="width:100%; text-align:left; border:none;">Parchment</button>
              </div>
            </div>
          </div>
          <div class="row" style="margin-top:0.5rem;">
            <input id="pinLat" type="number" step="any" placeholder="Latitude" value="${pinLat}" />
            <input id="pinLng" type="number" step="any" placeholder="Longitude" value="${pinLng}" />
          </div>
        </div>

        <label class="row">
          <input type="checkbox" id="pinPrivate" style="width:auto;" ${editingPin?.visibility === "private" ? "checked" : ""} />
          <span>Make this pin private</span>
        </label>

        <p class="error-text" id="pinFormError" style="display:none;"></p>
        <p class="muted" id="pinFormShareLink" style="display:none; word-break:break-all;"></p>
      </form>
      <div class="row pin-form-footer">
        <button type="button" id="pinCancelBtn" class="btn" style="flex:1;">Cancel</button>
        <button type="submit" form="pinForm" class="btn btn-primary" style="flex:1;">${isEdit ? "Save changes" : "Save pin"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const modalEl = backdrop.querySelector(".pin-form-modal");

  // miniMap is created further down, once MapLibre has loaded — closing
  // early (e.g. Cancel clicked mid-load) just skips disposing it since
  // there'd be nothing to dispose yet.
  const close = () => {
    miniMap?.remove();
    backdrop.remove();
  };
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  modalEl.querySelector(".post-close-btn").addEventListener("click", close);
  backdrop.querySelector("#pinCancelBtn").addEventListener("click", close);
  setupSheetDrag(modalEl, { onDismiss: close, startFull: true });

  // Embedded location picker — click the map or type coordinates, either
  // one updates the other.
  const latInput = backdrop.querySelector("#pinLat");
  const lngInput = backdrop.querySelector("#pinLng");
  await ensureMapLibre();
  let miniMapStyleKey = localStorage.getItem(MAP_STYLE_KEY) || "parchment";
  if (!STYLES[miniMapStyleKey]) miniMapStyleKey = "parchment";
  const miniMap = new maplibregl.Map({
    container: backdrop.querySelector("#pinLocationMap"),
    style: STYLES[miniMapStyleKey],
    center: [pinLng, pinLat],
    zoom: 13,
    attributionControl: { compact: true },
  });
  miniMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  const marker = new maplibregl.Marker({ element: locationMarkerEl(), anchor: "bottom", draggable: true })
    .setLngLat([pinLng, pinLat])
    .addTo(miniMap);

  // Existing pins rendered as clustered context (same look as the main
  // map) so it's easy to see where your other pins already are while
  // placing a new one — not clickable here, since clicking the map places
  // the pin instead.
  const { data: contextPins } = await supabase.from("pins").select("id, lat, lng").neq("id", editingPin?.id || "");
  const contextFeatures = (contextPins || []).map((p) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    properties: {},
  }));
  function addContextPinLayers() {
    tryAddClusterLayers(miniMap, { sourceId: "pin-form-pins", color: "#8a7f6a", features: contextFeatures });
  }
  miniMap.on("styledata", () => {
    addContextPinLayers();
    retintParchment(miniMap, miniMapStyleKey);
  });
  addContextPinLayers();

  function setMarkerPosition(lat, lng, { flyTo = false } = {}) {
    pinLat = lat;
    pinLng = lng;
    marker.setLngLat([lng, lat]);
    latInput.value = lat.toFixed(6);
    lngInput.value = lng.toFixed(6);
    if (flyTo) miniMap.flyTo({ center: [lng, lat] });
  }

  miniMap.on("click", (e) => setMarkerPosition(e.lngLat.lat, e.lngLat.lng));
  marker.on("dragend", () => {
    const { lat, lng } = marker.getLngLat();
    setMarkerPosition(lat, lng);
  });
  function syncFromInputs() {
    const lat = parseFloat(latInput.value);
    const lng = parseFloat(lngInput.value);
    if (Number.isFinite(lat) && Number.isFinite(lng)) setMarkerPosition(lat, lng, { flyTo: true });
  }
  latInput.addEventListener("change", syncFromInputs);
  lngInput.addEventListener("change", syncFromInputs);

  // Style switcher — same three styles/preference key as the main map.
  const miniStyleBtn = backdrop.querySelector("#pinMapStyleBtn");
  const miniStyleDropdown = backdrop.querySelector("#pinMapStyleDropdown");
  miniStyleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    miniStyleDropdown.style.display = miniStyleDropdown.style.display === "none" ? "flex" : "none";
  });
  document.addEventListener("click", () => {
    miniStyleDropdown.style.display = "none";
  });
  miniStyleDropdown.querySelectorAll("[data-pin-map-style]").forEach((btn) => {
    btn.addEventListener("click", () => {
      miniStyleDropdown.style.display = "none";
      const key = btn.dataset.pinMapStyle;
      if (key === miniMapStyleKey) return;
      miniMapStyleKey = key;
      localStorage.setItem(MAP_STYLE_KEY, key);
      miniMap.setStyle(STYLES[key]);
    });
  });

  // Easter egg: typing "wowza" as the pin name auto-picks a random category.
  const titleInput = backdrop.querySelector("#pinTitle");
  const categorySelect = backdrop.querySelector("#pinCategory");
  titleInput.addEventListener("input", () => {
    if (titleInput.value.trim().toLowerCase() === "wowza") {
      categorySelect.value = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
    }
  });

  // Photo selection with removable previews, capped at MAX_PHOTOS total.
  // Every newly-added photo is cropped to a fixed aspect ratio first so all
  // posts share the same framing. The add tile itself is just the next
  // empty slot in the grid — it advances forward as photos are added and
  // disappears once the cap is reached.
  let photoFiles = [];
  const photosInput = backdrop.querySelector("#pinPhotosInput");
  const previewsEl = backdrop.querySelector("#pinPhotoPreviews");

  function slotsUsed() {
    return existingPhotos.length + photoFiles.length;
  }

  async function addFiles(fileList) {
    const incoming = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
    for (const file of incoming) {
      if (slotsUsed() >= MAX_PHOTOS) {
        alert(`You can add up to ${MAX_PHOTOS} photos.`);
        break;
      }
      const cropped = await cropImageToAspect(file);
      if (cropped) {
        photoFiles.push(cropped);
        await renderPreviews();
      }
    }
  }

  async function renderPreviews() {
    previewsEl.innerHTML = "";

    for (const photo of existingPhotos) {
      const wrap = document.createElement("div");
      wrap.style.position = "relative";
      const img = document.createElement("img");
      const { data } = await supabase.storage.from("media").createSignedUrl(photo.storage_path, 3600);
      img.src = data?.signedUrl || "";
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "×";
      removeBtn.style.cssText =
        "position:absolute; top:2px; right:2px; width:20px; height:20px; padding:0; line-height:1; border-radius:50%; background:rgba(0,0,0,0.6); color:#fff; border:none;";
      removeBtn.addEventListener("click", () => {
        removedPhotoIds.push(photo.id);
        existingPhotos = existingPhotos.filter((p) => p.id !== photo.id);
        renderPreviews();
      });
      wrap.appendChild(img);
      wrap.appendChild(removeBtn);
      previewsEl.appendChild(wrap);
    }

    photoFiles.forEach((file, i) => {
      const wrap = document.createElement("div");
      wrap.style.position = "relative";
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "×";
      removeBtn.style.cssText =
        "position:absolute; top:2px; right:2px; width:20px; height:20px; padding:0; line-height:1; border-radius:50%; background:rgba(0,0,0,0.6); color:#fff; border:none;";
      removeBtn.addEventListener("click", () => {
        photoFiles.splice(i, 1);
        renderPreviews();
      });
      wrap.appendChild(img);
      wrap.appendChild(removeBtn);
      previewsEl.appendChild(wrap);
    });

    if (slotsUsed() < MAX_PHOTOS) {
      const addTile = document.createElement("label");
      addTile.className = "photo-add-tile";
      addTile.setAttribute("for", "pinPhotosInput");
      addTile.innerHTML = PLUS_ICON;
      previewsEl.appendChild(addTile);
    }

    if (previewsEl.firstElementChild && previewsEl.firstElementChild.tagName === "DIV") {
      const coverBadge = document.createElement("span");
      coverBadge.textContent = "cover";
      coverBadge.className = "pill";
      coverBadge.style.cssText = "position:absolute; bottom:2px; left:2px; background:var(--surface);";
      previewsEl.firstElementChild.appendChild(coverBadge);
    }
  }
  await renderPreviews();

  photosInput.addEventListener("change", async () => {
    await addFiles(photosInput.files);
    photosInput.value = "";
  });

  backdrop.querySelector("#pinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = backdrop.querySelector("#pinFormError");
    const shareEl = backdrop.querySelector("#pinFormShareLink");
    errorEl.style.display = "none";
    const submitBtn = modalEl.querySelector(".pin-form-footer button[type=submit]");
    submitBtn.disabled = true;

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const title = backdrop.querySelector("#pinTitle").value.trim();
      const description = backdrop.querySelector("#pinDescription").value.trim() || null;
      const directions = backdrop.querySelector("#pinDirections").value.trim() || null;
      const category = backdrop.querySelector("#pinCategory").value.trim() || null;
      const visibility = backdrop.querySelector("#pinPrivate").checked ? "private" : "public";

      let pin;
      if (isEdit) {
        const { data, error: updateError } = await supabase
          .from("pins")
          .update({ title, description, directions, category, visibility, lat: pinLat, lng: pinLng })
          .eq("id", editingPin.id)
          .select()
          .single();
        if (updateError) throw updateError;
        pin = data;

        for (const photoId of removedPhotoIds) {
          const photo = editingPin.id && (await supabase.from("pin_photos").select("storage_path").eq("id", photoId).single()).data;
          if (photo) await supabase.storage.from("media").remove([photo.storage_path]);
          await supabase.from("pin_photos").delete().eq("id", photoId);
        }
      } else {
        const { data, error: insertError } = await supabase
          .from("pins")
          .insert({ owner_id: user.id, title, description, directions, category, lat: pinLat, lng: pinLng, visibility })
          .select()
          .single();
        if (insertError) throw insertError;
        pin = data;
      }

      for (const file of photoFiles) {
        const path = `pins/${pin.id}/${Date.now()}-${file.name}`;
        const { error: uploadError } = await supabase.storage.from("media").upload(path, file);
        if (uploadError) throw uploadError;
        await supabase.from("pin_photos").insert({ pin_id: pin.id, storage_path: path });
      }

      if (!isEdit) {
        const { data: invite } = await supabase
          .from("pin_invites")
          .insert({ pin_id: pin.id, inviter_id: user.id })
          .select()
          .single();
        if (invite) {
          shareEl.textContent = `Share link: ${window.location.origin}/invite.html?token=${invite.token}`;
          shareEl.style.display = "block";
        }
        onSaved?.(pin);
        setTimeout(close, invite ? 1800 : 0);
      } else {
        onSaved?.(pin);
        close();
      }
    } catch (err) {
      errorEl.textContent = err.message || "Couldn't save that pin.";
      errorEl.style.display = "block";
      submitBtn.disabled = false;
    }
  });
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function attr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}
