import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { openPinDetailFullscreen } from "./pinDetailModal.js";
import { avatarPlaceholderHtml, skeletonListHtml } from "./placeholders.js";

const RESULT_LIMIT = 7;
const RECENT_KEY = "hg:recentSearches";
const RECENT_MAX = 6;

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveRecent(query) {
  const q = query.trim();
  if (!q) return;
  const existing = loadRecent().filter((r) => r.toLowerCase() !== q.toLowerCase());
  existing.unshift(q);
  localStorage.setItem(RECENT_KEY, JSON.stringify(existing.slice(0, RECENT_MAX)));
}

const session = await requireSession();
if (session) {
  const input = document.getElementById("appSearchInput");
  const resultsEl = document.getElementById("appSearchResults");
  input.focus();

  renderRecent();

  let debounceTimer = null;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (!q) {
      renderRecent();
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q), 250);
  });

  function renderRecent() {
    const recent = loadRecent();
    if (!recent.length) {
      resultsEl.innerHTML = "";
      return;
    }
    resultsEl.innerHTML = `
      <h3 style="margin:0.5rem 0 0;">Recent searches</h3>
      ${recent.map((q) => `<button type="button" class="search-result-row recent-search-row">${escapeHtml(q)}</button>`).join("")}
    `;
    resultsEl.querySelectorAll(".recent-search-row").forEach((row) => {
      row.addEventListener("click", () => {
        input.value = row.textContent;
        runSearch(row.textContent);
      });
    });
  }

  async function runSearch(q) {
    resultsEl.innerHTML = skeletonListHtml(4, { avatar: true });
    const [{ data: profiles }, { data: pins }] = await Promise.all([
      supabase.from("profiles").select("id, username, avatar_url").ilike("username", `%${q}%`).limit(RESULT_LIMIT),
      supabase.from("pins").select("id, title, category").eq("visibility", "public").ilike("title", `%${q}%`).limit(RESULT_LIMIT),
    ]);
    saveRecent(q);

    if (!profiles?.length && !pins?.length) {
      resultsEl.innerHTML = '<p class="muted">No matches.</p>';
      return;
    }

    resultsEl.innerHTML = "";
    if (profiles?.length) {
      const heading = document.createElement("h3");
      heading.style.margin = "0.5rem 0 0";
      heading.textContent = "Accounts";
      resultsEl.appendChild(heading);
      for (const p of profiles) {
        const row = document.createElement("button");
        row.className = "search-result-row";
        row.innerHTML = `${avatarPlaceholderHtml("avatar", "width:32px; height:32px;")}<span>${escapeHtml(p.username)}</span>`;
        row.addEventListener("click", () => {
          window.location.href = `profile.html?id=${p.id}`;
        });
        resultsEl.appendChild(row);
        if (p.avatar_url) {
          supabase.storage
            .from("media")
            .createSignedUrl(p.avatar_url, 3600)
            .then(({ data }) => {
              if (!data?.signedUrl) return;
              const placeholder = row.querySelector(".avatar-placeholder");
              const img = document.createElement("img");
              img.className = "avatar";
              img.style.cssText = "width:32px; height:32px;";
              img.src = data.signedUrl;
              placeholder.replaceWith(img);
            });
        }
      }
    }
    if (pins?.length) {
      const heading = document.createElement("h3");
      heading.style.margin = "1rem 0 0";
      heading.textContent = "Pins";
      resultsEl.appendChild(heading);
      for (const pin of pins) {
        const row = document.createElement("button");
        row.className = "search-result-row";
        row.innerHTML = `<span>${escapeHtml(pin.title)}</span>${pin.category ? `<span class="pill">${escapeHtml(pin.category)}</span>` : ""}`;
        row.addEventListener("click", () => {
          openPinDetailFullscreen(pin.id, {});
        });
        resultsEl.appendChild(row);
      }
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
