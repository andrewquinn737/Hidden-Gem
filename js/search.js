import { supabase } from "./supabaseClient.js";
import { openPinDetailFullscreen } from "./pinDetailModal.js";

// App-wide search — full-screen popup, searches accounts and public pins
// together. Triggered from the nav (see js/auth.js), available on every
// page since auth.js is loaded everywhere.
export function openSearchModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop-full search-modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal-full stack">
      <div class="row" style="gap:0.5rem;">
        <input id="appSearchInput" placeholder="Search accounts or pins…" autofocus />
        <button id="appSearchClose" class="btn-link" style="font-size:1.4rem; padding:0.2rem 0.5rem;">✕</button>
      </div>
      <div id="appSearchResults" class="stack"></div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector("#appSearchClose").addEventListener("click", close);

  const input = backdrop.querySelector("#appSearchInput");
  const resultsEl = backdrop.querySelector("#appSearchResults");
  input.focus();

  let debounceTimer = null;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (!q) {
      resultsEl.innerHTML = "";
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q), 250);
  });

  async function runSearch(q) {
    resultsEl.innerHTML = '<p class="muted">Searching…</p>';
    const [{ data: profiles }, { data: pins }] = await Promise.all([
      supabase.from("profiles").select("id, username, avatar_url").ilike("username", `%${q}%`).limit(10),
      supabase.from("pins").select("id, title, category").eq("visibility", "public").ilike("title", `%${q}%`).limit(10),
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
        row.innerHTML = `<img class="avatar" style="width:32px; height:32px;" src="icons/icon-192.png" /><span>${escapeHtml(p.username)}</span>`;
        row.addEventListener("click", () => {
          window.location.href = `profile.html?id=${p.id}`;
        });
        resultsEl.appendChild(row);
        if (p.avatar_url) {
          supabase.storage
            .from("media")
            .createSignedUrl(p.avatar_url, 3600)
            .then(({ data }) => {
              if (data?.signedUrl) row.querySelector(".avatar").src = data.signedUrl;
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
          close();
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
