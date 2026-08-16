import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { renderPostCard, postCardSkeleton } from "./postCard.js";

const PAGE_SIZE = 15;
const SELECT_COLUMNS =
  "id, title, description, directions, category, owner_id, lat, lng, created_at, pin_photos(storage_path, created_at), pin_likes(user_id), pin_saves(user_id), pin_comments(count), profiles!pins_owner_id_fkey(username, avatar_url)";

const session = await requireSession();
if (session) {
  const feedEl = document.getElementById("feed");
  let offset = 0;
  let allLoaded = false;
  let loading = false;
  let sentinelObserver = null;

  feedEl.innerHTML = `<article class="post-card">${postCardSkeleton()}</article><article class="post-card">${postCardSkeleton()}</article>`;
  await loadMore(true);

  // Edit-save/delete trigger a full reset back to page one rather than
  // trying to patch pagination state in place — infrequent enough that
  // simplicity wins over preserving scroll-page position exactly.
  function resetAndReload() {
    offset = 0;
    allLoaded = false;
    sentinelObserver?.disconnect();
    loadMore(true);
  }

  // No filters here on purpose — RLS already returns exactly what this
  // user is allowed to see: their own pins, following's pins, and public
  // pins from anyone. This is the whole "Discover" feed, just paginated.
  async function loadMore(isFirst = false) {
    if (loading || allLoaded) return;
    loading = true;

    const { data: pins, error } = await supabase
      .from("pins")
      .select(SELECT_COLUMNS)
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      if (isFirst) feedEl.innerHTML = `<p class="error-text">${error.message}</p>`;
      loading = false;
      return;
    }
    if (isFirst && !pins.length) {
      feedEl.innerHTML = '<p class="muted" style="text-align:center;">No pins to discover yet.</p>';
      loading = false;
      return;
    }
    if (isFirst) feedEl.innerHTML = "";
    if (pins.length < PAGE_SIZE) allLoaded = true;
    offset += pins.length;

    // Create placeholders in order first (so DOM order is guaranteed even
    // though the actual photo-signing fetches below run in parallel).
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
          onChange: resetAndReload,
          ownerMenuEnabled: true,
        })
      )
    );

    loading = false;
    watchForNextPage();

    if (isFirst) {
      // Restore scroll position so leaving Discover (e.g. via a pin's map
      // link) and coming back lands where you left off, not back at top.
      const savedScroll = sessionStorage.getItem("hg:discoverScroll");
      if (savedScroll) requestAnimationFrame(() => window.scrollTo(0, Number(savedScroll)));
    }
  }

  // Loads the next 15 once the card 3 from the bottom scrolls into view —
  // tracking an actual card (not a fixed pixel/scroll-top threshold) means
  // "3 posts from the bottom" holds regardless of how tall any given card
  // renders (photos vs. none, expanded captions, etc.).
  function watchForNextPage() {
    sentinelObserver?.disconnect();
    if (allLoaded) return;
    const cards = feedEl.querySelectorAll(".post-card");
    const triggerEl = cards[Math.max(0, cards.length - 3)];
    if (!triggerEl) return;
    sentinelObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        sentinelObserver.disconnect();
        loadMore();
      }
    });
    sentinelObserver.observe(triggerEl);
  }

  window.addEventListener("scroll", () => {
    sessionStorage.setItem("hg:discoverScroll", String(window.scrollY));
  });
}
