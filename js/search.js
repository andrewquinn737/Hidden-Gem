import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { openPinDetailFullscreen } from "./pinDetailModal.js";
import { avatarPlaceholderHtml, skeletonListHtml } from "./placeholders.js";

const RESULT_LIMIT = 7;
const RECENT_KEY = "hg:recentSearchResults";
const RECENT_MAX = 5;

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}
// Saves the actual account/pin the user tapped, not the raw query text.
function saveRecent(entry) {
  const existing = loadRecent().filter((r) => !(r.type === entry.type && r.id === entry.id));
  existing.unshift(entry);
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

  function goToProfile(id) {
    window.location.href = `profile.html?id=${id}`;
  }
  function goToPin(id) {
    openPinDetailFullscreen(id, {});
  }

  async function renderRecent() {
    const recent = loadRecent();
    if (!recent.length) {
      resultsEl.innerHTML = "";
      return;
    }
    resultsEl.innerHTML = `<h3 style="margin:0.5rem 0 0;">Recent searches</h3>${skeletonListHtml(recent.length, { avatar: true })}`;

    const avatarPaths = recent.filter((r) => r.type === "profile" && r.avatar_url).map((r) => r.avatar_url);
    const signedByPath = {};
    if (avatarPaths.length) {
      const { data: signed } = await supabase.storage.from("media").createSignedUrls(avatarPaths, 3600);
      (signed || []).forEach((s) => (signedByPath[s.path] = s.signedUrl));
    }

    resultsEl.innerHTML = `<h3 style="margin:0.5rem 0 0;">Recent searches</h3>`;
    for (const entry of recent) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "search-result-row";
      if (entry.type === "profile") {
        const avatarUrl = entry.avatar_url && signedByPath[entry.avatar_url];
        row.innerHTML = `${avatarUrl ? `<img class="avatar" style="width:32px; height:32px;" src="${avatarUrl}" />` : avatarPlaceholderHtml("avatar", "width:32px; height:32px;")}<span>${escapeHtml(entry.username)}</span>`;
        row.addEventListener("click", () => goToProfile(entry.id));
      } else {
        row.innerHTML = `<span>${escapeHtml(entry.title)}</span>${entry.category ? `<span class="pill">${escapeHtml(entry.category)}</span>` : ""}`;
        row.addEventListener("click", () => goToPin(entry.id));
      }
      resultsEl.appendChild(row);
    }
  }

  async function runSearch(q) {
    resultsEl.innerHTML = skeletonListHtml(4, { avatar: true });
    const [{ data: profiles }, { data: pins }] = await Promise.all([
      supabase.from("profiles").select("id, username, avatar_url").ilike("username", `%${q}%`).limit(RESULT_LIMIT),
      supabase.from("pins").select("id, title, category").eq("visibility", "public").ilike("title", `%${q}%`).limit(RESULT_LIMIT),
    ]);

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
          saveRecent({ type: "profile", id: p.id, username: p.username, avatar_url: p.avatar_url });
          goToProfile(p.id);
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
          saveRecent({ type: "pin", id: pin.id, title: pin.title, category: pin.category });
          goToPin(pin.id);
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

  // Keep the bottom tab bar pinned to the visual viewport's bottom edge
  // while the on-screen keyboard is open — otherwise mobile Safari lets
  // the page scroll the fixed bar up away from the true bottom of the
  // screen once the keyboard has resized the visual viewport.
  if (window.visualViewport) {
    const tabbar = document.querySelector(".bottom-tabbar");
    if (tabbar) {
      const repin = () => {
        const offset = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
        // translateZ(0) is also this element's GPU-compositing fix for a
        // separate iOS drift bug (see .bottom-tabbar in css/style.css) —
        // keep it in the same transform instead of overwriting it.
        tabbar.style.transform = offset > 0 ? `translateZ(0) translateY(-${offset}px)` : "translateZ(0)";
      };
      window.visualViewport.addEventListener("resize", repin);
      window.visualViewport.addEventListener("scroll", repin);
    }
  }
}
