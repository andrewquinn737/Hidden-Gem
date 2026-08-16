import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { renderPostCard, postCardSkeleton } from "./postCard.js";

const session = await requireSession();
if (session) {
  await loadFeed();

  async function loadFeed() {
    const feedEl = document.getElementById("feed");
    feedEl.innerHTML = '<p class="muted">Loading…</p>';

    // No filters here on purpose — RLS already returns exactly what this
    // user is allowed to see: their own pins, friends' pins, and public
    // pins from anyone. This is the whole "Discover" feed.
    const { data: pins, error } = await supabase
      .from("pins")
      .select("id, title, description, directions, category, owner_id, lat, lng, created_at, pin_photos(storage_path, created_at), pin_likes(user_id), pin_saves(user_id), pin_comments(count), profiles!pins_owner_id_fkey(username, avatar_url)")
      .order("created_at", { ascending: false });

    if (error) {
      feedEl.innerHTML = `<p class="error-text">${error.message}</p>`;
      return;
    }
    if (!pins.length) {
      feedEl.innerHTML = '<p class="muted" style="text-align:center;">No pins to discover yet.</p>';
      return;
    }

    // Create placeholders in order first (so DOM order is guaranteed even
    // though the actual photo-signing fetches below run in parallel).
    feedEl.innerHTML = "";
    const slots = pins.map(() => {
      const el = document.createElement("article");
      el.className = "post-card";
      el.innerHTML = postCardSkeleton();
      feedEl.appendChild(el);
      return el;
    });

    await Promise.all(
      pins.map((pin, i) =>
        renderPostCard(pin, slots[i], {
          currentUserId: session.user.id,
          onChange: loadFeed,
          ownerMenuEnabled: true,
        })
      )
    );

    // Restore scroll position so leaving Discover (e.g. via a pin's map
    // link) and coming back lands where you left off, not back at the top.
    const savedScroll = sessionStorage.getItem("hg:discoverScroll");
    if (savedScroll) requestAnimationFrame(() => window.scrollTo(0, Number(savedScroll)));
  }

  window.addEventListener("scroll", () => {
    sessionStorage.setItem("hg:discoverScroll", String(window.scrollY));
  });
}
