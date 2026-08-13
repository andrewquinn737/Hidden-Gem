if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.error("SW registration failed", err));
  });
}

// Chrome/Edge/Android fire this instead of showing their own install UI,
// so we can offer an "Install app" button later (e.g. on the Profile page).
// iOS Safari never fires this — there's no programmatic install trigger
// there, only the manual Share > Add to Home Screen path.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__deferredInstallPrompt = e;
});
window.addEventListener("appinstalled", () => {
  window.__deferredInstallPrompt = null;
});
