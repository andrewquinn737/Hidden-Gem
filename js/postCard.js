import { supabase } from "./supabaseClient.js";
import { openPinForm } from "./pinForm.js";

const PIN_SELECT =
  "id, title, description, directions, category, owner_id, lat, lng, pin_photos(storage_path, created_at), pin_likes(user_id), pin_comments(count)";

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
  const commentCount = pin.pin_comments?.[0]?.count ?? 0;
  const photos = [...(pin.pin_photos || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  let photoUrls = [];
  if (photos.length) {
    const { data: signed } = await supabase.storage.from("media").createSignedUrls(
      photos.map((p) => p.storage_path),
      3600
    );
    photoUrls = (signed || []).map((s) => s.signedUrl).filter(Boolean);
  }

  const card = container;
  card.classList.add("post-card");

  const descriptionLong = (pin.description?.length ?? 0) > 140 || !!pin.directions;

  card.innerHTML = `
    <div class="post-header">
      <strong class="post-title">${escapeHtml(pin.title)}</strong>
      ${pin.category ? `<span class="pill">${escapeHtml(pin.category)}</span>` : ""}
      <div style="position:relative;">
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

    ${
      photoUrls.length
        ? `<div class="post-carousel">${photoUrls.map((u) => `<img src="${u}" alt="${escapeAttr(pin.title)}" />`).join("")}</div>`
        : `<div class="feed-post-photo-placeholder">🗺️</div>`
    }
    ${photoUrls.length > 1 ? `<p class="post-photo-counter">1/${photoUrls.length}</p>` : ""}

    <div class="post-actions">
      <button class="post-like-btn ${iLiked ? "liked" : ""}">${iLiked ? "👍" : "👍🏻"} ${likeCount}</button>
      <button class="post-comments-btn">💬 ${commentCount}</button>
      <a href="index.html?focusPinId=${pin.id}" class="post-map-btn" aria-label="View on map">📍</a>
    </div>

    <div class="post-body">
      <p class="post-description ${descriptionLong ? "clamped" : ""}">${escapeHtml(pin.description) || ""}</p>
      ${descriptionLong ? '<button class="post-showmore-btn">Show more</button>' : ""}
      <div class="post-full-details" style="display:none;">
        ${pin.directions ? `<div class="card" style="margin-top:0.5rem;"><strong>How to get there</strong><p style="margin:0.35rem 0 0;">${escapeHtml(pin.directions)}</p></div>` : ""}
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
  // Photo counter follows native scroll-snap swiping
  const carousel = card.querySelector(".post-carousel");
  const counterEl = card.querySelector(".post-photo-counter");
  carousel?.addEventListener("scroll", () => {
    if (!counterEl || !carousel.clientWidth) return;
    const index = Math.round(carousel.scrollLeft / carousel.clientWidth) + 1;
    counterEl.textContent = `${index}/${photoUrls.length}`;
  });

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

  // Show more — reveals full (unclamped) description plus directions
  card.querySelector(".post-showmore-btn")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const descEl = card.querySelector(".post-description");
    const detailsEl = card.querySelector(".post-full-details");
    const expanding = descEl.classList.contains("clamped");
    descEl.classList.toggle("clamped", !expanding);
    detailsEl.style.display = expanding ? "block" : "none";
    btn.textContent = expanding ? "Show less" : "Show more";
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
