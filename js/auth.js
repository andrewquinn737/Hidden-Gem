import { supabase } from "./supabaseClient.js";

const NAV_ITEMS = [
  {
    href: "profile.html",
    label: "Profile",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  },
  {
    href: "pins.html",
    label: "Discover",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.4-7-11.5A7 7 0 0 1 19 9.5C19 14.6 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  },
  {
    href: "index.html",
    label: "Map",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>',
  },
  {
    href: "scheduler.html",
    label: "Scheduler",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  },
];

export async function requireSession() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = "login.html";
    return null;
  }
  renderNav();

  // A session with no profile row is a rare edge case (nothing currently
  // reads the profile from here — pages that need it fetch it themselves).
  // Check it in the background instead of blocking every page load on a
  // second network round trip just to guard against that edge case.
  supabase
    .from("profiles")
    .select("id")
    .eq("id", session.user.id)
    .single()
    .then(({ data, error }) => {
      if (error || !data) window.location.href = "login.html";
    });

  return { user: session.user };
}

export function renderNav() {
  const mount = document.getElementById("topnav");
  if (!mount) return;
  const page = document.body.dataset.page || "";

  const desktopLinks = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="${page === item.href ? "active" : ""}">${item.label}</a>`
  ).join("");

  const mobileLinks = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="tab ${page === item.href ? "active" : ""}">${item.icon}<span>${item.label}</span></a>`
  ).join("");

  mount.innerHTML = `
    <div class="topnav-bar">
      <a href="index.html" class="brand">Hidden Gem</a>
      <nav class="topnav-links">${desktopLinks}</nav>
      <button id="signOutBtn" class="btn-link">Sign out</button>
    </div>
    <nav class="bottom-tabbar">${mobileLinks}</nav>
  `;

  document.getElementById("signOutBtn")?.addEventListener("click", signOut);
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = "login.html";
}
