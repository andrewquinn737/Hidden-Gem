import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { openPinForm } from "./pinForm.js";
import { openPinDetail } from "./pinDetailModal.js";

const session = await requireSession();
if (session) {
  const params = new URLSearchParams(window.location.search);
  const viewingUserId = params.get("id") || session.user.id;
  const isOwnProfile = viewingUserId === session.user.id;

  let profileCache = null;

  await loadProfile();
  await loadCounts();
  if (isOwnProfile) {
    document.getElementById("ownMenuArea").style.display = "block";
    await loadFriendRequests();
    setupMenu();
    setupShare();
  } else {
    await renderFriendAction();
  }
  await loadPinsGrid();
  setupFriendsCountButton();

  async function loadProfile() {
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", viewingUserId).single();
    profileCache = profile;
    document.getElementById("profileUsername").textContent = profile?.username || "—";
    document.getElementById("profileFullName").textContent = profile?.full_name || "";
    if (profile?.avatar_url) {
      const { data } = await supabase.storage.from("media").createSignedUrl(profile.avatar_url, 3600);
      if (data?.signedUrl) document.getElementById("avatarImg").src = data.signedUrl;
    }
  }

  async function loadCounts() {
    const { count: pinCount } = await supabase
      .from("pins")
      .select("*", { count: "exact", head: true })
      .eq("owner_id", viewingUserId);
    const { count: friendCount } = await supabase
      .from("friend_requests")
      .select("*", { count: "exact", head: true })
      .eq("status", "accepted")
      .or(`requester_id.eq.${viewingUserId},recipient_id.eq.${viewingUserId}`);
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
        await loadCounts();
      });
      row.querySelector(".decline-btn").addEventListener("click", async () => {
        await supabase.from("friend_requests").update({ status: "declined", responded_at: new Date().toISOString() }).eq("id", req.id);
        await loadFriendRequests();
      });
      listEl.appendChild(row);
    }
  }

  async function getRelationship(otherUserId) {
    const { data } = await supabase
      .from("friend_requests")
      .select("id, requester_id, status")
      .or(`and(requester_id.eq.${session.user.id},recipient_id.eq.${otherUserId}),and(requester_id.eq.${otherUserId},recipient_id.eq.${session.user.id})`)
      .maybeSingle();
    return data;
  }

  async function renderFriendAction() {
    const el = document.getElementById("friendActionArea");
    const rel = await getRelationship(viewingUserId);

    if (rel?.status === "accepted") {
      el.innerHTML = `<button id="unfriendBtn" class="btn btn-danger">Unfriend</button>`;
      el.querySelector("#unfriendBtn").addEventListener("click", async () => {
        if (!confirm(`Remove ${profileCache?.username || "this person"} as a friend?`)) return;
        await supabase.from("friend_requests").delete().eq("id", rel.id);
        renderFriendAction();
        loadCounts();
      });
    } else if (rel?.status === "pending" && rel.requester_id === session.user.id) {
      el.innerHTML = `<span class="pill">Request sent</span>`;
    } else if (rel?.status === "pending") {
      el.innerHTML = `<button id="acceptHereBtn" class="btn btn-primary">Accept request</button>`;
      el.querySelector("#acceptHereBtn").addEventListener("click", async () => {
        await supabase.from("friend_requests").update({ status: "accepted", responded_at: new Date().toISOString() }).eq("id", rel.id);
        renderFriendAction();
        loadCounts();
      });
    } else {
      el.innerHTML = `<button id="addFriendBtn" class="btn btn-primary">Add friend</button>`;
      el.querySelector("#addFriendBtn").addEventListener("click", async () => {
        const { error } = await supabase.from("friend_requests").insert({ requester_id: session.user.id, recipient_id: viewingUserId });
        if (error) return alert(error.message);
        renderFriendAction();
      });
    }
  }

  function setupFriendsCountButton() {
    const btn = document.getElementById("friendsCountBtn");
    if (!isOwnProfile) {
      btn.style.cursor = "default";
      return;
    }
    btn.addEventListener("click", openFriendsModal);
  }

  async function openFriendsModal() {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop-full";
    backdrop.innerHTML = `
      <div class="modal-full stack">
        <div class="row-between">
          <h2 style="margin:0;">Friends</h2>
          <button id="friendsModalClose" class="btn-link" style="font-size:1.4rem; padding:0.2rem 0.5rem;">✕</button>
        </div>
        <form id="friendSearchForm" class="row">
          <input id="friendSearchInput" placeholder="Search by username" />
          <button type="submit" class="btn">Search</button>
        </form>
        <div id="friendSearchResults" class="stack"></div>
        <h3 style="margin:1rem 0 0;">Your friends</h3>
        <div id="currentFriendsList" class="stack"></div>
      </div>
    `;
    document.body.appendChild(backdrop);
    backdrop.querySelector("#friendsModalClose").addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    backdrop.querySelector("#friendSearchForm").addEventListener("submit", async (e) => {
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

    await renderCurrentFriends(backdrop);
  }

  async function renderSearchResult(person) {
    const rel = await getRelationship(person.id);
    const row = document.createElement("div");
    row.className = "row-between";

    let actionHtml;
    if (rel?.status === "accepted") {
      actionHtml = `<span class="pill">Friends</span>`;
    } else if (rel?.status === "pending" && rel.requester_id === session.user.id) {
      actionHtml = `<span class="pill">Request sent</span>`;
    } else if (rel?.status === "pending") {
      actionHtml = `<span class="pill">Check requests</span>`;
    } else {
      actionHtml = `<button class="btn btn-primary add-friend-btn">Add friend</button>`;
    }

    row.innerHTML = `<button class="btn-link goto-profile" style="padding:0;">${escapeHtml(person.username)}</button>`;
    row.insertAdjacentHTML("beforeend", actionHtml);

    row.querySelector(".goto-profile").addEventListener("click", () => {
      window.location.href = `profile.html?id=${person.id}`;
    });

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

  async function renderCurrentFriends(backdrop) {
    const listEl = backdrop.querySelector("#currentFriendsList");
    const { data: accepted } = await supabase
      .from("friend_requests")
      .select("id, requester_id, recipient_id")
      .eq("status", "accepted")
      .or(`requester_id.eq.${session.user.id},recipient_id.eq.${session.user.id}`);

    if (!accepted?.length) {
      listEl.innerHTML = '<p class="muted">No friends yet — search above to add some.</p>';
      return;
    }

    const friendIds = accepted.map((r) => (r.requester_id === session.user.id ? r.recipient_id : r.requester_id));
    const { data: friends } = await supabase.from("profiles").select("id, username, avatar_url").in("id", friendIds);

    listEl.innerHTML = "";
    for (const friend of friends || []) {
      const reqRow = accepted.find((r) => r.requester_id === friend.id || r.recipient_id === friend.id);
      let avatarUrl = "icons/icon-192.png";
      if (friend.avatar_url) {
        const { data } = await supabase.storage.from("media").createSignedUrl(friend.avatar_url, 3600);
        if (data?.signedUrl) avatarUrl = data.signedUrl;
      }
      const row = document.createElement("div");
      row.className = "row-between";
      row.innerHTML = `
        <button class="btn-link goto-profile row" style="padding:0; gap:0.5rem;">
          <img class="avatar" style="width:32px; height:32px;" src="${avatarUrl}" />
          <span>${escapeHtml(friend.username)}</span>
        </button>
        <button class="btn btn-danger unfriend-btn">Unfriend</button>
      `;
      row.querySelector(".goto-profile").addEventListener("click", () => {
        window.location.href = `profile.html?id=${friend.id}`;
      });
      row.querySelector(".unfriend-btn").addEventListener("click", async () => {
        if (!confirm(`Remove ${friend.username} as a friend?`)) return;
        await supabase.from("friend_requests").delete().eq("id", reqRow.id);
        await renderCurrentFriends(backdrop);
        await loadCounts();
      });
      listEl.appendChild(row);
    }
  }

  async function loadPinsGrid() {
    const gridEl = document.getElementById("pinsGrid");
    const { data: pins } = await supabase
      .from("pins")
      .select("id, title, pin_photos(storage_path, created_at)")
      .eq("owner_id", viewingUserId)
      .order("created_at", { ascending: false });

    gridEl.innerHTML = "";

    if (isOwnProfile) {
      const addTile = document.createElement("button");
      addTile.className = "add-pin-tile";
      addTile.setAttribute("aria-label", "Add new pin");
      addTile.textContent = "+";
      addTile.addEventListener("click", () => {
        openPinForm({ onSaved: () => { loadPinsGrid(); loadCounts(); } });
      });
      gridEl.appendChild(addTile);
    }

    for (const pin of pins || []) {
      const cover = [...(pin.pin_photos || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
      const tile = document.createElement("button");
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
      tile.addEventListener("click", () => openPinDetail(pin.id, { onChange: () => { loadPinsGrid(); loadCounts(); } }));
      gridEl.appendChild(tile);
    }

    if (!pins?.length && isOwnProfile) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.style.gridColumn = "1 / -1";
      empty.textContent = "No pins yet — tap + to add your first one.";
      gridEl.appendChild(empty);
    } else if (!pins?.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.style.gridColumn = "1 / -1";
      empty.textContent = "No pins to show.";
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
