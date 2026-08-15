import { supabase } from "./supabaseClient.js";
import { openPinForm } from "./pinForm.js";

const PIN_SELECT =
  "id, title, description, directions, category, owner_id, lat, lng, pin_photos(storage_path, created_at), pin_likes(user_id), pin_saves(user_id), pin_comments(count), profiles!pins_owner_id_fkey(username, avatar_url)";

export async function fetchPin(pinId) {
  const { data, error } = await supabase.from("pins").select(PIN_SELECT).eq("id", pinId).single();
  if (error) return null;
  return data;
}

// Renders a full "post" (header, swipeable photos, actions, description)
// into `container`. Used both inline in the Discover feed and inside the
// pin detail modal — one component, two contexts — so the swipe/like/
// comment/description behavior only has to be built and tested once.
export async function renderPostCard(pin, container, options = {}) {
  const { currentUserId, onChange, ownerMenuEnabled = false, onClose } = options;
  const isOwner = pin.owner_id === currentUserId;
  const likeCount = pin.pin_likes?.length ?? 0;
  const iLiked = (pin.pin_likes || []).some((l) => l.user_id === currentUserId);
  const iSaved = (pin.pin_saves || []).some((s) => s.user_id === currentUserId);
  const commentCount = pin.pin_comments?.[0]?.count ?? 0;
  const photos = [...(pin.pin_photos || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const ownerName = pin.profiles?.username || "someone";

  let photoUrls = [];
  if (photos.length) {
    const { data: signed } = await supabase.storage.from("media").createSignedUrls(
      photos.map((p) => p.storage_path),
      3600
    );
    photoUrls = (signed || []).map((s) => s.signedUrl).filter(Boolean);
  }

  let ownerAvatarUrl = "icons/icon-192.png";
  if (pin.profiles?.avatar_url) {
    const { data } = await supabase.storage.from("media").createSignedUrl(pin.profiles.avatar_url, 3600);
    if (data?.signedUrl) ownerAvatarUrl = data.signedUrl;
  }

  const card = container;
  card.classList.add("post-card");

  const descriptionLong = (pin.description?.length ?? 0) > 140 || !!pin.directions;

  card.innerHTML = `
    <div class="post-header">
      <strong class="post-title">${escapeHtml(pin.title)}</strong>
      <div class="post-header-center">
        <span class="post-drag-handle" aria-hidden="true"></span>
        ${pin.category ? `<span class="pill">${escapeHtml(pin.category)}</span>` : ""}
      </div>
      <div class="post-header-end">
        <div class="post-menu-wrap" style="position:relative;">
          <button class="post-menu-btn" aria-label="Post menu">⋯</button>
          <div class="post-menu-dropdown card stack" style="display:none; position:absolute; right:0; top:110%; z-index:30; min-width:140px; padding:0.4rem; gap:0.25rem;">
            ${
              ownerMenuEnabled && isOwner
                ? '<button class="btn post-edit-btn" style="width:100%; text-align:left; border:none;">Edit</button><button class="btn btn-danger post-delete-btn" style="width:100%; text-align:left; border:none;">Delete</button>'
                : ""
            }
          </div>
        </div>
        ${onClose ? '<button class="post-close-btn" aria-label="Close">✕</button>' : ""}
      </div>
    </div>

    ${
      photoUrls.length
        ? `<div class="post-carousel">${photoUrls.map((u) => `<img src="${u}" alt="${escapeAttr(pin.title)}" draggable="false" />`).join("")}</div>`
        : `<div class="feed-post-photo-placeholder">🗺️</div>`
    }
    ${photoUrls.length > 1 ? `<p class="post-photo-counter">1/${photoUrls.length}</p>` : ""}

    <div class="post-actions">
      <button class="post-like-btn ${iLiked ? "liked" : ""}">${iLiked ? "👍" : "👍🏻"} ${likeCount}</button>
      <button class="post-comments-btn">💬 ${commentCount}</button>
      <button class="post-save-btn ${iSaved ? "saved" : ""}" aria-label="Save">${iSaved ? "🔖" : "📑"}</button>
      <a href="index.html?focusPinId=${pin.id}" class="post-map-btn" aria-label="View on map">📍</a>
      <a href="https://www.google.com/maps/search/?api=1&query=${pin.lat},${pin.lng}" target="_blank" rel="noopener" class="post-gmaps-btn" aria-label="Open in Google Maps">🧭</a>
    </div>

    <div class="post-body">
      <div class="post-caption-wrap ${descriptionLong ? "clamped" : ""}">
        <p class="post-caption ${descriptionLong ? "clamped" : ""}">
          <button class="post-owner-avatar-btn" aria-label="View profile"><img class="avatar post-owner-avatar" src="${ownerAvatarUrl}" /></button><button class="btn-link post-owner-name">${escapeHtml(ownerName)}</button>
          ${pin.description ? ` ${escapeHtml(pin.description)}` : ""}
        </p>
        ${descriptionLong ? '<button class="post-showmore-btn">more</button>' : ""}
      </div>
      <div class="post-full-details" style="display:none;">
        ${pin.directions ? `<p class="post-directions"><strong>How to get there:</strong> ${escapeHtml(pin.directions)}</p>` : ""}
      </div>
    </div>

    <div class="post-comments-section" style="display:none;">
      <div class="post-comments-list stack"></div>
      <form class="post-comment-form row" style="margin-top:0.5rem;">
        <input class="post-comment-input" placeholder="Add a comment…" required />
        <button type="submit" class="btn btn-primary">Post</button>
      </form>
    </div>
  `;

  card.querySelector(".post-owner-name").addEventListener("click", () => {
    window.location.href = `profile.html?id=${pin.owner_id}`;
  });
  card.querySelector(".post-owner-avatar-btn").addEventListener("click", () => {
    window.location.href = `profile.html?id=${pin.owner_id}`;
  });

  // Photo counter follows swipe/scroll
  const carousel = card.querySelector(".post-carousel");
  const counterEl = card.querySelector(".post-photo-counter");
  carousel?.addEventListener("scroll", () => {
    if (!counterEl || !carousel.clientWidth) return;
    const index = Math.round(carousel.scrollLeft / carousel.clientWidth) + 1;
    counterEl.textContent = `${index}/${photoUrls.length}`;
  });

  // Swipe-to-change-photo for pointer types that don't get native touch
  // scrolling (mouse/pen) — touch already swipes via scroll-snap above.
  if (carousel && photoUrls.length > 1) {
    let dragging = false;
    let startX = 0;
    let startScroll = 0;
    carousel.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      dragging = true;
      startX = e.clientX;
      startScroll = carousel.scrollLeft;
      carousel.setPointerCapture(e.pointerId);
    });
    carousel.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      carousel.scrollLeft = startScroll - (e.clientX - startX);
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      const index = Math.round(carousel.scrollLeft / carousel.clientWidth);
      carousel.scrollTo({ left: index * carousel.clientWidth, behavior: "smooth" });
    };
    carousel.addEventListener("pointerup", endDrag);
    carousel.addEventListener("pointercancel", endDrag);
  }

  // Mobile bottom-sheet drag handle — only visible (via CSS) inside the
  // half-screen .pin-detail-modal, so this is a no-op everywhere else.
  // Drag up to grow to fullscreen, drag down to shrink back or dismiss.
  const dragHandle = card.querySelector(".post-drag-handle");
  if (dragHandle && onClose) {
    let sheetDragging = false;
    let sheetStartY = 0;
    let startedFull = false;
    dragHandle.addEventListener("pointerdown", (e) => {
      sheetDragging = true;
      sheetStartY = e.clientY;
      startedFull = card.classList.contains("sheet-full");
      card.style.transition = "none";
      dragHandle.setPointerCapture(e.pointerId);
    });
    dragHandle.addEventListener("pointermove", (e) => {
      if (!sheetDragging) return;
      const dy = e.clientY - sheetStartY;
      card.style.transform = `translateY(${startedFull ? Math.max(dy, 0) : dy}px)`;
    });
    const endSheetDrag = (e) => {
      if (!sheetDragging) return;
      sheetDragging = false;
      card.style.transition = "";
      card.style.transform = "";
      const dy = e.clientY - sheetStartY;
      if (!startedFull && dy < -60) card.classList.add("sheet-full");
      else if (!startedFull && dy > 100) onClose();
      else if (startedFull && dy > 250) onClose();
      else if (startedFull && dy > 100) card.classList.remove("sheet-full");
    };
    dragHandle.addEventListener("pointerup", endSheetDrag);
    dragHandle.addEventListener("pointercancel", endSheetDrag);
  }

  // 3-dot menu — genuinely inert when there's nothing to put in it (e.g.
  // Discover, for now) rather than popping open an empty dropdown.
  const menuBtn = card.querySelector(".post-menu-btn");
  const menuDropdown = card.querySelector(".post-menu-dropdown");
  const menuHasItems = ownerMenuEnabled && isOwner;
  if (menuHasItems) {
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".post-menu-dropdown").forEach((d) => {
        if (d !== menuDropdown) d.style.display = "none";
      });
      menuDropdown.style.display = menuDropdown.style.display === "none" ? "flex" : "none";
    });
    document.addEventListener("click", () => (menuDropdown.style.display = "none"));
  }

  card.querySelector(".post-edit-btn")?.addEventListener("click", () => {
    menuDropdown.style.display = "none";
    onClose?.();
    openPinForm({ editingPin: pin, onSaved: () => onChange?.() });
  });
  card.querySelector(".post-delete-btn")?.addEventListener("click", async () => {
    menuDropdown.style.display = "none";
    if (!confirm("Delete this pin? This can't be undone.")) return;
    await supabase.from("pins").delete().eq("id", pin.id);
    onClose?.();
    onChange?.();
  });
  card.querySelector(".post-close-btn")?.addEventListener("click", () => onClose?.());

  // Like toggle
  let likedNow = iLiked;
  let liveLikeCount = likeCount;
  card.querySelector(".post-like-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    if (likedNow) {
      await supabase.from("pin_likes").delete().eq("pin_id", pin.id).eq("user_id", currentUserId);
      likedNow = false;
      liveLikeCount--;
    } else {
      await supabase.from("pin_likes").insert({ pin_id: pin.id, user_id: currentUserId });
      likedNow = true;
      liveLikeCount++;
    }
    btn.classList.toggle("liked", likedNow);
    btn.textContent = `${likedNow ? "👍" : "👍🏻"} ${liveLikeCount}`;
    btn.disabled = false;
    // No onChange here on purpose — the count already updated in place
    // above, and reloading the whole feed on every like would be exactly
    // the kind of avoidable slowness we're trying to cut down on.
  });

  // Save toggle — same in-place-update reasoning as likes above.
  let savedNow = iSaved;
  card.querySelector(".post-save-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    if (savedNow) {
      await supabase.from("pin_saves").delete().eq("pin_id", pin.id).eq("user_id", currentUserId);
      savedNow = false;
    } else {
      await supabase.from("pin_saves").insert({ pin_id: pin.id, user_id: currentUserId });
      savedNow = true;
    }
    btn.classList.toggle("saved", savedNow);
    btn.textContent = savedNow ? "🔖" : "📑";
    btn.disabled = false;
  });

  // Comments (lazy-loaded on first open)
  const commentsSection = card.querySelector(".post-comments-section");
  const commentsListEl = card.querySelector(".post-comments-list");
  let commentsLoaded = false;
  card.querySelector(".post-comments-btn").addEventListener("click", async () => {
    const showing = commentsSection.style.display !== "none";
    commentsSection.style.display = showing ? "none" : "block";
    if (!showing && !commentsLoaded) {
      commentsLoaded = true;
      await loadComments();
    }
  });

  async function loadComments() {
    commentsListEl.innerHTML = '<p class="muted">Loading…</p>';
    const { data: comments } = await supabase
      .from("pin_comments")
      .select("id, body, created_at, user_id, profiles(id, username)")
      .eq("pin_id", pin.id)
      .order("created_at", { ascending: true });
    renderComments(comments || []);
    card.querySelector(".post-comments-btn").textContent = `💬 ${comments?.length ?? 0}`;
  }

  function renderComments(comments) {
    if (!comments.length) {
      commentsListEl.innerHTML = '<p class="muted">No comments yet.</p>';
      return;
    }
    commentsListEl.innerHTML = "";
    comments.forEach((c) => {
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = `
        <button class="btn-link comment-author" style="padding:0; font-weight:600;">${escapeHtml(c.profiles?.username || "someone")}</button>
        <span class="muted"> · ${new Date(c.created_at).toLocaleDateString()}</span>
        <p style="margin:0.25rem 0 0;">${escapeHtml(c.body)}</p>
      `;
      el.querySelector(".comment-author").addEventListener("click", () => {
        window.location.href = `profile.html?id=${c.user_id}`;
      });
      commentsListEl.appendChild(el);
    });
  }

  card.querySelector(".post-comment-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = card.querySelector(".post-comment-input");
    const body = input.value.trim();
    if (!body) return;
    await supabase.from("pin_comments").insert({ pin_id: pin.id, user_id: currentUserId, body });
    input.value = "";
    commentsLoaded = true;
    await loadComments();
    // No onChange here either — same reasoning as likes above.
  });

  // "more" — reveals full (unclamped) caption plus directions
  card.querySelector(".post-showmore-btn")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const wrapEl = card.querySelector(".post-caption-wrap");
    const captionEl = card.querySelector(".post-caption");
    const detailsEl = card.querySelector(".post-full-details");
    const expanding = captionEl.classList.contains("clamped");
    wrapEl.classList.toggle("clamped", !expanding);
    captionEl.classList.toggle("clamped", !expanding);
    detailsEl.style.display = expanding ? "block" : "none";
    btn.textContent = expanding ? "less" : "more";
  });

  return card;
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}
