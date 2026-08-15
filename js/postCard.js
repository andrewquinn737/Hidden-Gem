import { supabase } from "./supabaseClient.js";
import { openPinForm } from "./pinForm.js";

const PIN_SELECT =
  "id, title, description, directions, category, owner_id, lat, lng, pin_photos(storage_path, created_at), pin_likes(user_id), pin_saves(user_id), pin_comments(count), profiles!pins_owner_id_fkey(username, avatar_url)";

export async function fetchPin(pinId) {
  const { data, error } = await supabase.from("pins").select(PIN_SELECT).eq("id", pinId).single();
  if (error) return null;
  return data;
}

// Simple outline/filled icon set for the actions row — black (white in dark
// mode, via currentColor) instead of colored emoji, filled solid on the
// active (liked/saved) state.
const ICONS = {
  like: (filled) => filled
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10v12H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm14.83 1.56-2.33 8A2 2 0 0 1 17.5 21H9a2 2 0 0 1-2-2v-9.24a2 2 0 0 1 .5-1.32L12 2a3 3 0 0 1 3 3.7L14.15 9H19a2 2 0 0 1 1.92 2.56z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>',
  comment:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  save: (filled) => filled
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  map:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
  gmaps:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
};

// Renders a full "post" (header, swipeable photos, actions, caption) into
// `container`. Used both inline in the Discover feed and inside the pin
// detail modal — one component, two contexts — so the swipe/like/comment/
// caption behavior only has to be built and tested once.
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

  // Description + directions flow as one caption, clamped together.
  const captionText = [pin.description, pin.directions ? `How to get there: ${pin.directions}` : null]
    .filter(Boolean)
    .join("  ");
  const captionLong = captionText.length > 140;

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
          <div class="post-menu-dropdown card stack" style="display:none; position:absolute; right:0; top:110%; z-index:30; min-width:160px; padding:0.4rem; gap:0.25rem;">
            <button class="btn post-schedule-btn" style="width:100%; text-align:left; border:none;">Schedule visit</button>
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
      <button class="post-like-btn icon-btn ${iLiked ? "active" : ""}" aria-label="Like">${ICONS.like(iLiked)}<span class="post-count">${likeCount}</span></button>
      <button class="post-comments-btn icon-btn" aria-label="Comments">${ICONS.comment}<span class="post-count">${commentCount}</span></button>
      <button class="post-save-btn icon-btn ${iSaved ? "active" : ""}" aria-label="Save">${ICONS.save(iSaved)}</button>
      <a href="index.html?focusPinId=${pin.id}" class="post-map-btn icon-btn" aria-label="View on map">${ICONS.map}</a>
      <a href="https://www.google.com/maps/search/?api=1&query=${pin.lat},${pin.lng}" target="_blank" rel="noopener" class="post-gmaps-btn icon-btn" aria-label="Open in Google Maps">${ICONS.gmaps}</a>
    </div>

    <div class="post-body">
      <p class="post-caption ${captionLong ? "clamped" : ""}">
        <button class="post-owner-avatar-btn" aria-label="View profile"><img class="avatar post-owner-avatar" src="${ownerAvatarUrl}" /></button><button class="btn-link post-owner-name">${escapeHtml(ownerName)}</button>
        ${captionText ? ` ${escapeHtml(captionText)}` : ""}${captionLong ? ' <button class="post-showmore-btn">more</button>' : ""}
      </p>
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

  // 3-dot menu — "Schedule visit" is always available; Edit/Delete only
  // for the pin's own owner when the caller enables it (Discover keeps
  // that part read-only for other people's pins).
  const menuBtn = card.querySelector(".post-menu-btn");
  const menuDropdown = card.querySelector(".post-menu-dropdown");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".post-menu-dropdown").forEach((d) => {
      if (d !== menuDropdown) d.style.display = "none";
    });
    menuDropdown.style.display = menuDropdown.style.display === "none" ? "flex" : "none";
  });
  document.addEventListener("click", () => (menuDropdown.style.display = "none"));

  card.querySelector(".post-schedule-btn").addEventListener("click", () => {
    menuDropdown.style.display = "none";
    window.location.href = `scheduler.html?pinId=${pin.id}`;
  });
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
  const likeBtn = card.querySelector(".post-like-btn");
  likeBtn.addEventListener("click", async () => {
    likeBtn.disabled = true;
    if (likedNow) {
      await supabase.from("pin_likes").delete().eq("pin_id", pin.id).eq("user_id", currentUserId);
      likedNow = false;
      liveLikeCount--;
    } else {
      await supabase.from("pin_likes").insert({ pin_id: pin.id, user_id: currentUserId });
      likedNow = true;
      liveLikeCount++;
    }
    likeBtn.classList.toggle("active", likedNow);
    likeBtn.innerHTML = `${ICONS.like(likedNow)}<span class="post-count">${liveLikeCount}</span>`;
    likeBtn.disabled = false;
    // No onChange here on purpose — the count already updated in place
    // above, and reloading the whole feed on every like would be exactly
    // the kind of avoidable slowness we're trying to cut down on.
  });

  // Save toggle — same in-place-update reasoning as likes above.
  let savedNow = iSaved;
  const saveBtn = card.querySelector(".post-save-btn");
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    if (savedNow) {
      await supabase.from("pin_saves").delete().eq("pin_id", pin.id).eq("user_id", currentUserId);
      savedNow = false;
    } else {
      await supabase.from("pin_saves").insert({ pin_id: pin.id, user_id: currentUserId });
      savedNow = true;
    }
    saveBtn.classList.toggle("active", savedNow);
    saveBtn.innerHTML = ICONS.save(savedNow);
    saveBtn.disabled = false;
  });

  // Comments — opens a half-screen popup (list + add-comment form) rather
  // than expanding inline.
  card.querySelector(".post-comments-btn").addEventListener("click", () => {
    openCommentsPopup(pin, currentUserId, (newCount) => {
      const countEl = card.querySelector(".post-comments-btn .post-count");
      if (countEl) countEl.textContent = newCount;
    });
  });

  // "more"/"less" — sits inline at the end of the caption text itself
  // (Instagram-style), so it reads as part of the last visible line
  // instead of a separate row.
  card.querySelector(".post-showmore-btn")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const captionEl = card.querySelector(".post-caption");
    const expanding = captionEl.classList.contains("clamped");
    captionEl.classList.toggle("clamped", !expanding);
    btn.textContent = expanding ? "less" : "more";
  });

  return card;
}

