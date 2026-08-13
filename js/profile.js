import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";

const session = await requireSession();
if (session) {
  await loadProfile();
  await loadCounts();
  await loadConnections();

  async function loadProfile() {
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();
    document.getElementById("usernameInput").value = profile.username || "";
    document.getElementById("fullNameInput").value = profile.full_name || "";
    document.getElementById("bioInput").value = profile.bio || "";
    if (profile.avatar_url) {
      const { data } = await supabase.storage.from("media").createSignedUrl(profile.avatar_url, 3600);
      if (data?.signedUrl) document.getElementById("avatarImg").src = data.signedUrl;
    }
  }

  async function loadCounts() {
    const [{ count: followerCount }, { count: followingCount }, { count: pinCount }] = await Promise.all([
      supabase.from("follows").select("*", { count: "exact", head: true }).eq("followee_id", session.user.id),
      supabase.from("follows").select("*", { count: "exact", head: true }).eq("follower_id", session.user.id),
      supabase.from("pins").select("*", { count: "exact", head: true }).eq("owner_id", session.user.id),
    ]);
    document.getElementById("statFollowers").textContent = followerCount ?? 0;
    document.getElementById("statFollowing").textContent = followingCount ?? 0;
    document.getElementById("statPins").textContent = pinCount ?? 0;
  }

  async function loadConnections() {
    const { data } = await supabase.rpc("get_my_calendar_connections");
    const google = data?.find((c) => c.provider === "google");
    const apple = data?.find((c) => c.provider === "apple_caldav");
    document.getElementById("googleStatus").textContent = google ? "Connected" : "Not connected";
    document.getElementById("appleStatus").textContent = apple ? "Connected" : "Not connected";
  }

  document.getElementById("avatarInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const path = `avatars/${session.user.id}/${Date.now()}-${file.name}`;
    const { error: uploadError } = await supabase.storage.from("media").upload(path, file);
    if (uploadError) return alert(uploadError.message);
    await supabase.from("profiles").update({ avatar_url: path }).eq("id", session.user.id);
    await loadProfile();
  });

  setupShareAndInstall();

  function setupShareAndInstall() {
    const shareBtn = document.getElementById("shareAppBtn");
    const installBtn = document.getElementById("installAppBtn");
    const statusEl = document.getElementById("shareStatus");

    const isStandalone =
      window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
    if (isStandalone) installBtn.style.display = "none";

    shareBtn.addEventListener("click", async () => {
      const shareData = {
        title: "Hidden Gem",
        text: "Find it. Mark it. Share it. Join me on Hidden Gem.",
        url: window.location.origin,
      };
      if (navigator.share) {
        try {
          await navigator.share(shareData);
        } catch {
          // user cancelled the share sheet — nothing to do
        }
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(shareData.url);
        statusEl.textContent = "Link copied to clipboard.";
        statusEl.style.display = "block";
      }
    });

    installBtn.addEventListener("click", async () => {
      const deferred = window.__deferredInstallPrompt;
      if (deferred) {
        deferred.prompt();
        await deferred.userChoice;
        window.__deferredInstallPrompt = null;
        return;
      }
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
      statusEl.style.display = "block";
      statusEl.textContent = isIOS
        ? 'To install: tap the Share icon in Safari, then "Add to Home Screen".'
        : 'Open your browser\'s menu and look for "Install app" or "Add to Home Screen".';
    });
  }

  document.getElementById("profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("profileFormError");
    errorEl.style.display = "none";
    const username = document.getElementById("usernameInput").value.trim();
    const full_name = document.getElementById("fullNameInput").value.trim() || null;
    const bio = document.getElementById("bioInput").value.trim() || null;
    const { error } = await supabase.from("profiles").update({ username, full_name, bio }).eq("id", session.user.id);
    if (error) {
      errorEl.textContent = error.message;
      errorEl.style.display = "block";
    } else {
      document.getElementById("profileSaved").style.display = "block";
      setTimeout(() => (document.getElementById("profileSaved").style.display = "none"), 2000);
    }
  });
}
