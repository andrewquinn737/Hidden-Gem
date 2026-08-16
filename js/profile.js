import { requireSession, signOut } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { openPinForm } from "./pinForm.js";
import { openPinDetail, openPinDetailFullscreen } from "./pinDetailModal.js";
import { setupSheetDrag } from "./sheetDrag.js";
import { MAP_OUTLINE_SVG, PERSON_OUTLINE_SVG, avatarPlaceholderHtml, skeletonListHtml } from "./placeholders.js";

const NOTIF_SEEN_KEY = "hg:notifSeenAt";

const session = await requireSession();
if (session) {
  const params = new URLSearchParams(window.location.search);
  const viewingUserId = params.get("id") || session.user.id;
  const isOwnProfile = viewingUserId === session.user.id;
  let gridView = "posts"; // "posts" | "saved" — own profile only

  let profileCache = null;

  if (!isOwnProfile) {
    const backBtn = document.getElementById("backBtn");
    backBtn.style.display = "inline-block";
    backBtn.addEventListener("click", () => {
      if (window.history.length > 1) window.history.back();
      else window.location.href = "pins.html";
    });
  }

  await loadProfile();
  await loadCounts();
  if (isOwnProfile) {
    document.getElementById("ownMenuArea").style.display = "flex";
    document.getElementById("profileToggle").style.display = "flex";
    const addPinFab = document.getElementById("addPinFab");
    addPinFab.style.display = "flex";
    addPinFab.addEventListener("click", () => {
      openPinForm({ onSaved: () => { loadPinsGrid(); loadCounts(); } });
    });
    await loadFollowRequests();
    setupMenu();
    setupShare();
    setupToggle();
    setupNotifications();
    // Own profile never shows a follow action — hide it so it doesn't
    // still count as a flex item in the header row (which would push
    // ownMenuArea to visually "center" instead of the true right edge).
    document.getElementById("friendActionArea").style.display = "none";
  } else {
    await renderFollowAction();
  }
  await loadPinsGrid();
  setupFollowCountButtons();

  const openPinId = params.get("openPinId");
  if (openPinId) openPinDetailFullscreen(openPinId, {});

  async function loadProfile() {
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", viewingUserId).single();
    profileCache = profile;
    document.getElementById("profileUsername").textContent = profile?.username || "—";
    if (profile?.avatar_url) {
      const { data } = await supabase.storage.from("media").createSignedUrl(profile.avatar_url, 3600);
      if (data?.signedUrl) {
        const avatarImg = document.getElementById("avatarImg");
        avatarImg.src = data.signedUrl;
        avatarImg.style.display = "";
        document.getElementById("avatarPlaceholder").style.display = "none";
      }
    }
  }

  async function loadCounts() {
    const { count: pinCount } = await supabase
      .from("pins")
      .select("*", { count: "exact", head: true })
      .eq("owner_id", viewingUserId);
    const { count: followerCount } = await supabase
      .from("friend_requests")
      .select("*", { count: "exact", head: true })
      .eq("status", "accepted")
      .eq("recipient_id", viewingUserId);
    const { count: followingCount } = await supabase
      .from("friend_requests")
      .select("*", { count: "exact", head: true })
      .eq("status", "accepted")
      .eq("requester_id", viewingUserId);
    document.getElementById("statPins").textContent = pinCount ?? 0;
    document.getElementById("statPinsLabel").textContent = pinCount === 1 ? "pin" : "pins";
    document.getElementById("statFollowers").textContent = followerCount ?? 0;
    document.getElementById("statFollowing").textContent = followingCount ?? 0;
  }

  // Incoming follow requests — only the recipient can accept/decline
  // (enforced by RLS too, see migration_followers.sql).
  async function loadFollowRequests() {
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

    el.innerHTML = `<div class="card stack"><h2 style="margin:0;">Follow requests</h2><div id="friendRequestsList" class="stack"></div></div>`;
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
        await loadFollowRequests();
        await loadCounts();
      });
      row.querySelector(".decline-btn").addEventListener("click", async () => {
        await supabase.from("friend_requests").update({ status: "declined", responded_at: new Date().toISOString() }).eq("id", req.id);
        await loadFollowRequests();
      });
      listEl.appendChild(row);
    }
  }

  // Directional: only "do I (the viewer) follow viewingUserId" — whether
  // viewingUserId follows ME is a separate relationship, surfaced instead
  // in my own Follow requests list.
  async function getFollowRelationship(otherUserId) {
    const { data } = await supabase
      .from("friend_requests")
      .select("id, status")
      .eq("requester_id", session.user.id)
      .eq("recipient_id", otherUserId)
      .maybeSingle();
    return data;
  }

  async function renderFollowAction() {
    const el = document.getElementById("friendActionArea");
    const rel = await getFollowRelationship(viewingUserId);

    if (rel?.status === "accepted") {
      el.innerHTML = `<button id="unfollowBtn" class="btn btn-danger">Following</button>`;
      el.querySelector("#unfollowBtn").addEventListener("click", async () => {
        if (!confirm(`Unfollow ${profileCache?.username || "this person"}?`)) return;
        await supabase.from("friend_requests").delete().eq("id", rel.id);
        renderFollowAction();
        loadCounts();
      });
    } else if (rel?.status === "pending") {
      el.innerHTML = `<button id="cancelRequestBtn" class="btn">Requested</button>`;
      el.querySelector("#cancelRequestBtn").addEventListener("click", async () => {
        await supabase.from("friend_requests").delete().eq("id", rel.id);
        renderFollowAction();
      });
    } else {
      el.innerHTML = `<button id="followBtn" class="btn btn-primary">Follow</button>`;
      el.querySelector("#followBtn").addEventListener("click", async () => {
        const { error } = await supabase.from("friend_requests").insert({ requester_id: session.user.id, recipient_id: viewingUserId });
        if (error) return alert(error.message);
        renderFollowAction();
      });
    }
  }

  function setupFollowCountButtons() {
    document.getElementById("followersCountBtn").addEventListener("click", () => openFollowListModal("followers"));
    document.getElementById("followingCountBtn").addEventListener("click", () => openFollowListModal("following"));
  }

  // Half-screen popup listing either followers (people who follow
  // viewingUserId) or following (people viewingUserId follows) — same
  // pattern as other half-screen popups (drag handle, centered).
  async function openFollowListModal(kind) {
    const title = kind === "followers" ? "Followers" : "Following";
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal pin-detail-modal friends-modal stack">
        <div class="post-header">
          <strong class="post-title hide-title-mobile">${title}</strong>
          <div class="post-header-center"><span class="post-drag-handle" aria-hidden="true"></span></div>
          <div class="post-header-end"><button class="post-close-btn" aria-label="Close">✕</button></div>
        </div>
        <div class="friends-body stack">
          <input id="friendFilterInput" class="popup-search-input" placeholder="Search ${title.toLowerCase()}" />
          <div id="currentFriendsList" class="stack">${skeletonListHtml(4, { avatar: true })}</div>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    const modalEl = backdrop.querySelector(".friends-modal");
    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    modalEl.querySelector(".post-close-btn").addEventListener("click", close);
    setupSheetDrag(modalEl, { onDismiss: close });

    const matchCol = kind === "followers" ? "recipient_id" : "requester_id";
    const otherCol = kind === "followers" ? "requester_id" : "recipient_id";
    const { data: rows } = await supabase
      .from("friend_requests")
      .select("id, requester_id, recipient_id")
      .eq("status", "accepted")
      .eq(matchCol, viewingUserId);

    const otherIds = (rows || []).map((r) => r[otherCol]);
    let people = [];
    if (otherIds.length) {
      const { data } = await supabase.from("profiles").select("id, username, avatar_url").in("id", otherIds);
      people = data || [];
    }

    const signedByPath = {};
    const avatarPaths = people.map((p) => p.avatar_url).filter(Boolean);
    if (avatarPaths.length) {
      const { data: signed } = await supabase.storage.from("media").createSignedUrls(avatarPaths, 3600);
      (signed || []).forEach((s) => (signedByPath[s.path] = s.signedUrl));
    }

    // Only the owner of this list can remove entries: unfollow someone in
    // their own Following list, or remove a follower from their own
    // Followers list. Viewing someone else's list is view-only.
    const canManage = isOwnProfile;

    function renderList(filterText) {
      const listEl = modalEl.querySelector("#currentFriendsList");
      const filtered = people.filter((p) => p.username.toLowerCase().includes(filterText.toLowerCase()));
      if (!filtered.length) {
        listEl.innerHTML = `<p class="muted">${people.length ? `No ${title.toLowerCase()} match that search.` : `No ${title.toLowerCase()} yet.`}</p>`;
        return;
      }
      listEl.innerHTML = "";
      for (const person of filtered) {
        const row = rows.find((r) => r[otherCol] === person.id);
        const avatarUrl = person.avatar_url && signedByPath[person.avatar_url];
        const avatarHtml = avatarUrl
          ? `<img class="avatar" style="width:32px; height:32px;" src="${avatarUrl}" />`
          : avatarPlaceholderHtml("avatar", "width:32px; height:32px;");
        const rowEl = document.createElement("div");
        rowEl.className = "row-between";
        rowEl.innerHTML = `
          <button class="btn-link goto-profile row" style="padding:0; gap:0.5rem; color:var(--text);">
            ${avatarHtml}
            <span>${escapeHtml(person.username)}</span>
          </button>
          ${canManage ? `<button class="btn btn-danger manage-btn">${kind === "followers" ? "Remove" : "Unfollow"}</button>` : ""}
        `;
        rowEl.querySelector(".goto-profile").addEventListener("click", () => {
          window.location.href = `profile.html?id=${person.id}`;
        });
        const manageBtn = rowEl.querySelector(".manage-btn");
        if (manageBtn) {
          manageBtn.addEventListener("click", async () => {
            const verb = kind === "followers" ? "Remove" : "Unfollow";
            if (!confirm(`${verb} ${person.username}?`)) return;
            await supabase.from("friend_requests").delete().eq("id", row.id);
            people = people.filter((p) => p.id !== person.id);
            renderList(modalEl.querySelector("#friendFilterInput").value);
            await loadCounts();
          });
        }
        listEl.appendChild(rowEl);
      }
    }
    renderList("");
    modalEl.querySelector("#friendFilterInput").addEventListener("input", (e) => renderList(e.target.value));
  }

  // Your-posts / Saved segmented toggle, spanning the full header width.
  function setupToggle() {
    const toggle = document.getElementById("profileToggle");
    toggle.querySelectorAll(".profile-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.view === gridView) return;
        gridView = btn.dataset.view;
        toggle.querySelectorAll(".profile-toggle-btn").forEach((b) => b.classList.toggle("active", b === btn));
        loadPinsGrid();
      });
    });
  }

  async function loadPinsGrid() {
    const gridEl = document.getElementById("pinsGrid");
    gridEl.innerHTML = "";

    let pins;
    if (gridView === "saved") {
      const { data: saves } = await supabase
        .from("pin_saves")
        .select("pin_id, created_at, pins(id, title, pin_photos(storage_path, created_at))")
        .eq("user_id", session.user.id)
        .order("created_at", { ascending: false });
      pins = (saves || []).map((s) => s.pins).filter(Boolean);
    } else {
      const { data } = await supabase
        .from("pins")
        .select("id, title, pin_photos(storage_path, created_at)")
        .eq("owner_id", viewingUserId)
        .order("created_at", { ascending: false });
      pins = data || [];
    }

    const covers = pins.map(
      (pin) => [...(pin.pin_photos || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0]
    );
    const coverPaths = covers.filter(Boolean).map((c) => c.storage_path);
    let signedByPath = {};
    if (coverPaths.length) {
      const { data: signed } = await supabase.storage.from("media").createSignedUrls(coverPaths, 3600);
      (signed || []).forEach((s) => (signedByPath[s.path] = s.signedUrl));
    }

    pins.forEach((pin, i) => {
      const cover = covers[i];
      const tile = document.createElement("button");
      tile.className = "pins-grid-tile";
      tile.title = pin.title;

      if (cover) {
        const img = document.createElement("img");
        img.src = signedByPath[cover.storage_path] || "";
        img.alt = pin.title;
        tile.appendChild(img);
      } else {
        tile.innerHTML = `<div class="pin-photo-placeholder" style="height:100%; width:100%;">${MAP_OUTLINE_SVG}</div>`;
      }
      tile.addEventListener("click", () => openPinDetailFullscreen(pin.id, { onChange: () => { loadPinsGrid(); loadCounts(); } }));
      gridEl.appendChild(tile);
    });

    if (!pins.length) {
      const empty = document.createElement("div");
      empty.className = "stack";
      empty.style.cssText = "grid-column: 1 / -1; align-items: center; text-align: center; padding: 2rem 1rem; gap: 0.5rem; color: var(--text-muted);";
      const text =
        gridView === "saved"
          ? "No saved posts yet."
          : isOwnProfile
          ? "No pins yet — tap the + button to add your first one."
          : "No pins to show.";
      empty.innerHTML = `<span style="width:40px; height:40px;">${MAP_OUTLINE_SVG}</span><p class="muted" style="margin:0;">${escapeHtml(text)}</p>`;
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
    document.getElementById("signOutMenuBtn").addEventListener("click", signOut);
  }

  // Notifications — derived live from existing tables (pending friend
  // requests, plus comments/likes/saves on pins I own) rather than a
  // dedicated table. "Unread" is just "newer than the last time the
  // popup was opened", tracked client-side in localStorage.
  async function fetchNotifications() {
    const { data: myPins } = await supabase.from("pins").select("id, title").eq("owner_id", session.user.id);
    const myPinIds = (myPins || []).map((p) => p.id);
    const pinTitleById = Object.fromEntries((myPins || []).map((p) => [p.id, p.title]));

    const [{ data: requests }, comments, likes, saves] = await Promise.all([
      supabase
        .from("friend_requests")
        .select("id, requester_id, created_at, profiles!friend_requests_requester_id_fkey(username)")
        .eq("recipient_id", session.user.id)
        .eq("status", "pending"),
      myPinIds.length
        ? supabase.from("pin_comments").select("id, pin_id, user_id, created_at, profiles(username)").in("pin_id", myPinIds).neq("user_id", session.user.id).order("created_at", { ascending: false }).limit(30)
        : { data: [] },
      myPinIds.length
        ? supabase.from("pin_likes").select("pin_id, user_id, created_at, profiles(username)").in("pin_id", myPinIds).neq("user_id", session.user.id).order("created_at", { ascending: false }).limit(30)
        : { data: [] },
      myPinIds.length
        ? supabase.from("pin_saves").select("pin_id, user_id, created_at, profiles(username)").in("pin_id", myPinIds).neq("user_id", session.user.id).order("created_at", { ascending: false }).limit(30)
        : { data: [] },
    ]);

    const items = [
      ...(requests || []).map((r) => ({
        type: "friend_request",
        actor: r.profiles?.username || "someone",
        createdAt: r.created_at,
        href: "profile.html",
      })),
      ...((comments.data || [])).map((c) => ({
        type: "comment",
        actor: c.profiles?.username || "someone",
        pinTitle: pinTitleById[c.pin_id],
        createdAt: c.created_at,
        href: `index.html?focusPinId=${c.pin_id}`,
        pinId: c.pin_id,
      })),
      ...((likes.data || [])).map((l) => ({
        type: "like",
        actor: l.profiles?.username || "someone",
        pinTitle: pinTitleById[l.pin_id],
        createdAt: l.created_at,
        pinId: l.pin_id,
      })),
      ...((saves.data || [])).map((s) => ({
        type: "save",
        actor: s.profiles?.username || "someone",
        pinTitle: pinTitleById[s.pin_id],
        createdAt: s.created_at,
        pinId: s.pin_id,
      })),
    ];
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return items;
  }

  function notifText(item) {
    if (item.type === "friend_request") return `${item.actor} sent you a friend request`;
    if (item.type === "comment") return `${item.actor} commented on "${item.pinTitle || "your pin"}"`;
    if (item.type === "like") return `${item.actor} liked "${item.pinTitle || "your pin"}"`;
    if (item.type === "save") return `${item.actor} saved "${item.pinTitle || "your pin"}"`;
    return "";
  }

  async function setupNotifications() {
    const btn = document.getElementById("notifBtn");
    const dot = document.getElementById("notifDot");
    const items = await fetchNotifications();
    const lastSeen = localStorage.getItem(NOTIF_SEEN_KEY);
    const hasUnread = items.some((n) => !lastSeen || new Date(n.createdAt) > new Date(lastSeen));
    dot.style.display = hasUnread ? "block" : "none";

    btn.addEventListener("click", async () => {
      dot.style.display = "none";
      localStorage.setItem(NOTIF_SEEN_KEY, new Date().toISOString());
      openNotificationsModal(items);
    });
  }

  function openNotificationsModal(items) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal pin-detail-modal notif-modal stack">
        <div class="post-header">
          <strong class="post-title hide-title-mobile">Notifications</strong>
          <div class="post-header-center"><span class="post-drag-handle" aria-hidden="true"></span></div>
          <div class="post-header-end"><button class="post-close-btn" aria-label="Close">✕</button></div>
        </div>
        <div class="notif-body stack">
          ${
            items.length
              ? items
                  .map(
                    (n) => `
              <button class="notif-row" data-href="${n.href || (n.pinId ? `index.html?focusPinId=${n.pinId}` : "")}">
                <span>${escapeHtml(notifText(n))}</span>
                <span class="muted">${new Date(n.createdAt).toLocaleDateString()}</span>
              </button>`
                  )
                  .join("")
              : '<p class="muted">Nothing yet.</p>'
          }
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    const modalEl = backdrop.querySelector(".notif-modal");
    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    modalEl.querySelector(".post-close-btn").addEventListener("click", close);
    setupSheetDrag(modalEl, { onDismiss: close });
    modalEl.querySelectorAll(".notif-row").forEach((row) => {
      row.addEventListener("click", () => {
        if (row.dataset.href) window.location.href = row.dataset.href;
      });
    });
  }

  function openEditProfileModal() {
    const headerAvatarImg = document.getElementById("avatarImg");
    const hasAvatar = headerAvatarImg.style.display !== "none";
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal pin-detail-modal edit-profile-modal stack">
        <div class="post-header">
          <strong class="post-title hide-title-mobile">Edit profile</strong>
          <div class="post-header-center"><span class="post-drag-handle" aria-hidden="true"></span></div>
          <div class="post-header-end"><button class="post-close-btn" aria-label="Close">✕</button></div>
        </div>
        <div class="edit-profile-body stack">
          <div class="row">
            ${
              hasAvatar
                ? `<img id="editAvatarImg" class="avatar" style="width:56px; height:56px;" src="${headerAvatarImg.src}" />`
                : `<span id="editAvatarImg" class="avatar avatar-placeholder" style="width:56px; height:56px;">${PERSON_OUTLINE_SVG}</span>`
            }
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
      </div>
    `;
    document.body.appendChild(backdrop);
    const modalEl = backdrop.querySelector(".edit-profile-modal");

    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    modalEl.querySelector(".post-close-btn").addEventListener("click", close);
    backdrop.querySelector("#editCancelBtn").addEventListener("click", close);
    setupSheetDrag(modalEl, { onDismiss: close });

    backdrop.querySelector("#editAvatarInput").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const path = `avatars/${session.user.id}/${Date.now()}-${file.name}`;
      const { error: uploadError } = await supabase.storage.from("media").upload(path, file);
      if (uploadError) return alert(uploadError.message);
      await supabase.from("profiles").update({ avatar_url: path }).eq("id", session.user.id);
      const { data } = await supabase.storage.from("media").createSignedUrl(path, 3600);
      if (data?.signedUrl) {
        const current = backdrop.querySelector("#editAvatarImg");
        const img = document.createElement("img");
        img.id = "editAvatarImg";
        img.className = "avatar";
        img.style.cssText = "width:56px; height:56px;";
        img.src = data.signedUrl;
        current.replaceWith(img);
      }
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