// Half-screen popup (centered modal on desktop, bottom sheet on mobile,
// both scroll internally) listing a pin's comments as plain rows, with the
// add-comment form built into the same popup.
async function openCommentsPopup(pin, currentUserId, onCountChange) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal pin-detail-modal comments-modal stack">
      <div class="post-header">
        <strong class="post-title">Comments</strong>
        <div class="post-header-center"><span class="post-drag-handle" aria-hidden="true"></span></div>
        <div class="post-header-end"><button class="post-close-btn" aria-label="Close">✕</button></div>
      </div>
      <div class="comments-body stack">
        <div class="comments-list stack"><p class="muted">Loading…</p></div>
      </div>
      <form class="post-comment-form row">
        <input class="post-comment-input" placeholder="Add a comment…" required />
        <button type="submit" class="btn btn-primary">Post</button>
      </form>
    </div>
  `;
  document.body.appendChild(backdrop);
  const modalEl = backdrop.querySelector(".comments-modal");
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  modalEl.querySelector(".post-close-btn").addEventListener("click", close);

  // Same drag-to-grow/dismiss handle behavior as the pin detail sheet.
  const dragHandle = modalEl.querySelector(".post-drag-handle");
  let sheetDragging = false;
  let sheetStartY = 0;
  let startedFull = false;
  dragHandle.addEventListener("pointerdown", (e) => {
    sheetDragging = true;
    sheetStartY = e.clientY;
    startedFull = modalEl.classList.contains("sheet-full");
    modalEl.style.transition = "none";
    dragHandle.setPointerCapture(e.pointerId);
  });
  dragHandle.addEventListener("pointermove", (e) => {
    if (!sheetDragging) return;
    const dy = e.clientY - sheetStartY;
    modalEl.style.transform = `translateY(${startedFull ? Math.max(dy, 0) : dy}px)`;
  });
  const endSheetDrag = (e) => {
    if (!sheetDragging) return;
    sheetDragging = false;
    modalEl.style.transition = "";
    modalEl.style.transform = "";
    const dy = e.clientY - sheetStartY;
    if (!startedFull && dy < -60) modalEl.classList.add("sheet-full");
    else if (!startedFull && dy > 100) close();
    else if (startedFull && dy > 250) close();
    else if (startedFull && dy > 100) modalEl.classList.remove("sheet-full");
  };
  dragHandle.addEventListener("pointerup", endSheetDrag);
  dragHandle.addEventListener("pointercancel", endSheetDrag);

  const listEl = modalEl.querySelector(".comments-list");

  async function loadComments() {
    const { data: comments } = await supabase
      .from("pin_comments")
      .select("id, body, created_at, user_id, profiles(id, username)")
      .eq("pin_id", pin.id)
      .order("created_at", { ascending: true });
    renderComments(comments || []);
    onCountChange?.(comments?.length ?? 0);
  }

  function renderComments(comments) {
    if (!comments.length) {
      listEl.innerHTML = '<p class="muted">No comments yet.</p>';
      return;
    }
    listEl.innerHTML = "";
    comments.forEach((c) => {
      const row = document.createElement("div");
      row.className = "comment-row";
      row.innerHTML = `
        <div class="row-between">
          <button class="btn-link comment-author">${escapeHtml(c.profiles?.username || "someone")}</button>
          <span class="muted">${new Date(c.created_at).toLocaleDateString()}</span>
        </div>
        <p class="comment-body">${escapeHtml(c.body)}</p>
      `;
      row.querySelector(".comment-author").addEventListener("click", () => {
        window.location.href = `profile.html?id=${c.user_id}`;
      });
      listEl.appendChild(row);
    });
  }

  modalEl.querySelector(".post-comment-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = modalEl.querySelector(".post-comment-input");
    const body = input.value.trim();
    if (!body) return;
    await supabase.from("pin_comments").insert({ pin_id: pin.id, user_id: currentUserId, body });
    input.value = "";
    await loadComments();
  });

  await loadComments();
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
