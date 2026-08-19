import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { getSignedUrls } from "./signedUrlCache.js";

const session = await requireSession();
if (session) {
  const params = new URLSearchParams(window.location.search);
  const pinId = params.get("id");
  const root = document.getElementById("pinRoot");

  if (!pinId) {
    root.innerHTML = '<p class="error-text">No pin specified.</p>';
  } else {
    await loadPin();
  }

  async function loadPin() {
    const { data: pin, error } = await supabase.from("pins").select("*").eq("id", pinId).single();
    if (error || !pin) {
      root.innerHTML = '<p class="error-text">Pin not found, or you don\'t have access to it.</p>';
      return;
    }
    const isOwner = pin.owner_id === session.user.id;

    const [{ data: owner }, { data: photos }, { data: likes }, { data: myLike }, { data: comments }] = await Promise.all([
      supabase.from("profiles").select("username, full_name").eq("id", pin.owner_id).single(),
      supabase.from("pin_photos").select("id, storage_path").eq("pin_id", pinId),
      supabase.from("pin_likes").select("user_id", { count: "exact" }).eq("pin_id", pinId),
      supabase.from("pin_likes").select("*").eq("pin_id", pinId).eq("user_id", session.user.id).maybeSingle(),
      supabase
        .from("pin_comments")
        .select("id, body, created_at, user_id, profiles(username)")
        .eq("pin_id", pinId)
        .order("created_at", { ascending: true }),
    ]);

    const photoUrls = await getSignedUrls((photos || []).map((p) => p.storage_path));

    root.innerHTML = `
      <div class="stack">
        <div class="row-between">
          <h1 style="margin:0;">${escapeHtml(pin.title)}</h1>
          <span class="pill">${pin.visibility}</span>
        </div>
        <p class="muted">by ${escapeHtml(owner?.username || "someone")} · ${escapeHtml(pin.category || "untagged")}</p>
        ${pin.description ? `<p>${escapeHtml(pin.description)}</p>` : ""}
        ${photoUrls.length ? `<div class="photo-grid">${photoUrls.map((u) => `<img src="${u}" />`).join("")}</div>` : ""}
        ${pin.directions ? `<div class="card"><strong>How to get there</strong><p style="margin:0.35rem 0 0;">${escapeHtml(pin.directions)}</p></div>` : ""}

        <div class="row">
          <button id="likeBtn" class="btn ${myLike ? "btn-primary" : ""}">${myLike ? "👍" : "👍🏻"} ${likes?.length ?? 0}</button>
          <a href="scheduler.html?pinId=${pin.id}" class="btn">📅 Plan a visit</a>
          <button id="shareBtn" class="btn">🔗 Share</button>
          ${isOwner ? '<button id="deleteBtn" class="btn btn-danger">Delete</button>' : ""}
        </div>
        <p id="shareLink" class="muted" style="display:none; word-break:break-all;"></p>

        <h2 style="margin-bottom:0.25rem;">Comments</h2>
        <div id="commentsList" class="stack"></div>
        <form id="commentForm" class="row">
          <input id="commentInput" placeholder="Leave a comment…" required />
          <button type="submit" class="btn btn-primary">Post</button>
        </form>
      </div>
    `;

    const commentsList = document.getElementById("commentsList");
    (comments || []).forEach((c) => {
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = `<strong>${escapeHtml(c.profiles?.username || "someone")}</strong> <span class="muted">${new Date(c.created_at).toLocaleDateString()}</span><p style="margin:0.25rem 0 0;">${escapeHtml(c.body)}</p>`;
      commentsList.appendChild(el);
    });

    document.getElementById("likeBtn").addEventListener("click", async () => {
      if (myLike) {
        await supabase.from("pin_likes").delete().eq("pin_id", pinId).eq("user_id", session.user.id);
      } else {
        await supabase.from("pin_likes").insert({ pin_id: pinId, user_id: session.user.id });
      }
      loadPin();
    });

    document.getElementById("shareBtn").addEventListener("click", async () => {
      const { data: invite, error: inviteError } = await supabase
        .from("pin_invites")
        .insert({ pin_id: pinId, inviter_id: session.user.id })
        .select()
        .single();
      const linkEl = document.getElementById("shareLink");
      if (inviteError) {
        linkEl.textContent = inviteError.message;
      } else {
        linkEl.textContent = `${window.location.origin}/invite.html?token=${invite.token}`;
      }
      linkEl.style.display = "block";
    });

    document.getElementById("deleteBtn")?.addEventListener("click", async () => {
      if (!confirm("Delete this pin? This can't be undone.")) return;
      await supabase.from("pins").delete().eq("id", pinId);
      window.location.href = "pins.html";
    });

    document.getElementById("commentForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("commentInput");
      const body = input.value.trim();
      if (!body) return;
      await supabase.from("pin_comments").insert({ pin_id: pinId, user_id: session.user.id, body });
      input.value = "";
      loadPin();
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
