import { supabase } from "./supabaseClient.js";
import { openPinForm } from "./pinForm.js";

export async function openPinDetail(pinId, { onChange } = {}) {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal pin-detail-modal"><p class="muted">Loading…</p></div>`;
  document.body.appendChild(backdrop);
  const modalEl = backdrop.querySelector(".pin-detail-modal");

  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  const [{ data: pin, error }, { data: photos }, { data: likes }, { data: comments }] = await Promise.all([
    supabase.from("pins").select("*, profiles!pins_owner_id_fkey(id, username, avatar_url)").eq("id", pinId).single(),
    supabase.from("pin_photos").select("id, storage_path, created_at").eq("pin_id", pinId).order("created_at", { ascending: true }),
    supabase.from("pin_likes").select("user_id").eq("pin_id", pinId),
    supabase
      .from("pin_comments")
      .select("id, body, created_at, user_id, profiles(id, username)")
      .eq("pin_id", pinId)
      .order("created_at", { ascending: true }),
  ]);

  if (error || !pin) {
    modalEl.innerHTML = `<p class="error-text">Pin not found, or you don't have access to it.</p><button class="btn" id="pdCloseErr">Close</button>`;
    modalEl.querySelector("#pdCloseErr").addEventListener("click", close);
    return;
  }

  const isOwner = pin.owner_id === user.id;
  let myLike = (likes || []).some((l) => l.user_id === user.id);
  let likeCount = likes?.length ?? 0;

  // Batch signed URLs — one round trip instead of one per photo.
  let photoUrls = [];
  if (photos?.length) {
    const { data: signed } = await supabase.storage.from("media").createSignedUrls(
      photos.map((p) => p.storage_path),
      3600
    );
    photoUrls = (signed || []).map((s) => s.signedUrl).filter(Boolean);
  }

  render();

  function render() {
    modalEl.innerHTML = `
      <div class="pin-detail-header">
        <div>
          <h2 style="margin:0;">${escapeHtml(pin.title)}</h2>
          <button class="btn-link owner-link" style="padding:0;">by ${escapeHtml(pin.profiles?.username || "someone")}</button>
        </div>
        <div class="row" style="gap:0.25rem;">
          <div style="position:relative;">
            <button id="pdMenuBtn" class="btn-link" style="font-size:1.4rem; padding:0.2rem 0.5rem;" aria-label="Pin menu">⋯</button>
            <div id="pdMenuDropdown" class="card stack" style="display:none; position:absolute; right:0; top:110%; z-index:30; min-width:140px; padding:0.4rem; gap:0.25rem;">
              ${isOwner ? '<button id="pdEditBtn" class="btn" style="width:100%; text-align:left; border:none;">Edit</button><button id="pdDeleteBtn" class="btn btn-danger" style="width:100%; text-align:left; border:none;">Delete</button>' : ""}
            </div>
          </div>
          <button id="pdCloseBtn" class="btn-link" style="font-size:1.4rem; padding:0.2rem 0.5rem;" aria-label="Close">✕</button>
        </div>
      </div>

      ${
        photoUrls.length
          ? `<div class="pin-photo-carousel">${photoUrls.map((u) => `<img src="${u}" />`).join("")}</div>`
          : `<div class="feed-post-photo-placeholder">🗺️</div>`
      }

      <div class="pin-detail-body stack">
        <span class="pill">${pin.visibility}</span>
        ${pin.description ? `<p>${escapeHtml(pin.description)}</p>` : ""}
        ${pin.directions ? `<div class="card"><strong>How to get there</strong><p style="margin:0.35rem 0 0;">${escapeHtml(pin.directions)}</p></div>` : ""}

        <div class="feed-post-actions" style="padding:0;">
          <button id="pdLikeBtn" class="${myLike ? "liked" : ""}">${myLike ? "👍" : "👍🏻"} ${likeCount}</button>
          <button id="pdCommentsBtn">💬 ${comments?.length ?? 0}</button>
          <a href="scheduler.html?pinId=${pin.id}" style="color:inherit;">📅</a>
          <button id="pdShareBtn">🔗</button>
        </div>

        <div id="pdCommentsSection" style="display:none;" class="stack">
          <div id="pdCommentsList" class="stack"></div>
          <form id="pdCommentForm" class="row">
            <input id="pdCommentInput" placeholder="Add a comment…" required />
            <button type="submit" class="btn btn-primary">Post</button>
          </form>
        </div>
      </div>
    `;

    modalEl.querySelector("#pdCloseBtn").addEventListener("click", close);
    modalEl.querySelector(".owner-link").addEventListener("click", () => {
      close();
      window.location.href = `profile.html?id=${pin.owner_id}`;
    });

    const menuBtn = modalEl.querySelector("#pdMenuBtn");
    const menuDropdown = modalEl.querySelector("#pdMenuDropdown");
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      menuDropdown.style.display = menuDropdown.style.display === "none" ? "flex" : "none";
    });

    modalEl.querySelector("#pdEditBtn")?.addEventListener("click", () => {
      menuDropdown.style.display = "none";
      close();
      openPinForm({
        editingPin: pin,
        onSaved: () => onChange?.(),
      });
    });

    modalEl.querySelector("#pdDeleteBtn")?.addEventListener("click", async () => {
      menuDropdown.style.display = "none";
      if (!confirm("Delete this pin? This can't be undone.")) return;
      await supabase.from("pins").delete().eq("id", pin.id);
      close();
      onChange?.();
    });

    modalEl.querySelector("#pdLikeBtn").addEventListener("click", async () => {
      if (myLike) {
        await supabase.from("pin_likes").delete().eq("pin_id", pin.id).eq("user_id", user.id);
        myLike = false;
        likeCount--;
      } else {
        await supabase.from("pin_likes").insert({ pin_id: pin.id, user_id: user.id });
        myLike = true;
        likeCount++;
      }
      render();
      onChange?.();
    });

    const commentsSection = modalEl.querySelector("#pdCommentsSection");
    modalEl.querySelector("#pdCommentsBtn").addEventListener("click", () => {
      const showing = commentsSection.style.display !== "none";
      commentsSection.style.display = showing ? "none" : "flex";
      if (!showing) renderComments();
    });

    modalEl.querySelector("#pdCommentForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = modalEl.querySelector("#pdCommentInput");
      const body = input.value.trim();
      if (!body) return;
      const { data: newComment } = await supabase
        .from("pin_comments")
        .insert({ pin_id: pin.id, user_id: user.id, body })
        .select("id, body, created_at, user_id, profiles(id, username)")
        .single();
      if (newComment) comments.push(newComment);
      input.value = "";
      renderComments();
      onChange?.();
    });

    modalEl.querySelector("#pdShareBtn").addEventListener("click", async () => {
      const { data: invite } = await supabase.from("pin_invites").insert({ pin_id: pin.id, inviter_id: user.id }).select().single();
      const url = invite ? `${window.location.origin}/invite.html?token=${invite.token}` : `${window.location.origin}/pin.html?id=${pin.id}`;
      const shareData = { title: pin.title, text: `Check out this spot on Hidden Gem: ${pin.title}`, url };
      if (navigator.share) {
        try {
          await navigator.share(shareData);
        } catch {
          // user cancelled — nothing to do
        }
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        alert("Link copied to clipboard.");
      }
    });

    function renderComments() {
      const listEl = modalEl.querySelector("#pdCommentsList");
      if (!comments.length) {
        listEl.innerHTML = '<p class="muted">No comments yet.</p>';
        return;
      }
      listEl.innerHTML = "";
      comments.forEach((c) => {
        const el = document.createElement("div");
        el.className = "card";
        el.innerHTML = `
          <button class="btn-link comment-author" style="padding:0; font-weight:600;">${escapeHtml(c.profiles?.username || "someone")}</button>
          <span class="muted"> · ${new Date(c.created_at).toLocaleDateString()}</span>
          <p style="margin:0.25rem 0 0;">${escapeHtml(c.body)}</p>
        `;
        el.querySelector(".comment-author").addEventListener("click", () => {
          close();
          window.location.href = `profile.html?id=${c.user_id}`;
        });
        listEl.appendChild(el);
      });
    }
  }

  document.addEventListener("click", () => {
    const dropdown = modalEl.querySelector("#pdMenuDropdown");
    if (dropdown) dropdown.style.display = "none";
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
