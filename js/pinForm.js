import { supabase } from "./supabaseClient.js";

export function openPinForm({ lat, lng, onSaved }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal stack">
      <h2 style="margin:0;">New pin</h2>
      <form id="pinForm" class="stack">
        <input id="pinTitle" placeholder="Title" required maxlength="120" />
        <textarea id="pinDescription" placeholder="What makes this spot worth finding?" rows="3"></textarea>
        <input id="pinCategory" placeholder="Category (viewpoint, waterfall, ruins…)" maxlength="60" />
        <label class="row">
          <input type="checkbox" id="pinPublic" style="width:auto;" />
          <span>Make this pin public</span>
        </label>
        <input id="pinPhotos" type="file" accept="image/*" multiple />
        <p class="error-text" id="pinFormError" style="display:none;"></p>
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

  backdrop.querySelector("#pinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = backdrop.querySelector("#pinFormError");
    errorEl.style.display = "none";
    const submitBtn = e.target.querySelector("button[type=submit]");
    submitBtn.disabled = true;

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const title = backdrop.querySelector("#pinTitle").value.trim();
      const description = backdrop.querySelector("#pinDescription").value.trim() || null;
      const category = backdrop.querySelector("#pinCategory").value.trim() || null;
      const visibility = backdrop.querySelector("#pinPublic").checked ? "public" : "private";
      const files = Array.from(backdrop.querySelector("#pinPhotos").files || []);

      const { data: pin, error: insertError } = await supabase
        .from("pins")
        .insert({ owner_id: user.id, title, description, category, lat, lng, visibility })
        .select()
        .single();
      if (insertError) throw insertError;

      for (const file of files) {
        const path = `pins/${pin.id}/${Date.now()}-${file.name}`;
        const { error: uploadError } = await supabase.storage.from("media").upload(path, file);
        if (uploadError) throw uploadError;
        await supabase.from("pin_photos").insert({ pin_id: pin.id, storage_path: path });
      }

      close();
      onSaved?.(pin);
    } catch (err) {
      errorEl.textContent = err.message || "Couldn't save that pin.";
      errorEl.style.display = "block";
      submitBtn.disabled = false;
    }
  });
}
