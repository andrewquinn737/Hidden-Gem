// Lightweight crop-to-fixed-aspect tool used by the pin photo picker, so
// every post ends up with the same slightly-taller-than-square framing.
// Returns a Promise<File|null> (null if the user cancels).
const ASPECT = 4 / 5; // width / height
const OUTPUT_W = 900;
const OUTPUT_H = Math.round(OUTPUT_W / ASPECT);

export function cropImageToAspect(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.style.zIndex = "300";
      backdrop.innerHTML = `
        <div class="modal stack crop-modal">
          <h2 style="margin:0;">Crop photo</h2>
          <div class="crop-frame">
            <img class="crop-img" src="${url}" draggable="false" />
          </div>
          <p class="muted" style="margin:0; font-size:0.8rem; text-align:center;">Drag to reposition</p>
          <div class="row">
            <button type="button" class="btn crop-cancel" style="flex:1;">Cancel</button>
            <button type="button" class="btn btn-primary crop-use" style="flex:1;">Use photo</button>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);

      const frame = backdrop.querySelector(".crop-frame");
      const cropImg = backdrop.querySelector(".crop-img");
      let scale = 1;
      let panX = 0;
      let panY = 0;

      function clampPan() {
        const frameW = frame.clientWidth;
        const frameH = frame.clientHeight;
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        panX = Math.min(0, Math.max(frameW - w, panX));
        panY = Math.min(0, Math.max(frameH - h, panY));
      }
      function apply() {
        cropImg.style.width = `${img.naturalWidth * scale}px`;
        cropImg.style.height = `${img.naturalHeight * scale}px`;
        cropImg.style.transform = `translate(${panX}px, ${panY}px)`;
      }
      function layout() {
        const frameW = frame.clientWidth;
        const frameH = frame.clientHeight;
        scale = Math.max(frameW / img.naturalWidth, frameH / img.naturalHeight);
        panX = (frameW - img.naturalWidth * scale) / 2;
        panY = (frameH - img.naturalHeight * scale) / 2;
        apply();
      }
      requestAnimationFrame(layout);

      let dragging = false;
      let startX = 0;
      let startY = 0;
      let startPanX = 0;
      let startPanY = 0;
      frame.addEventListener("pointerdown", (e) => {
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startPanX = panX;
        startPanY = panY;
        frame.setPointerCapture(e.pointerId);
      });
      frame.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        panX = startPanX + (e.clientX - startX);
        panY = startPanY + (e.clientY - startY);
        clampPan();
        apply();
      });
      const endDrag = () => {
        dragging = false;
      };
      frame.addEventListener("pointerup", endDrag);
      frame.addEventListener("pointercancel", endDrag);

      function cleanup() {
        URL.revokeObjectURL(url);
        backdrop.remove();
      }

      backdrop.querySelector(".crop-cancel").addEventListener("click", () => {
        cleanup();
        resolve(null);
      });
      backdrop.querySelector(".crop-use").addEventListener("click", () => {
        const frameW = frame.clientWidth;
        const frameH = frame.clientHeight;
        const canvas = document.createElement("canvas");
        canvas.width = OUTPUT_W;
        canvas.height = OUTPUT_H;
        const ctx = canvas.getContext("2d");
        const sx = -panX / scale;
        const sy = -panY / scale;
        const sw = frameW / scale;
        const sh = frameH / scale;
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, OUTPUT_W, OUTPUT_H);
        canvas.toBlob(
          (blob) => {
            cleanup();
            if (!blob) return resolve(null);
            const baseName = (file.name || "photo").replace(/\.[^.]+$/, "");
            resolve(new File([blob], `${baseName}.jpg`, { type: "image/jpeg" }));
          },
          "image/jpeg",
          0.88
        );
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}
