import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";

const session = await requireSession();
if (session) {
  let tab = "mine"; // "mine" | "following" | "public"
  const tabButtons = document.querySelectorAll("[data-tab]");
  tabButtons.forEach((btn) =>
    btn.addEventListener("click", () => {
      tab = btn.dataset.tab;
      tabButtons.forEach((b) => b.classList.toggle("btn-primary", b === btn));
      loadFeed();
    })
  );
  tabButtons[0]?.classList.add("btn-primary");

  async function loadFeed() {
    const feedEl = document.getElementById("feed");
    feedEl.innerHTML = '<p class="muted">Loading…</p>';

    let query = supabase
      .from("pins")
      .select(
        "id, title, description, category, owner_id, created_at, pin_photos(storage_path, created_at), pin_likes(user_id), pin_comments(count), profiles!pins_owner_id_fkey(username, avatar_url)"
      )
      .order("created_at", { ascending: false });

    if (tab === "mine") {
      query = query.eq("owner_id", session.user.id);
    } else if (tab === "public") {
      query = query.eq("visibility", "public");
    } else if (tab === "following") {
      const { data: follows } = await supabase.from("follows").select("followee_id").eq("follower_id", session.user.id);
      const ids = (follows || []).map((f) => f.followee_id);
      if (ids.length === 0) {
        feedEl.innerHTML = '<p class="muted" style="text-align:center;">You\'re not following anyone yet.</p>';
        return;
      }
      query = query.in("owner_id", ids).eq("visibility", "public");
    }

    const { data: pins, error } = await query;
    if (error) {
      feedEl.innerHTML = `<p class="error-text">${error.message}</p>`;
      return;
    }
    if (!pins.length) {
      feedEl.innerHTML = '<p class="muted" style="text-align:center;">No pins here yet.</p>';
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
      photoHtml = `<a href="pin.html?id=${pin.id}"><img class="feed-post-photo" src="${data?.signedUrl || ""}" alt="${escapeHtml(pin.title)}" /></a>`;
    } else {
      photoHtml = `<a href="pin.html?id=${pin.id}"><div class="feed-post-photo-placeholder">🗺️</div></a>`;
    }

    post.innerHTML = `
      <div class="feed-post-header">
        <img class="avatar" style="width:32px; height:32px;" src="${ownerAvatarUrl}" />
        <strong>${escapeHtml(owner?.username || "someone")}</strong>
        ${pin.category ? `<span class="pill" style="margin-left:auto;">${escapeHtml(pin.category)}</span>` : ""}
      </div>
      ${photoHtml}
      <div class="feed-post-actions">
        <button class="like-btn ${iLiked ? "liked" : ""}" data-pin-id="${pin.id}">${iLiked ? "❤" : "🤍"}</button>
        <a href="pin.html?id=${pin.id}" style="color:inherit;">💬</a>
      </div>
      <div class="feed-post-body">
        <p class="likes">${likeCount} ${likeCount === 1 ? "like" : "likes"}</p>
        <p class="caption"><strong>${escapeHtml(owner?.username || "someone")}</strong> <a href="pin.html?id=${pin.id}" style="color:inherit;">${escapeHtml(pin.title)}</a></p>
        ${pin.description ? `<p class="caption muted">${escapeHtml(pin.description)}</p>` : ""}
        ${commentCount ? `<a href="pin.html?id=${pin.id}" class="muted" style="font-size:0.9rem;">View all ${commentCount} comments</a>` : ""}
      </div>
    `;

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

  await loadFeed();
}
