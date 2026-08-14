import { supabase } from "./supabaseClient.js";
import { fetchPin, renderPostCard } from "./postCard.js";

// 2/3-height modal — used by Profile's pin grid and other "quick look"
// entry points.
export async function openPinDetail(pinId, { onChange } = {}) {
  await open(pinId, { onChange, backdropClass: "modal-backdrop", contentClass: "modal pin-detail-modal" });
}

// True full-screen — used from the Map's pin popup. Closing it leaves the
// map exactly where it was (it's just an overlay, nothing navigates away).
export async function openPinDetailFullscreen(pinId, { onChange } = {}) {
  await open(pinId, { onChange, backdropClass: "modal-backdrop-full", contentClass: "modal-full" });
}

async function open(pinId, { onChange, backdropClass, contentClass }) {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const backdrop = document.createElement("div");
  backdrop.className = backdropClass;
  backdrop.innerHTML = `<div class="${contentClass}"><p class="muted">Loading…</p></div>`;
  document.body.appendChild(backdrop);
  const contentEl = backdrop.querySelector(`.${contentClass.split(" ").join(".")}`);

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
  });
}
