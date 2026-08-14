import { supabase } from "./supabaseClient.js";

const MAX_PHOTOS = 5;
const CATEGORIES = ["Camping", "Hiking", "Urban Exploring", "Cliff Jumping", "Roof", "Beach"];

function ensureLeaflet() {
  if (window.L) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    css.integrity = "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=";
    css.crossOrigin = "";
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.integrity = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
    script.crossOrigin = "";
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

export async function openPinForm({ lat, lng, editingPin, onSaved }) {
  await ensureLeaflet();

  const isEdit = !!editingPin;
  const startLat = editingPin?.lat ?? lat;
  const startLng = editingPin?.lng ?? lng;

  let existingPhotos = [];
  if (isEdit) {
    const { data } = await supabase.from("pin_photos").select("id, storage_path, created_at").eq("pin_id", editingPin.id).order("created_at", { ascending: true });
    existingPhotos = data || [];
  }
  let removedPhotoIds = [];

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal stack">
      <h2 style="margin:0;">${isEdit ? "Edit pin" : "New pin"}</h2>
      <form id="pinForm" class="stack">
        <div>
          <label class="field-label" for="pinTitle">Name</label>
          <input id="pinTitle" required maxlength="120" value="${attr(editingPin?.title)}" />
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
          <select id="pinCategory">
            <option value="">Choose a category…</option>
            ${CATEGORIES.map((c) => `<option value="${c}" ${editingPin?.category === c ? "selected" : ""}>${c}</option>`).join("")}
          </select>
        </div>

        <div>
          <label class="field-label">Location — drag the map so the pin marks the spot</label>
          <div class="pin-location-picker">
            <div id="pinLocationMap"></div>
            <div class="pin-location-marker">📍</div>
          </div>
        </div>

        <div>
          <label class="field-label">Photos (up to ${MAX_PHOTOS} — first one is the cover photo)</label>
          <div id="pinPhotoPreviews" class="photo-grid" style="margin-bottom:0.5rem;"></div>
          <input id="pinPhotosInput" type="file" accept="image/*" multiple />
        </div>

        <label class="row">
          <input type="checkbox" id="pinPrivate" style="width:auto;" ${editingPin?.visibility === "private" ? "checked" : ""} />
          <span>Make this pin private</span>
        </label>

        <p class="error-text" id="pinFormError" style="display:none;"></p>
        <p class="muted" id="pinFormShareLink" style="display:none; word-break:break-all;"></p>

        <div class="row">
          <button type="button" id="pinCancelBtn" class="btn" style="flex:1;">Cancel</button>
          <button type="submit" class="btn btn-primary" style="flex:1;">${isEdit ? "Save changes" : "Save pin"}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("#pinCancelBtn").addEventListener("click", close);

  // Location picker: a fixed center-pin overlay, map pans underneath it —
  // the chosen location is always whatever's under the pin (map center).
  const mapEl = backdrop.querySelector("#pinLocationMap");
  const pickerMap = L.map(mapEl, { zoomControl: false }).setView([startLat ?? 20, startLng ?? 0], startLat != null ? 15 : 2);
  L.control.zoom({ position: "bottomright" }).addTo(pickerMap);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(pickerMap);
  setTimeout(() => pickerMap.invalidateSize(), 50);

  if (startLat == null && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => pickerMap.setView([pos.coords.latitude, pos.coords.longitude], 14),
      () => {}
    );
  }

  // New photo selection with removable previews, capped at MAX_PHOTOS total
  // (existing photos, minus any removed, plus newly added ones).
  let photoFiles = [];
  const photosInput = backdrop.querySelector("#pinPhotosInput");
  const previewsEl = backdrop.querySelector("#pinPhotoPreviews");

  function slotsUsed() {
    return existingPhotos.length + photoFiles.length;
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

    if (previewsEl.firstElementChild) {
      const coverBadge = document.createElement("span");
      coverBadge.textContent = "cover";
      coverBadge.className = "pill";
      coverBadge.style.cssText = "position:absolute; bottom:2px; left:2px; background:var(--surface);";
      previewsEl.firstElementChild.appendChild(coverBadge);
    }
  }
  await renderPreviews();

  photosInput.addEventListener("change", () => {
    const incoming = Array.from(photosInput.files || []);
    const room = MAX_PHOTOS - slotsUsed();
    if (incoming.length > room) {
      alert(`You can add up to ${MAX_PHOTOS} photos — only the first ${Math.max(room, 0)} of your new selection were added.`);
    }
    photoFiles = photoFiles.concat(incoming.slice(0, Math.max(room, 0)));
    photosInput.value = "";
    renderPreviews();
  });

  backdrop.querySelector("#pinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = backdrop.querySelector("#pinFormError");
    const shareEl = backdrop.querySelector("#pinFormShareLink");
    errorEl.style.display = "none";
    const submitBtn = e.target.querySelector("button[type=submit]");
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
      const center = pickerMap.getCenter();

      let pin;
      if (isEdit) {
        const { data, error: updateError } = await supabase
          .from("pins")
          .update({ title, description, directions, category, lat: center.lat, lng: center.lng, visibility })
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
          .insert({ owner_id: user.id, title, description, directions, category, lat: center.lat, lng: center.lng, visibility })
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
