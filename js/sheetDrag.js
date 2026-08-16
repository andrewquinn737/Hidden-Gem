// Shared bottom-sheet/half-screen popup drag behavior, used by every
// .pin-detail-modal-based popup (pin detail, comments, friends,
// notifications, visit detail, share overlay, pin form).
//
// Three discrete snap states based on where the drag ends, regardless of
// which state it started in: released near the top -> full screen,
// released near the bottom -> dismissed, anywhere else -> back to the
// default half-height. Height is driven directly (not a translate), so a
// short popup's content just leaves whitespace below it as it grows,
// instead of the whole box sliding and ending up stranded mid-screen.
export function setupSheetDrag(modalEl, { onDismiss, startFull = false } = {}) {
  const hitArea = modalEl.querySelector(".post-header-center");
  if (!hitArea) return;
  if (startFull) modalEl.classList.add("sheet-full");

  let dragging = false;
  let startY = 0;
  let baseHeight = 0;
  let lastHeight = 0;

  hitArea.addEventListener("pointerdown", (e) => {
    dragging = true;
    startY = e.clientY;
    baseHeight = modalEl.getBoundingClientRect().height;
    lastHeight = baseHeight;
    modalEl.style.transition = "none";
    hitArea.setPointerCapture?.(e.pointerId);
  });

  hitArea.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY; // positive = dragged up
    lastHeight = Math.min(window.innerHeight, Math.max(80, baseHeight + dy));
    modalEl.style.height = `${lastHeight}px`;
    modalEl.style.maxHeight = `${lastHeight}px`;
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    modalEl.style.transition = "";
    modalEl.style.height = "";
    modalEl.style.maxHeight = "";

    const vh = window.innerHeight;
    if (lastHeight >= vh * 0.85) {
      modalEl.classList.add("sheet-full");
    } else if (lastHeight <= vh * 0.25) {
      onDismiss?.();
    } else {
      modalEl.classList.remove("sheet-full");
    }
  };

  hitArea.addEventListener("pointerup", end);
  hitArea.addEventListener("pointercancel", end);
}
