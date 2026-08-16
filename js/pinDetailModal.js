import { supabase } from "./supabaseClient.js";
import { fetchPin, renderPostCard } from "./postCard.js";

// Half-screen popup (default 50vh, drag handle to expand to fullscreen or
// dismiss) — used everywhere a pin gets viewed in a modal. Pass
// startFull:true to open it already expanded (e.g. from Profile's grid,
// where a "quick look" should show the whole thing right away).
export async function openPinDetail(pinId, { onChange, startFull = false } = {}) {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal pin-detail-modal"><p class="muted">Loading…</p></div>`;
  document.body.appendChild(backdrop);
  const contentEl = backdrop.querySelector(".pin-detail-modal");

  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  const pin = await fetchPin(pinId);
  if (!pin) {
    contentEl.innerHTML = `<p class="error-text">Pin not found, or you don't have access to it.</p><button class="btn" id="pdCloseErr">Close</button>`;
    contentEl.querySelector("#pdCloseErr").addEventListener("click", close);
    return;
  }

  contentEl.innerHTML = "";
  await renderPostCard(pin, contentEl, {
    currentUserId: user.id,
    onChange,
    ownerMenuEnabled: true,
    onClose: close,
    startFull,
  });
}

// Back-compat alias — same popup, just always starts expanded.
export async function openPinDetailFullscreen(pinId, options = {}) {
  await openPinDetail(pinId, { ...options, startFull: true });
}
