import { supabase } from "./supabaseClient.js";
import { fetchPin, renderPostCard } from "./postCard.js";

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

  const pin = await fetchPin(pinId);
  if (!pin) {
    modalEl.innerHTML = `<p class="error-text">Pin not found, or you don't have access to it.</p><button class="btn" id="pdCloseErr">Close</button>`;
    modalEl.querySelector("#pdCloseErr").addEventListener("click", close);
    return;
  }

  modalEl.innerHTML = "";
  await renderPostCard(pin, modalEl, {
    currentUserId: user.id,
    onChange,
    ownerMenuEnabled: true,
    onClose: close,
  });
}
