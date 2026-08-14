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
          <div id="pinPhotoDropzone" class="stack" style="border:2px dashed var(--border); border-radius: var(--radius); padding:0.75rem; text-align:center;">
            <input id="pinPhotosInput" type="file" accept="image/*" multiple />
            <p class="muted" style="margin:0; font-size:0.8rem;" id="pinDropHint"></p>
            <button type="button" id="pinChooseExistingBtn" class="btn">Choose from your photos</button>
          </div>
          <div id="pinExistingPicker" class="stack" style="display:none; margin-top:0.5rem;">
            <div id="pinExistingPickerGrid" class="photo-grid"></div>
            <div class="row">
              <button type="button" id="pinExistingPickerCancel" class="btn" style="flex:1;">Cancel</button>
              <button type="button" id="pinExistingPickerAdd" class="btn btn-primary" style="flex:1;">Add selected</button>
            </div>
          </div>
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
  // (existing photos, minus any removed, plus newly added ones, plus any
  // reused from the user's other pins).
  let photoFiles = [];
  let reusedPhotoPaths = []; // storage paths picked from "Choose from your photos"
  const photosInput = backdrop.querySelector("#pinPhotosInput");
  const previewsEl = backdrop.querySelector("#pinPhotoPreviews");
  const dropzone = backdrop.querySelector("#pinPhotoDropzone");
  const dropHint = backdrop.querySelector("#pinDropHint");
  if (document.documentElement.classList.contains("is-desktop-device")) {
    dropHint.textContent = "Drag photos here, or:";
  }

  function slotsUsed() {
    return existingPhotos.length + photoFiles.length + reusedPhotoPaths.length;
  }

  function addFiles(fileList) {
    const incoming = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
    const room = MAX_PHOTOS - slotsUsed();
    if (incoming.length > room) {
      alert(`You can add up to ${MAX_PHOTOS} photos — only the first ${Math.max(room, 0)} of your new selection were added.`);
    }
    photoFiles = photoFiles.concat(incoming.slice(0, Math.max(room, 0)));
    renderPreviews();
  }

  ["dragover", "dragenter"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.style.borderColor = "var(--accent)";
    })
  );
  ["dragleave", "dragend"].forEach((evt) =>
    dropzone.addEventListener(evt, () => {
      dropzone.style.borderColor = "var(--border)";
    })
  );
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.style.borderColor = "var(--border)";
    addFiles(e.dataTransfer?.files);
  });

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

    for (const path of reusedPhotoPaths) {
      const wrap = document.createElement("div");
      wrap.style.position = "relative";
      const img = document.createElement("img");
      const { data } = await supabase.storage.from("media").createSignedUrl(path, 3600);
      img.src = data?.signedUrl || "";
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "×";
      removeBtn.style.cssText =
        "position:absolute; top:2px; right:2px; width:20px; height:20px; padding:0; line-height:1; border-radius:50%; background:rgba(0,0,0,0.6); color:#fff; border:none;";
      removeBtn.addEventListener("click", () => {
        reusedPhotoPaths = reusedPhotoPaths.filter((p) => p !== path);
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
    addFiles(photosInput.files);
    photosInput.value = "";
  });

  // "Choose from your photos" — reuse a photo already uploaded to one of
  // your other pins, without re-uploading it from your device.
  const chooseExistingBtn = backdrop.querySelector("#pinChooseExistingBtn");
  const existingPicker = backdrop.querySelector("#pinExistingPicker");
  const existingPickerGrid = backdrop.querySelector("#pinExistingPickerGrid");
  let pickerSelected = new Set();

  chooseExistingBtn.addEventListener("click", async () => {
    existingPicker.style.display = existingPicker.style.display === "none" ? "flex" : "none";
    if (existingPicker.style.display === "none") return;

    existingPickerGrid.innerHTML = '<p class="muted">Loading…</p>';
    pickerSelected = new Set();

    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data: myPhotos } = await supabase
      .from("pin_photos")
      .select("id, storage_path, pins!inner(owner_id)")
      .eq("pins.owner_id", user.id)
      .order("created_at", { ascending: false })
      .limit(30);

    if (!myPhotos?.length) {
      existingPickerGrid.innerHTML = '<p class="muted">You haven\'t uploaded any photos yet.</p>';
      return;
    }

    const { data: signed } = await supabase.storage.from("media").createSignedUrls(
      myPhotos.map((p) => p.storage_path),
      3600
    );
    const signedByPath = {};
    (signed || []).forEach((s) => (signedByPath[s.path] = s.signedUrl));

    existingPickerGrid.innerHTML = "";
    myPhotos.forEach((photo) => {
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:relative; cursor:pointer; border-radius:8px; overflow:hidden;";
      const img = document.createElement("img");
      img.src = signedByPath[photo.storage_path] || "";
      img.style.cssText = "width:100%; aspect-ratio:1; object-fit:cover; display:block;";
      wrap.appendChild(img);
      wrap.addEventListener("click", () => {
        if (pickerSelected.has(photo.storage_path)) {
          pickerSelected.delete(photo.storage_path);
          wrap.style.outline = "none";
        } else {
          pickerSelected.add(photo.storage_path);
          wrap.style.outline = "3px solid var(--accent)";
        }
      });
      existingPickerGrid.appendChild(wrap);
    });
  });

  backdrop.querySelector("#pinExistingPickerCancel").addEventListener("click", () => {
    existingPicker.style.display = "none";
  });
  backdrop.querySelector("#pinExistingPickerAdd").addEventListener("click", () => {
    const room = MAX_PHOTOS - slotsUsed();
    const picked = Array.from(pickerSelected);
    if (picked.length > room) {
      alert(`You can add up to ${MAX_PHOTOS} photos — only the first ${Math.max(room, 0)} selected were added.`);
    }
    reusedPhotoPaths = reusedPhotoPaths.concat(picked.slice(0, Math.max(room, 0)));
    existingPicker.style.display = "none";
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

      // Reused photos are copied server-side into this pin's own storage
      // path rather than re-uploaded — cheap, and keeps storage RLS (which
      // is scoped by the pin id embedded in the path) correctly matching
      // *this* pin's own visibility instead of the pin the photo came from.
      for (let i = 0; i < reusedPhotoPaths.length; i++) {
        const ext = reusedPhotoPaths[i].split(".").pop();
        const newPath = `pins/${pin.id}/${Date.now()}-reused-${i}.${ext}`;
        const { error: copyError } = await supabase.storage.from("media").copy(reusedPhotoPaths[i], newPath);
        if (copyError) throw copyError;
        await supabase.from("pin_photos").insert({ pin_id: pin.id, storage_path: newPath });
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
