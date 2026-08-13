import { supabase } from "./supabaseClient.js";

const params = new URLSearchParams(window.location.search);
const token = params.get("token");
const root = document.getElementById("inviteRoot");

if (!token) {
  root.innerHTML = '<p class="error-text">Missing invite link.</p>';
} else {
  await render();
}

async function render() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  let kind = "pin";
  let { data: pinInvite } = await supabase.rpc("get_pin_invite_by_token", { p_token: token }).maybeSingle();
  let visitInvite = null;
  if (!pinInvite) {
    kind = "visit";
    const res = await supabase.rpc("get_visit_invite_by_token", { p_token: token }).maybeSingle();
    visitInvite = res.data;
  }

  if (!pinInvite && !visitInvite) {
    root.innerHTML = '<p class="error-text">This invite link is invalid or has expired.</p>';
    return;
  }

  const title = kind === "pin" ? pinInvite.pin_title : visitInvite.pin_title;
  const description =
    kind === "pin"
      ? pinInvite.pin_description
      : `Planned for ${new Date(visitInvite.scheduled_at).toLocaleString()}${visitInvite.notes ? " — " + visitInvite.notes : ""}`;

  root.innerHTML = `
    <div class="card stack">
      <h1 style="margin:0;">🗺️ You've been invited</h1>
      <h2 style="margin:0;">${escapeHtml(title)}</h2>
      ${description ? `<p class="muted">${escapeHtml(description)}</p>` : ""}
      <div id="inviteAction"></div>
    </div>
  `;

  const actionEl = document.getElementById("inviteAction");
  if (!session) {
    const redirect = encodeURIComponent(window.location.href);
    actionEl.innerHTML = `
      <p>Sign in or create an account to view and accept.</p>
      <div class="row">
        <a href="login.html?redirect=${redirect}" class="btn btn-primary" style="flex:1; text-align:center;">Sign in / Sign up</a>
      </div>
    `;
  } else {
    actionEl.innerHTML = `<button id="acceptBtn" class="btn btn-primary">Accept & view</button>`;
    document.getElementById("acceptBtn").addEventListener("click", async () => {
      if (kind === "pin") {
        const { data, error } = await supabase.rpc("accept_pin_invite", { p_token: token }).single();
        if (error) return alert(error.message);
        window.location.href = `pin.html?id=${data.pin_id}`;
      } else {
        const { error } = await supabase.rpc("accept_visit_invite", { p_token: token }).single();
        if (error) return alert(error.message);
        window.location.href = "scheduler.html";
      }
    });
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
