import { supabase } from "./supabaseClient.js";
import { cropImageToAspect } from "./imageCrop.js";

const MAX_PHOTOS = 3;
const CATEGORIES = ["Camping", "Hiking", "Urban Exploring", "Cliff Jumping", "Roof", "Beach"];

async function ensureLeaflet() {
  if (window.L) return;
  if (!document.querySelector("link[data-leaflet]")) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    link.setAttribute("data-leaflet", "1");
    document.head.appendChild(link);
  }
  if (!document.querySelector("script[data-leaflet]")) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.setAttribute("data-leaflet", "1");
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
}

function locationIcon() {
  const svg = `<svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg"><path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.3 21.7 0 14 0z" fill="#b5651d" stroke="#fff" stroke-width="1.5"/><circle cx="14" cy="14" r="5" fill="#fff"/></svg>`;
  return L.divIcon({ className: "custom-pin-icon", html: svg, iconSize: [28, 40], iconAnchor: [14, 40] });
}

// A small map + editable coordinate fields live inside the form, kept in
// sync both ways: click the map to set the marker (fills the coordinate
// inputs), or type coordinates directly (moves the marker).
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
          <label class="field-label">Location</label>
          <div id="pinLocationMap" style="height:180px; border-radius: var(--radius); overflow:hidden;"></div>
          <div class="row" style="margin-top:0.5rem;">
            <input id="pinLat" type="number" step="any" placeholder="Latitude" value="${pinLat}" />
            <input id="pinLng" type="number" step="any" placeholder="Longitude" value="${pinLng}" />
          </div>
        </div>

        <div>
          <label class="field-label">Photos (up to ${MAX_PHOTOS} — first one is the cover photo)</label>
          <div id="pinPhotoPreviews" class="photo-grid" style="margin-bottom:0.5rem;"></div>
          <label class="btn" style="display:block; text-align:center;">
            Choose photos
            <input id="pinPhotosInput" type="file" accept="image/*" multiple style="display:none;" />
          </label>
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

  // Embedded location picker — click the map or type coordinates, either
  // one updates the other.
  const latInput = backdrop.querySelector("#pinLat");
  const lngInput = backdrop.querySelector("#pinLng");
  await ensureLeaflet();
  const miniMap = L.map(backdrop.querySelector("#pinLocationMap"), { zoomControl: false }).setView([pinLat, pinLng], 14);
  L.control.zoom({ position: "bottomright" }).addTo(miniMap);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "" }).addTo(miniMap);
  let marker = L.marker([pinLat, pinLng], { icon: locationIcon() }).addTo(miniMap);
  setTimeout(() => miniMap.invalidateSize(), 0);

  miniMap.on("click", (e) => {
    pinLat = e.latlng.lat;
    pinLng = e.latlng.lng;
    marker.setLatLng(e.latlng);
    latInput.value = pinLat.toFixed(6);
    lngInput.value = pinLng.toFixed(6);
  });
  function syncFromInputs() {
    const lat = parseFloat(latInput.value);
    const lng = parseFloat(lngInput.value);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      pinLat = lat;
      pinLng = lng;
      marker.setLatLng([lat, lng]);
      miniMap.setView([lat, lng]);
    }
  }
  latInput.addEventListener("change", syncFromInputs);
  lngInput.addEventListener("change", syncFromInputs);

  // Photo selection with removable previews, capped at MAX_PHOTOS total.
  // Every newly-added photo is cropped to a fixed aspect ratio first so all
  // posts share the same framing.
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

    if (previewsEl.firstElementChild) {
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
