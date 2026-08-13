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
      loadPins();
    })
  );
  tabButtons[0]?.classList.add("btn-primary");

  async function loadPins() {
    const cardsEl = document.getElementById("pinCards");
    const tableBodyEl = document.getElementById("pinTableBody");
    cardsEl.innerHTML = '<p class="muted">Loading…</p>';
    tableBodyEl.innerHTML = "";

    let query = supabase
      .from("pins")
      .select("id, title, category, visibility, owner_id, created_at, pin_likes(count), pin_comments(count)")
      .order("created_at", { ascending: false });

    if (tab === "mine") {
      query = query.eq("owner_id", session.user.id);
    } else if (tab === "public") {
      query = query.eq("visibility", "public");
    } else if (tab === "following") {
      const { data: follows } = await supabase.from("follows").select("followee_id").eq("follower_id", session.user.id);
      const ids = (follows || []).map((f) => f.followee_id);
      if (ids.length === 0) {
        cardsEl.innerHTML = '<p class="muted">You\'re not following anyone yet.</p>';
        return;
      }
      query = query.in("owner_id", ids).eq("visibility", "public");
    }

    const { data: pins, error } = await query;
    if (error) {
      cardsEl.innerHTML = `<p class="error-text">${error.message}</p>`;
      return;
    }
    if (!pins.length) {
      cardsEl.innerHTML = '<p class="muted">No pins here yet.</p>';
      return;
    }

    cardsEl.innerHTML = "";
    pins.forEach((pin) => {
      const likeCount = pin.pin_likes?.[0]?.count ?? 0;
      const commentCount = pin.pin_comments?.[0]?.count ?? 0;

      const card = document.createElement("a");
      card.href = `pin.html?id=${pin.id}`;
      card.className = "card";
      card.style.display = "block";
      card.style.marginBottom = "0.75rem";
      card.innerHTML = `
        <div class="row-between">
          <strong>${escapeHtml(pin.title)}</strong>
          <span class="pill">${pin.visibility}</span>
        </div>
        <p class="muted" style="margin:0.25rem 0;">${escapeHtml(pin.category || "")}</p>
        <div class="muted">❤ ${likeCount} · 💬 ${commentCount}</div>
      `;
      cardsEl.appendChild(card);

      const row = document.createElement("tr");
      row.innerHTML = `
        <td><a href="pin.html?id=${pin.id}">${escapeHtml(pin.title)}</a></td>
        <td>${escapeHtml(pin.category || "")}</td>
        <td><span class="pill">${pin.visibility}</span></td>
        <td>${likeCount}</td>
        <td>${commentCount}</td>
      `;
      tableBodyEl.appendChild(row);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  await loadPins();
}
