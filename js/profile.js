import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { openPinForm } from "./pinForm.js";

const session = await requireSession();
if (session) {
  let profileCache = null;

  await loadProfile();
  await loadFriendsCount();
  await loadFriendRequests();
  await loadPinsGrid();
  setupMenu();
  setupFriendSearch();
  setupShare();

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

  async function loadFriendsCount() {
    const { count: pinCount } = await supabase
      .from("pins")
      .select("*", { count: "exact", head: true })
      .eq("owner_id", session.user.id);
    const { count: friendCount } = await supabase
      .from("friend_requests")
      .select("*", { count: "exact", head: true })
      .eq("status", "accepted")
      .or(`requester_id.eq.${session.user.id},recipient_id.eq.${session.user.id}`);
    document.getElementById("statPins").textContent = pinCount ?? 0;
    document.getElementById("statFriends").textContent = friendCount ?? 0;
  }

  async function loadFriendRequests() {
    const el = document.getElementById("friendRequests");
    const { data: incoming } = await supabase
      .from("friend_requests")
      .select("id, requester_id, profiles!friend_requests_requester_id_fkey(username, avatar_url)")
      .eq("recipient_id", session.user.id)
      .eq("status", "pending");

    if (!incoming?.length) {
      el.innerHTML = "";
      return;
    }

    el.innerHTML = `<div class="card stack"><h2 style="margin:0;">Friend requests</h2><div id="friendRequestsList" class="stack"></div></div>`;
    const listEl = document.getElementById("friendRequestsList");
    for (const req of incoming) {
      const row = document.createElement("div");
      row.className = "row-between";
      row.innerHTML = `
        <span>${escapeHtml(req.profiles?.username || "someone")}</span>
        <div class="row" style="gap:0.4rem;">
          <button class="btn btn-primary accept-btn">Accept</button>
          <button class="btn decline-btn">Decline</button>
        </div>
      `;
      row.querySelector(".accept-btn").addEventListener("click", async () => {
        await supabase.from("friend_requests").update({ status: "accepted", responded_at: new Date().toISOString() }).eq("id", req.id);
        await loadFriendRequests();
        await loadFriendsCount();
      });
      row.querySelector(".decline-btn").addEventListener("click", async () => {
        await supabase.from("friend_requests").update({ status: "declined", responded_at: new Date().toISOString() }).eq("id", req.id);
        await loadFriendRequests();
      });
      listEl.appendChild(row);
    }
  }

  function setupFriendSearch() {
    document.getElementById("friendSearchForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = document.getElementById("friendSearchInput").value.trim();
      const resultsEl = document.getElementById("friendSearchResults");
      resultsEl.innerHTML = "";
      if (!q) return;

      const { data: matches } = await supabase
        .from("profiles")
        .select("id, username, avatar_url")
        .ilike("username", `%${q}%`)
        .neq("id", session.user.id)
        .limit(10);

      if (!matches?.length) {
        resultsEl.innerHTML = '<p class="muted">No one found.</p>';
        return;
      }

      for (const person of matches) {
        resultsEl.appendChild(await renderSearchResult(person));
      }
    });
  }

  async function renderSearchResult(person) {
    const { data: existing } = await supabase
      .from("friend_requests")
      .select("id, requester_id, status")
      .or(
        `and(requester_id.eq.${session.user.id},recipient_id.eq.${person.id}),and(requester_id.eq.${person.id},recipient_id.eq.${session.user.id})`
      )
      .maybeSingle();

    const row = document.createElement("div");
    row.className = "row-between";

    let actionHtml;
    if (existing?.status === "accepted") {
      actionHtml = `<span class="pill">Friends</span>`;
    } else if (existing?.status === "pending" && existing.requester_id === session.user.id) {
      actionHtml = `<span class="pill">Request sent</span>`;
    } else if (existing?.status === "pending") {
      actionHtml = `<span class="pill">Check requests above</span>`;
    } else {
      actionHtml = `<button class="btn btn-primary add-friend-btn">Add friend</button>`;
    }

    row.innerHTML = `<span>${escapeHtml(person.username)}</span>`;
    row.insertAdjacentHTML("beforeend", actionHtml);

    row.querySelector(".add-friend-btn")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      const { error } = await supabase.from("friend_requests").insert({ requester_id: session.user.id, recipient_id: person.id });
      if (error) {
        alert(error.message);
        e.target.disabled = false;
        return;
      }
      e.target.outerHTML = '<span class="pill">Request sent</span>';
    });

    return row;
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
      openPinForm({ onSaved: () => { loadPinsGrid(); loadFriendsCount(); } });
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
      dropdown.style.display = dropdown.style.display === "none" ? "flex" : "none";
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

  function setupShare() {
    const shareBtn = document.getElementById("shareAppBtn");
    const dropdown = document.getElementById("menuDropdown");
    const statusEl = document.getElementById("shareStatus");

    shareBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      dropdown.style.display = "none";
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
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
