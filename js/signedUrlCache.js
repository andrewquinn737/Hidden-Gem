import { supabase } from "./supabaseClient.js";

// createSignedUrl() mints a fresh token on every call, even for the same
// file — a different URL string means the browser's HTTP cache treats it
// as a brand-new resource and re-downloads the full image every time it's
// rendered, even on a page you already visited. Caching the URL itself
// (not just re-deriving it) lets the browser's own cache actually work.
const CACHE_TTL_MS = 55 * 60 * 1000; // just under the 1hr signed URL expiry
const cache = new Map(); // storage_path -> { url, expiresAt }

function fresh(path) {
  const entry = cache.get(path);
  return entry && entry.expiresAt > Date.now() ? entry.url : null;
}

export async function getSignedUrl(path) {
  if (!path) return null;
  const cached = fresh(path);
  if (cached) return cached;
  const { data } = await supabase.storage.from("media").createSignedUrl(path, 3600);
  if (!data?.signedUrl) return null;
  cache.set(path, { url: data.signedUrl, expiresAt: Date.now() + CACHE_TTL_MS });
  return data.signedUrl;
}

// Mirrors createSignedUrls' shape: returns urls in the same order as the
// input paths (null for any that failed), while only fetching whichever
// paths weren't already cached.
export async function getSignedUrls(paths) {
  const missing = [...new Set(paths.filter((p) => p && !fresh(p)))];
  if (missing.length) {
    const { data } = await supabase.storage.from("media").createSignedUrls(missing, 3600);
    const now = Date.now();
    (data || []).forEach((entry) => {
      if (entry.signedUrl) cache.set(entry.path, { url: entry.signedUrl, expiresAt: now + CACHE_TTL_MS });
    });
  }
  return paths.map((p) => (p ? fresh(p) : null));
}
