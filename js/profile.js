import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { openPinForm } from "./pinForm.js";

const session = await requireSession();
if (session) {
  let profileCache = null;

  await loadProfile();
  await loadCounts();
  await loadConnections();
  await loadPinsGrid();
  setupMenu();
  setupShareAndInstall();

  async function loadProfile() {
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();
    profileCache = profile;
    document.getElementById("profileUsername").textContent = profile.username || "—";
    document.getElementById("profileFullName").textContent = profile.full_name || "";
    if (profile.avatar_url) {
      const { data } = await supabase.storage.from("media").createSignedUrl(profile.avatar_url, 3600);
      if (data?.signedUrl) document.getElementById("avatarImg").src = data.signedUrl;
    }
  }

  async function loadCounts() {
    const [{ count: followerCount }, { count: followingCount }, { count: pinCount }] = await Promise.all([
      supabase.from("follows").select("*", { count: "exact", head: true }).eq("followee_id", session.user.id),
      supabase.from("follows").select("*", { count: "exact", head: true }).eq("follower_id", session.user.id),
      supabase.from("pins").select("*", { count: "exact", head: true }).eq("owner_id", session.user.id),
    ]);
    document.getElementById("statFollowers").textContent = followerCount ?? 0;
    document.getElementById("statFollowing").textContent = followingCount ?? 0;
    document.getElementById("statPins").textContent = pinCount ?? 0;
  }

  async function loadConnections() {
    const { data } = await supabase.rpc("get_my_calendar_connections");
    const google = data?.find((c) => c.provider === "google");
    const apple = data?.find((c) => c.provider === "apple_caldav");
    document.getElementById("googleStatus").textContent = google ? "Connected" : "Not connected";
    document.getElementById("appleStatus").textContent = apple ? "Connected" : "Not connected";
  }

  async function loadPinsGrid() {
    const gridEl = document.getElementById("pinsGrid");
    const { data: pins } = await supabase
      .from("pins")
      .select("id, title, pin_photos(storage_path, created_at)")
      .eq("owner_id", session.user.id)
      .order("created_at", { ascending: false });

    gridEl.innerHTML = "";

    const addTile = document.createElement("button");
    addTile.className = "add-pin-tile";
    addTile.setAttribute("aria-label", "Add new pin");
    addTile.textContent = "+";
    addTile.addEventListener("click", () => {
      openPinForm({ onSaved: loadPinsGrid });
    });
    gridEl.appendChild(addTile);

    for (const pin of pins || []) {
      const cover = [...(pin.pin_photos || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
      const tile = document.createElement("a");
      tile.href = `pin.html?id=${pin.id}`;
      tile.title = pin.title;

      if (cover) {
        const { data } = await supabase.storage.from("media").createSignedUrl(cover.storage_path, 3600);
        const img = document.createElement("img");
        img.src = data?.signedUrl || "";
        img.alt = pin.title;
        tile.appendChild(img);
      } else {
        tile.innerHTML = `<div class="row" style="height:100%; align-items:center; justify-content:center; background:var(--border); font-size:1.6rem;">🗺️</div>`;
      }
      gridEl.appendChild(tile);
    }

    if (!pins?.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.style.gridColumn = "1 / -1";
      empty.textContent = "No pins yet — tap + to add your first one.";
      gridEl.appendChild(empty);
    }
  }

  function setupMenu() {
    const menuBtn = document.getElementById("menuBtn");
    const dropdown = document.getElementById("menuDropdown");
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === "none" ? "block" : "none";
    });
    document.addEventListener("click", () => (dropdown.style.display = "none"));
    document.getElementById("editProfileBtn").addEventListener("click", () => {
      dropdown.style.display = "none";
      openEditProfileModal();
    });
  }

  function openEditProfileModal() {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal stack">
        <h2 style="margin:0;">Edit profile</h2>
        <div class="row">
          <img id="editAvatarImg" class="avatar" style="width:56px; height:56px;" src="${document.getElementById("avatarImg").src}" />
          <label class="btn">
            Change photo
            <input id="editAvatarInput" type="file" accept="image/*" style="display:none;" />
          </label>
        </div>
        <form id="editProfileForm" class="stack">
          <input id="editUsername" placeholder="Username" required maxlength="30" value="${profileCache?.username ?? ""}" />
          <input id="editFullName" placeholder="Full name" maxlength="120" value="${profileCache?.full_name ?? ""}" />
          <textarea id="editBio" placeholder="Bio" rows="3" maxlength="280">${profileCache?.bio ?? ""}</textarea>
          <p class="error-text" id="editProfileError" style="display:none;"></p>
          <div class="row">
            <button type="button" id="editCancelBtn" class="btn" style="flex:1;">Cancel</button>
            <button type="submit" class="btn btn-primary" style="flex:1;">Save</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector("#editCancelBtn").addEventListener("click", close);

    backdrop.querySelector("#editAvatarInput").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const path = `avatars/${session.user.id}/${Date.now()}-${file.name}`;
      const { error: uploadError } = await supabase.storage.from("media").upload(path, file);
      if (uploadError) return alert(uploadError.message);
      await supabase.from("profiles").update({ avatar_url: path }).eq("id", session.user.id);
      const { data } = await supabase.storage.from("media").createSignedUrl(path, 3600);
      if (data?.signedUrl) backdrop.querySelector("#editAvatarImg").src = data.signedUrl;
      await loadProfile();
    });

    backdrop.querySelector("#editProfileForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = backdrop.querySelector("#editProfileError");
      errorEl.style.display = "none";
      const username = backdrop.querySelector("#editUsername").value.trim();
      const full_name = backdrop.querySelector("#editFullName").value.trim() || null;
      const bio = backdrop.querySelector("#editBio").value.trim() || null;
      const { error } = await supabase.from("profiles").update({ username, full_name, bio }).eq("id", session.user.id);
      if (error) {
        errorEl.textContent = error.message;
        errorEl.style.display = "block";
        return;
      }
      await loadProfile();
      close();
    });
  }

  function setupShareAndInstall() {
    const shareBtn = document.getElementById("shareAppBtn");
    const installBtn = document.getElementById("installAppBtn");
    const statusEl = document.getElementById("shareStatus");

    const isStandalone =
      window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
    if (isStandalone) installBtn.style.display = "none";

    shareBtn.addEventListener("click", async () => {
      const shareData = {
        title: "Hidden Gem",
        text: "Find it. Mark it. Share it. Join me on Hidden Gem.",
        url: window.location.origin,
      };
      if (navigator.share) {
        try {
          await navigator.share(shareData);
        } catch {
          // user cancelled the share sheet — nothing to do
        }
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(shareData.url);
        statusEl.textContent = "Link copied to clipboard.";
        statusEl.style.display = "block";
      }
    });

    installBtn.addEventListener("click", async () => {
      const deferred = window.__deferredInstallPrompt;
      if (deferred) {
        deferred.prompt();
        await deferred.userChoice;
        window.__deferredInstallPrompt = null;
        return;
      }
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
      statusEl.style.display = "block";
      statusEl.textContent = isIOS
        ? 'To install: tap the Share icon in Safari, then "Add to Home Screen".'
        : 'Open your browser\'s menu and look for "Install app" or "Add to Home Screen".';
    });
  }
}
