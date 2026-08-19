import { supabase } from "./supabaseClient.js";
import { openPinForm } from "./pinForm.js";
import { setupSheetDrag } from "./sheetDrag.js";
import { MAP_OUTLINE_SVG, avatarPlaceholderHtml, skeletonListHtml } from "./placeholders.js";
import { reverseGeocodeLabel } from "./geoReverse.js";
import { getSignedUrl, getSignedUrls } from "./signedUrlCache.js";

const PIN_SELECT =
  "id, title, description, directions, category, owner_id, lat, lng, pin_photos(storage_path, created_at), pin_likes(user_id), pin_saves(user_id), pin_comments(count), profiles!pins_owner_id_fkey(username, avatar_url)";

export async function fetchPin(pinId) {
  const { data, error } = await supabase.from("pins").select(PIN_SELECT).eq("id", pinId).single();
  if (error) return null;
  return data;
}

// Shimmering placeholder matching a post card's shape, shown wherever a
// card's container sits empty while renderPostCard's signed-URL fetches are
// in flight — renderPostCard's own innerHTML assignment replaces it once
// the real content is ready, so callers never need to clear it themselves.
export function postCardSkeleton() {
  return `
    <div class="post-skeleton">
      <div class="post-header">
        <span class="skeleton-bar" style="width:45%; height:0.95rem;"></span>
        <div class="post-header-center"><span class="post-drag-handle" aria-hidden="true"></span></div>
        <div class="post-header-end"></div>
      </div>
      <div class="skeleton-bar skeleton-photo"></div>
      <div class="post-actions">
        <span class="skeleton-bar skeleton-icon"></span>
        <span class="skeleton-bar skeleton-icon"></span>
        <span class="skeleton-bar skeleton-icon"></span>
      </div>
      <div class="post-body stack" style="gap:0.5rem;">
        <span class="skeleton-bar" style="width:55%; height:0.8rem;"></span>
        <span class="skeleton-bar" style="width:85%; height:0.8rem;"></span>
      </div>
    </div>
  `;
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
  const { currentUserId, onChange, ownerMenuEnabled = false, onClose, startFull = false } = options;
  const isOwner = pin.owner_id === currentUserId;
  const likeCount = pin.pin_likes?.length ?? 0;
  const iLiked = (pin.pin_likes || []).some((l) => l.user_id === currentUserId);
  const iSaved = (pin.pin_saves || []).some((s) => s.user_id === currentUserId);
  const commentCount = pin.pin_comments?.[0]?.count ?? 0;
  const photos = [...(pin.pin_photos || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const ownerName = pin.profiles?.username || "someone";

  let photoUrls = [];
  if (photos.length) {
    photoUrls = (await getSignedUrls(photos.map((p) => p.storage_path))).filter(Boolean);
  }

  let ownerAvatarUrl = null;
  if (pin.profiles?.avatar_url) {
    ownerAvatarUrl = await getSignedUrl(pin.profiles.avatar_url);
  }

  const card = container;
  card.classList.add("post-card");

  // Description flows right after the name; directions gets its own line
  // below (a <br/>, not display:block — a block child breaks WebKit's
  // line-clamp box model and silently corrupts the truncation), and both
  // count toward the same 3-line clamp. A fullscreen popup (startFull —
  // reached from Profile, search, etc.) has plenty of room for the whole
  // thing, so only clamp in the more cramped feed/half-screen contexts.
  const descriptionText = pin.description || "";
  const directionsText = pin.directions ? `How to get there: ${pin.directions}` : "";
  const mayClamp = !startFull && (descriptionText || directionsText);

  card.innerHTML = `
    <div class="post-header post-header-stacked">
      <div class="post-header-center">
        <span class="post-drag-handle" aria-hidden="true"></span>
      </div>
      <div class="post-header-title-row">
        <div class="post-title-block">
          <button class="btn-link post-title" style="padding:0; text-align:left;">${escapeHtml(pin.title)}</button>
          <div class="post-location-label"></div>
        </div>
        <div class="post-header-end">
          ${pin.category ? `<span class="pill">${escapeHtml(pin.category)}</span>` : ""}
          <div class="post-menu-wrap" style="position:relative;">
            <button class="post-menu-btn" aria-label="Post menu">⋯</button>
            <div class="post-menu-dropdown card dropdown-menu stack" style="display:none; position:absolute; right:0; top:110%; z-index:30; min-width:170px; padding:0.4rem; gap:0.25rem;">
              <button class="btn dropdown-item post-schedule-btn" style="width:100%; text-align:left;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                <span>Schedule visit</span>
              </button>
              <button class="btn dropdown-item post-share-btn" style="width:100%; text-align:left;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/></svg>
                <span>Share</span>
              </button>
              ${
                ownerMenuEnabled && isOwner
                  ? `<button class="btn dropdown-item post-edit-btn" style="width:100%; text-align:left;">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>
                      <span>Edit</span>
                    </button>
                    <button class="btn dropdown-item btn-danger post-delete-btn" style="width:100%; text-align:left;">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                      <span>Delete</span>
                    </button>`
                  : ""
              }
            </div>
          </div>
          ${onClose ? '<button class="post-close-btn" aria-label="Close">✕</button>' : ""}
        </div>
      </div>
    </div>

    ${
      photoUrls.length
        ? `<div class="post-carousel">${photoUrls.map((u) => `<img src="${u}" alt="${escapeAttr(pin.title)}" draggable="false" />`).join("")}</div>`
        : `<div class="feed-post-photo-placeholder">${MAP_OUTLINE_SVG}</div>`
    }
    <div class="post-actions">
      <button class="post-like-btn icon-btn ${iLiked ? "active" : ""}" aria-label="Like">${ICONS.like(iLiked)}<span class="post-count">${likeCount}</span></button>
      <button class="post-comments-btn icon-btn" aria-label="Comments">${ICONS.comment}<span class="post-count">${commentCount}</span></button>
      <button class="post-save-btn icon-btn ${iSaved ? "active" : ""}" aria-label="Save">${ICONS.save(iSaved)}</button>
      <a href="index.html?focusPinId=${pin.id}" class="post-map-btn icon-btn" aria-label="View on map">${ICONS.map}</a>
      <a href="https://www.google.com/maps/search/?api=1&query=${pin.lat},${pin.lng}" target="_blank" rel="noopener" class="post-gmaps-btn icon-btn" aria-label="Open in Google Maps">${ICONS.gmaps}</a>
    </div>

    <div class="post-body">
      <p class="post-caption ${mayClamp ? "clamped" : ""}"><button class="post-owner-avatar-btn" aria-label="View profile">${ownerAvatarUrl ? `<img class="avatar post-owner-avatar" src="${ownerAvatarUrl}" />` : avatarPlaceholderHtml("avatar post-owner-avatar")}</button><button class="btn-link post-owner-name">${escapeHtml(ownerName)}</button><span class="post-caption-text">${escapeHtml(descriptionText)}</span>${directionsText ? `<br /><span class="post-directions-text">${escapeHtml(directionsText)}</span>` : ""}</p>
      ${mayClamp ? '<button class="post-showmore-btn">see more</button>' : ""}
    </div>
  `;

  card.querySelector(".post-title").addEventListener("click", () => {
    window.location.href = `profile.html?id=${pin.owner_id}&openPinId=${pin.id}`;
  });
  if (Number.isFinite(pin.lat) && Number.isFinite(pin.lng)) {
    reverseGeocodeLabel(pin.lat, pin.lng).then((label) => {
      const el = card.querySelector(".post-location-label");
      if (label && el) el.textContent = label;
    });
  }

  card.querySelector(".post-owner-name").addEventListener("click", () => {
    window.location.href = `profile.html?id=${pin.owner_id}`;
  });
  card.querySelector(".post-owner-avatar-btn").addEventListener("click", () => {
    window.location.href = `profile.html?id=${pin.owner_id}`;
  });

  const carousel = card.querySelector(".post-carousel");

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

  // Half-screen bottom-sheet drag — only relevant inside a popup (onClose
  // set); see js/sheetDrag.js.
  if (onClose) setupSheetDrag(card, { onDismiss: onClose, startFull });

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
  card.querySelector(".post-share-btn")?.addEventListener("click", async () => {
    menuDropdown.style.display = "none";
    const { data: existing } = await supabase
      .from("pin_invites")
      .select("token")
      .eq("pin_id", pin.id)
      .eq("inviter_id", currentUserId)
      .is("invitee_user_id", null)
      .is("invitee_email", null)
      .is("invitee_phone", null)
      .limit(1)
      .maybeSingle();

    let token = existing?.token;
    if (!token) {
      const { data: created, error } = await supabase
        .from("pin_invites")
        .insert({ pin_id: pin.id, inviter_id: currentUserId })
        .select("token")
        .single();
      if (error) return alert(error.message);
      token = created.token;
    }

    const url = `${window.location.origin}/invite.html?token=${token}`;
    const shareData = { title: "Hidden Gem — Pin", text: `Check out ${pin.title}!`, url };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        // user cancelled the share sheet
      }
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      alert("Link copied to clipboard.");
    }
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

  // Caption is clamped to 3 lines by default; the "see more"/"see less"
  // button only shows up if the text genuinely overflows that (measured
  // directly — scrollHeight vs clientHeight — rather than guessed from a
  // character count, which breaks the moment font size or card width
  // changes). Sits right under the caption instead of trailing inline
  // inside it, since a WebKit line-clamp box can't reliably fit trailing
  // content at its cutoff point anyway.
  const showMoreBtn = card.querySelector(".post-showmore-btn");
  const captionEl = card.querySelector(".post-caption");
  if (showMoreBtn && captionEl) {
    requestAnimationFrame(() => {
      if (captionEl.scrollHeight <= captionEl.clientHeight + 1) {
        showMoreBtn.remove();
      }
    });
    showMoreBtn.addEventListener("click", () => {
      const expanding = captionEl.classList.contains("clamped");
      captionEl.classList.toggle("clamped", !expanding);
      showMoreBtn.textContent = expanding ? "see less" : "see more";
    });
  }

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
        <div class="comments-list stack">${skeletonListHtml(3)}</div>
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

  setupSheetDrag(modalEl, { onDismiss: close });

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
