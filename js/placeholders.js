// Shared placeholder icons — the dot-head outline is for missing *profile
// pictures* only; the map outline is for pins/posts with no photo. Keeping
// both in one place avoids the two getting swapped again by accident.
export const PERSON_OUTLINE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>`;

export const MAP_OUTLINE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`;

export function avatarPlaceholderHtml(className = "avatar", style = "") {
  return `<span class="${className} avatar-placeholder" style="${style}">${PERSON_OUTLINE_SVG}</span>`;
}

// Shimmering row placeholders for any plain list (friends, comments,
// upcoming visits) — same .skeleton-bar shimmer as postCardSkeleton
// (js/postCard.js), just arranged as simple rows instead of a full card,
// so every loading state in the app reads as one consistent system
// instead of a mix of skeletons and "Loading…" text.
export function skeletonListHtml(rows = 4, { avatar = false } = {}) {
  return Array.from({ length: rows }, () => `
    <div class="row skeleton-row">
      ${avatar ? '<span class="skeleton-bar skeleton-row-avatar"></span>' : ""}
      <div class="stack" style="flex:1; gap:0.35rem;">
        <span class="skeleton-bar" style="width:${avatar ? "45%" : "30%"}; height:0.8rem;"></span>
        ${avatar ? "" : '<span class="skeleton-bar" style="width:75%; height:0.75rem;"></span>'}
      </div>
    </div>
  `).join("");
}
