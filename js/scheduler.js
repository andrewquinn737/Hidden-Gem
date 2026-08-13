import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";

const session = await requireSession();
if (session) {
  const params = new URLSearchParams(window.location.search);
  const prefillPinId = params.get("pinId");

  await loadConnections();
  await loadVisits();
  await loadPinOptions();

  if (prefillPinId) {
    document.getElementById("visitForm").style.display = "flex";
    document.getElementById("visitPinSelect").value = prefillPinId;
  }

  document.getElementById("planVisitBtn").addEventListener("click", () => {
    const form = document.getElementById("visitForm");
    form.style.display = form.style.display === "none" ? "flex" : "none";
  });

  document.getElementById("connectGoogleBtn").addEventListener("click", () => {
    alert("Google Calendar sync isn't connected yet — it needs a Google API credential first. Ask to have this wired up once you've created a Google Cloud OAuth client.");
  });
  document.getElementById("connectAppleBtn").addEventListener("click", () => {
    alert("Apple Calendar sync isn't wired up yet. It'll ask for an iCloud app-specific password (not your real Apple ID password) once the CalDAV integration is built.");
  });

  document.getElementById("visitForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("visitFormError");
    errorEl.style.display = "none";

    const pinId = document.getElementById("visitPinSelect").value;
    const when = document.getElementById("visitWhen").value;
    const notes = document.getElementById("visitNotes").value.trim() || null;
    const inviteesRaw = document.getElementById("visitInvitees").value.trim();

    if (!pinId || !when) {
      errorEl.textContent = "Pick a pin and a date/time.";
      errorEl.style.display = "block";
      return;
    }

    const { data: visit, error } = await supabase
      .from("visits")
      .insert({
        pin_id: pinId,
        organizer_id: session.user.id,
        scheduled_at: new Date(when).toISOString(),
        notes,
      })
      .select()
      .single();

    if (error) {
      errorEl.textContent = error.message;
      errorEl.style.display = "block";
      return;
    }

    const invitees = inviteesRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const invitee of invitees) {
      const isEmail = invitee.includes("@");
      const isPhone = /^\+?[0-9\-\s()]{7,}$/.test(invitee);
      if (isEmail) {
        await supabase.from("visit_participants").insert({ visit_id: visit.id, invite_email: invitee });
      } else if (isPhone) {
        await supabase.from("visit_participants").insert({ visit_id: visit.id, invite_phone: invitee });
      } else {
        const { data: profile } = await supabase.from("profiles").select("id").eq("username", invitee).maybeSingle();
        if (profile) {
          await supabase.from("visit_participants").insert({ visit_id: visit.id, user_id: profile.id });
        }
      }
    }

    document.getElementById("visitForm").reset();
    document.getElementById("visitForm").style.display = "none";
    await loadVisits();
  });

  async function loadConnections() {
    const { data } = await supabase.rpc("get_my_calendar_connections");
    const google = data?.find((c) => c.provider === "google");
    const apple = data?.find((c) => c.provider === "apple_caldav");
    document.getElementById("connectGoogleBtn").textContent = google ? "✓ Google Calendar connected" : "Connect Google Calendar";
    document.getElementById("connectAppleBtn").textContent = apple ? "✓ Apple Calendar connected" : "Connect Apple Calendar";
  }

  async function loadPinOptions() {
    const { data: pins } = await supabase.from("pins").select("id, title").order("title");
    const select = document.getElementById("visitPinSelect");
    select.innerHTML = '<option value="">Choose a pin…</option>' + (pins || []).map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`).join("");
  }

  async function loadVisits() {
    const listEl = document.getElementById("visitsList");
    const { data: visits, error } = await supabase
      .from("visits")
      .select("id, scheduled_at, notes, organizer_id, pins(title), visit_participants(id, user_id, invite_email, invite_phone, status)")
      .order("scheduled_at", { ascending: true });

    if (error) {
      listEl.innerHTML = `<p class="error-text">${error.message}</p>`;
      return;
    }
    if (!visits.length) {
      listEl.innerHTML = '<p class="muted">No visits planned yet.</p>';
      return;
    }

    listEl.innerHTML = "";
    visits.forEach((v) => {
      const when = new Date(v.scheduled_at);
      const participants = (v.visit_participants || [])
        .map((p) => p.invite_email || p.invite_phone || (p.user_id === session.user.id ? "you" : "invitee"))
        .join(", ");
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = `
        <div class="row-between">
          <strong>${escapeHtml(v.pins?.title || "Untitled pin")}</strong>
          <span class="muted">${when.toLocaleString()}</span>
        </div>
        ${v.notes ? `<p class="muted">${escapeHtml(v.notes)}</p>` : ""}
        ${participants ? `<p class="muted">With: ${escapeHtml(participants)}</p>` : ""}
      `;
      listEl.appendChild(el);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
