import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { openPinDetail } from "./pinDetailModal.js";

const session = await requireSession();
if (session) {
  await loadFeed();

  async function loadFeed() {
    const feedEl = document.getElementById("feed");
    feedEl.innerHTML = '<p class="muted">Loading…</p>';

    // No filters here on purpose — RLS already returns exactly what this
    // user is allowed to see: their own pins, friends' pins, and public
    // pins from anyone. This is the whole "Discover" feed.
    const { data: pins, error } = await supabase
      .from("pins")
      .select(
        "id, title, description, category, owner_id, created_at, pin_photos(storage_path, created_at), pin_likes(user_id), pin_comments(count), profiles!pins_owner_id_fkey(username, avatar_url)"
      )
      .order("created_at", { ascending: false });

    if (error) {
      feedEl.innerHTML = `<p class="error-text">${error.message}</p>`;
      return;
    }
    if (!pins.length) {
      feedEl.innerHTML = '<p class="muted" style="text-align:center;">No pins to discover yet.</p>';
      return;
    }

    feedEl.innerHTML = "";
    for (const pin of pins) {
      feedEl.appendChild(await renderPost(pin));
    }
  }

  async function renderPost(pin) {
    const cover = [...(pin.pin_photos || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
    const likeCount = pin.pin_likes?.length ?? 0;
    const iLiked = (pin.pin_likes || []).some((l) => l.user_id === session.user.id);
    const commentCount = pin.pin_comments?.[0]?.count ?? 0;
    const owner = pin.profiles;

    const post = document.createElement("article");
    post.className = "feed-post";

    let ownerAvatarUrl = "icons/icon-192.png";
    if (owner?.avatar_url) {
      const { data } = await supabase.storage.from("media").createSignedUrl(owner.avatar_url, 3600);
      if (data?.signedUrl) ownerAvatarUrl = data.signedUrl;
    }

    let photoHtml;
    if (cover) {
      const { data } = await supabase.storage.from("media").createSignedUrl(cover.storage_path, 3600);
      photoHtml = `<img class="feed-post-photo pin-open-target" src="${data?.signedUrl || ""}" alt="${escapeHtml(pin.title)}" />`;
    } else {
      photoHtml = `<div class="feed-post-photo-placeholder pin-open-target">🗺️</div>`;
    }

    post.innerHTML = `
      <div class="feed-post-header">
        <img class="avatar" style="width:32px; height:32px;" src="${ownerAvatarUrl}" />
        <strong>${escapeHtml(owner?.username || "someone")}</strong>
        ${pin.category ? `<span class="pill" style="margin-left:auto;">${escapeHtml(pin.category)}</span>` : ""}
      </div>
      ${photoHtml}
      <div class="feed-post-actions">
        <button class="like-btn ${iLiked ? "liked" : ""}" data-pin-id="${pin.id}">${iLiked ? "👍" : "👍🏻"} ${likeCount}</button>
        <button class="comments-open-target">💬 ${commentCount}</button>
      </div>
      <div class="feed-post-body">
        <p class="caption"><strong>${escapeHtml(owner?.username || "someone")}</strong> <button class="btn-link pin-open-target" style="padding:0; color:inherit;">${escapeHtml(pin.title)}</button></p>
        ${pin.description ? `<p class="caption muted">${escapeHtml(pin.description)}</p>` : ""}
      </div>
    `;

    post.querySelectorAll(".pin-open-target, .comments-open-target").forEach((el) => {
      el.addEventListener("click", () => openPinDetail(pin.id, { onChange: loadFeed }));
    });

    post.querySelector(".like-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      if (iLiked) {
        await supabase.from("pin_likes").delete().eq("pin_id", pin.id).eq("user_id", session.user.id);
      } else {
        await supabase.from("pin_likes").insert({ pin_id: pin.id, user_id: session.user.id });
      }
      loadFeed();
    });

    return post;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
