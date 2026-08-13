import { supabase } from "./supabaseClient.js";

const MAX_PHOTOS = 5;

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

export async function openPinForm({ lat, lng, onSaved }) {
  await ensureLeaflet();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal stack">
      <h2 style="margin:0;">New pin</h2>
      <form id="pinForm" class="stack">
        <input id="pinTitle" placeholder="What's this place called?" required maxlength="120" />
        <textarea id="pinDescription" placeholder="What makes this spot worth finding?" rows="2"></textarea>
        <textarea id="pinDirections" placeholder="How do you get there?" rows="2"></textarea>
        <input id="pinCategory" placeholder="Category (viewpoint, waterfall, ruins…)" maxlength="60" />

        <div>
          <label class="muted" style="font-size:0.85rem;">Location — drag the map so the pin marks the spot</label>
          <div class="pin-location-picker">
            <div id="pinLocationMap"></div>
            <div class="pin-location-marker">📍</div>
          </div>
        </div>

        <div>
          <label class="muted" style="font-size:0.85rem;">Photos (up to ${MAX_PHOTOS} — first one is the cover photo)</label>
          <input id="pinPhotosInput" type="file" accept="image/*" multiple />
          <div id="pinPhotoPreviews" class="photo-grid" style="margin-top:0.5rem;"></div>
        </div>

        <label class="row">
          <input type="checkbox" id="pinPublic" style="width:auto;" />
          <span>Make this pin public</span>
        </label>

        <p class="error-text" id="pinFormError" style="display:none;"></p>
        <p class="muted" id="pinFormShareLink" style="display:none; word-break:break-all;"></p>

        <div class="row">
          <button type="button" id="pinCancelBtn" class="btn" style="flex:1;">Cancel</button>
          <button type="submit" class="btn btn-primary" style="flex:1;">Save pin</button>
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
  const pickerMap = L.map(mapEl, { zoomControl: false }).setView([lat ?? 20, lng ?? 0], lat != null ? 15 : 2);
  L.control.zoom({ position: "bottomright" }).addTo(pickerMap);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(pickerMap);
  setTimeout(() => pickerMap.invalidateSize(), 50);

  if (lat == null && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => pickerMap.setView([pos.coords.latitude, pos.coords.longitude], 14),
      () => {}
    );
  }

  // Photo selection with removable previews, capped at MAX_PHOTOS
  let photoFiles = [];
  const photosInput = backdrop.querySelector("#pinPhotosInput");
  const previewsEl = backdrop.querySelector("#pinPhotoPreviews");

  function renderPreviews() {
    previewsEl.innerHTML = "";
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
      if (i === 0) {
        const badge = document.createElement("span");
        badge.textContent = "cover";
        badge.className = "pill";
        badge.style.cssText = "position:absolute; bottom:2px; left:2px; background:var(--surface);";
        wrap.appendChild(badge);
      }
      previewsEl.appendChild(wrap);
    });
  }

  photosInput.addEventListener("change", () => {
    const incoming = Array.from(photosInput.files || []);
    const room = MAX_PHOTOS - photoFiles.length;
    if (incoming.length > room) {
      alert(`You can add up to ${MAX_PHOTOS} photos — only the first ${room} of your new selection were added.`);
    }
    photoFiles = photoFiles.concat(incoming.slice(0, room));
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
      const visibility = backdrop.querySelector("#pinPublic").checked ? "public" : "private";
      const center = pickerMap.getCenter();

      const { data: pin, error: insertError } = await supabase
        .from("pins")
        .insert({
          owner_id: user.id,
          title,
          description,
          directions,
          category,
          lat: center.lat,
          lng: center.lng,
          visibility,
        })
        .select()
        .single();
      if (insertError) throw insertError;

      for (const file of photoFiles) {
        const path = `pins/${pin.id}/${Date.now()}-${file.name}`;
        const { error: uploadError } = await supabase.storage.from("media").upload(path, file);
        if (uploadError) throw uploadError;
        await supabase.from("pin_photos").insert({ pin_id: pin.id, storage_path: path });
      }

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
    } catch (err) {
      errorEl.textContent = err.message || "Couldn't save that pin.";
      errorEl.style.display = "block";
      submitBtn.disabled = false;
    }
  });
}
