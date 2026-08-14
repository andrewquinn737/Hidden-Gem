import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";

const session = await requireSession();
if (session) {
  const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => {
    const period = h < 12 ? "AM" : "PM";
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12} ${period}`;
  });

  let viewMode = "day"; // "day" | "week" | "month"
  let currentDate = startOfDay(new Date());
  let monthAnchor = startOfMonth(currentDate);
  let draftEvent = null; // { pinId, pinTitle, hour, minute } — null pinId means "needs a pin"
  let visitsCache = []; // visits currently loaded for the visible range

  const params = new URLSearchParams(window.location.search);
  const prefillPinId = params.get("pinId");
  if (prefillPinId) {
    const { data: pin } = await supabase.from("pins").select("id, title").eq("id", prefillPinId).maybeSingle();
    if (pin) {
      const now = new Date();
      draftEvent = { pinId: pin.id, pinTitle: pin.title, hour: now.getHours(), minute: now.getMinutes() < 30 ? 0 : 30 };
    }
  }

  setupViewTabs();
  setupDayNav();
  setupMonthNav();
  setupUpcomingToggle();
  setupSchedMenu();
  setupDayGestures();
  await switchView("day");

  function setupViewTabs() {
    document.querySelectorAll("[data-view]").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });
  }

  async function switchView(mode) {
    viewMode = mode;
    document.getElementById("upcomingView").style.display = "none";
    document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("btn-primary", b.dataset.view === mode));
    document.getElementById("dayNav").style.display = mode === "day" ? "flex" : "none";
    document.getElementById("dayView").style.display = mode === "day" ? "block" : "none";
    document.getElementById("weekView").style.display = mode === "week" ? "grid" : "none";
    document.getElementById("monthView").style.display = mode === "month" ? "block" : "none";

    if (mode === "day") await renderDayView();
    else if (mode === "week") await renderWeekView();
    else await renderMonthView();
  }

  // ============================================================
  // Day view
  // ============================================================
  function setupDayNav() {
    document.getElementById("dayPrevBtn").addEventListener("click", () => changeDay(-1));
    document.getElementById("dayNextBtn").addEventListener("click", () => changeDay(1));
  }

  async function changeDay(delta) {
    currentDate = addDays(currentDate, delta);
    await renderDayView();
  }

  async function renderDayView() {
    document.getElementById("dayNavLabel").textContent = currentDate.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });

    const dayStart = currentDate;
    const dayEnd = addDays(currentDate, 1);
    visitsCache = await fetchVisits(dayStart, dayEnd);

    const grid = document.getElementById("dayView");
    grid.innerHTML = "";
    for (let h = 0; h < 24; h++) {
      const row = document.createElement("div");
      row.className = "cal-hour-row";
      row.dataset.hour = h;
      row.innerHTML = `<div class="cal-hour-label">${HOUR_LABELS[h]}</div><div class="cal-hour-slot" data-hour="${h}"></div>`;
      grid.appendChild(row);
    }

    for (const visit of visitsCache) {
      const d = new Date(visit.scheduled_at);
      const slot = grid.querySelector(`.cal-hour-slot[data-hour="${d.getHours()}"]`);
      slot?.appendChild(renderEventChip(visit));
    }

    if (draftEvent) {
      const slot = grid.querySelector(`.cal-hour-slot[data-hour="${draftEvent.hour}"]`);
      slot?.appendChild(renderDraftChip());
    }

    // Scroll to something useful: current hour if viewing today, else the
    // earliest event, else mid-morning.
    const scrollHour = isSameDay(currentDate, new Date()) ? new Date().getHours() : draftEvent?.hour ?? 8;
    const target = grid.querySelector(`.cal-hour-row[data-hour="${Math.max(scrollHour - 1, 0)}"]`);
    target?.scrollIntoView({ block: "start" });
  }

  function renderEventChip(visit) {
    const chip = document.createElement("div");
    chip.className = "calendar-event";
    const d = new Date(visit.scheduled_at);
    chip.textContent = `${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · ${visit.pins?.title ?? "Pin"}`;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      openVisitDetail(visit);
    });
    return chip;
  }

  function renderDraftChip() {
    const chip = document.createElement("div");
    chip.className = "calendar-event draft";
    const label = draftEvent.pinTitle || "New event — pick a pin";
    const timeLabel = formatHourMinute(draftEvent.hour, draftEvent.minute);
    chip.textContent = `${timeLabel} · ${label} (tap to confirm)`;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      openConfirmDraftModal();
    });
    return chip;
  }

  // Swipe left/right to change day, long-press an empty slot to start a
  // new draft event there. Pointer Events unify mouse + touch.
  function setupDayGestures() {
    const grid = document.getElementById("dayView");
    let pointerStart = null;
    let longPressTimer = null;
    let longPressFired = false;

    grid.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".calendar-event")) return;
      const slot = e.target.closest(".cal-hour-slot");
      pointerStart = { x: e.clientX, y: e.clientY, time: Date.now(), hour: slot ? Number(slot.dataset.hour) : null };
      longPressFired = false;
      longPressTimer = setTimeout(() => {
        if (pointerStart && pointerStart.hour != null) {
          longPressFired = true;
          draftEvent = { pinId: null, pinTitle: null, hour: pointerStart.hour, minute: 0 };
          renderDayView();
        }
      }, 500);
    });

    grid.addEventListener("pointermove", (e) => {
      if (!pointerStart) return;
      const dx = Math.abs(e.clientX - pointerStart.x);
      const dy = Math.abs(e.clientY - pointerStart.y);
      if (dx > 10 || dy > 10) clearTimeout(longPressTimer);
    });

    grid.addEventListener("pointerup", (e) => {
      clearTimeout(longPressTimer);
      if (longPressFired || !pointerStart) {
        pointerStart = null;
        return;
      }
      const dx = e.clientX - pointerStart.x;
      const dt = Date.now() - pointerStart.time;
      if (Math.abs(dx) > 60 && dt < 800) {
        changeDay(dx > 0 ? -1 : 1);
      }
      pointerStart = null;
    });

    grid.addEventListener("pointercancel", () => {
      clearTimeout(longPressTimer);
      pointerStart = null;
    });
  }

  // ============================================================
  // Week view
  // ============================================================
  async function renderWeekView() {
    const weekStart = startOfWeek(currentDate);
    const weekEnd = addDays(weekStart, 7);
    const visits = await fetchVisits(weekStart, weekEnd);

    const grid = document.getElementById("weekView");
    grid.innerHTML = "";
    for (let i = 0; i < 7; i++) {
      const day = addDays(weekStart, i);
      const dayVisits = visits.filter((v) => isSameDay(new Date(v.scheduled_at), day));
      const col = document.createElement("div");
      col.className = "cal-week-col";
      col.innerHTML = `
        <div class="cal-week-col-header ${isSameDay(day, new Date()) ? "today" : ""}">${day.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</div>
        <div class="cal-week-col-events"></div>
      `;
      col.querySelector(".cal-week-col-header").addEventListener("click", () => {
        currentDate = day;
        switchView("day");
        document.querySelector('[data-view="day"]').scrollIntoView?.();
      });
      const eventsEl = col.querySelector(".cal-week-col-events");
      dayVisits
        .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))
        .forEach((v) => eventsEl.appendChild(renderEventChip(v)));
      if (draftEvent && isSameDay(day, currentDate)) eventsEl.appendChild(renderDraftChip());
      grid.appendChild(col);
    }
  }

  // ============================================================
  // Month view
  // ============================================================
  function setupMonthNav() {
    document.getElementById("monthPrevBtn").addEventListener("click", () => {
      monthAnchor = addMonths(monthAnchor, -1);
      renderMonthView();
    });
    document.getElementById("monthNextBtn").addEventListener("click", () => {
      monthAnchor = addMonths(monthAnchor, 1);
      renderMonthView();
    });
  }

  async function renderMonthView() {
    document.getElementById("monthNavLabel").textContent = monthAnchor.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });

    const gridStart = startOfWeek(monthAnchor);
    const gridEnd = addDays(gridStart, 42);
    const visits = await fetchVisits(gridStart, gridEnd);

    const monthGrid = document.getElementById("monthGrid");
    monthGrid.innerHTML = "";
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((d) => {
      const el = document.createElement("div");
      el.className = "cal-month-weekday";
      el.textContent = d;
      monthGrid.appendChild(el);
    });

    for (let i = 0; i < 42; i++) {
      const day = addDays(gridStart, i);
      const dayVisits = visits.filter((v) => isSameDay(new Date(v.scheduled_at), day));
      const cell = document.createElement("div");
      cell.className = "cal-month-cell";
      if (day.getMonth() !== monthAnchor.getMonth()) cell.classList.add("other-month");
      if (isSameDay(day, new Date())) cell.classList.add("today");
      cell.innerHTML = `<span class="cal-month-daynum">${day.getDate()}</span>${dayVisits.length ? '<span class="cal-month-dot"></span>' : ""}`;
      cell.addEventListener("click", () => {
        currentDate = day;
        switchView("day");
      });
      monthGrid.appendChild(cell);
    }
  }

  // ============================================================
  // Upcoming events
  // ============================================================
  function setupUpcomingToggle() {
    const btn = document.getElementById("upcomingBtn");
    btn.addEventListener("click", async () => {
      const showing = document.getElementById("upcomingView").style.display !== "none";
      if (showing) {
        btn.classList.remove("btn-primary");
        document.getElementById("upcomingView").style.display = "none";
        switchView(viewMode);
      } else {
        btn.classList.add("btn-primary");
        document.getElementById("dayNav").style.display = "none";
        document.getElementById("dayView").style.display = "none";
        document.getElementById("weekView").style.display = "none";
        document.getElementById("monthView").style.display = "none";
        await renderUpcoming();
      }
    });
  }

  async function renderUpcoming() {
    const el = document.getElementById("upcomingView");
    el.style.display = "flex";
    el.innerHTML = '<p class="muted">Loading…</p>';

    const { data: visits, error } = await supabase
      .from("visits")
      .select("id, scheduled_at, notes, organizer_id, pins(title), visit_participants(id, user_id, invite_email, invite_phone, status)")
      .gte("scheduled_at", new Date().toISOString())
      .order("scheduled_at", { ascending: true });

    if (error) {
      el.innerHTML = `<p class="error-text">${error.message}</p>`;
      return;
    }
    if (!visits.length) {
      el.innerHTML = '<p class="muted">No upcoming visits planned.</p>';
      return;
    }

    el.innerHTML = "";
    visits.forEach((v) => {
      const when = new Date(v.scheduled_at);
      const participants = (v.visit_participants || [])
        .map((p) => p.invite_email || p.invite_phone || (p.user_id === session.user.id ? "you" : "invitee"))
        .join(", ");
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="row-between">
          <strong>${escapeHtml(v.pins?.title || "Untitled pin")}</strong>
          <span class="muted">${when.toLocaleString()}</span>
        </div>
        ${v.notes ? `<p class="muted">${escapeHtml(v.notes)}</p>` : ""}
        ${participants ? `<p class="muted">With: ${escapeHtml(participants)}</p>` : ""}
      `;
      el.appendChild(card);
    });
  }

  // ============================================================
  // 3-dot menu (calendar connections)
  // ============================================================
  function setupSchedMenu() {
    const menuBtn = document.getElementById("schedMenuBtn");
    const dropdown = document.getElementById("schedMenuDropdown");
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === "none" ? "flex" : "none";
    });
    document.addEventListener("click", () => (dropdown.style.display = "none"));

    document.getElementById("connectGoogleBtn").addEventListener("click", () => {
      alert("Google Calendar sync isn't connected yet — it needs a Google API credential first.");
    });
    document.getElementById("connectAppleBtn").addEventListener("click", () => {
      alert("Apple Calendar sync isn't wired up yet. It'll ask for an iCloud app-specific password once the CalDAV integration is built.");
    });
  }

  // ============================================================
  // Confirm-draft modal — finalizes a draft into a real visit
  // ============================================================
  async function openConfirmDraftModal() {
    const needsPin = !draftEvent.pinId;
    let pinOptions = "";
    if (needsPin) {
      const { data: pins } = await supabase.from("pins").select("id, title").order("title");
      pinOptions = (pins || []).map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`).join("");
    }

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal stack">
        <h2 style="margin:0;">Confirm visit</h2>
        <form id="confirmDraftForm" class="stack">
          ${
            needsPin
              ? `<div><label class="field-label" for="draftPinSelect">Pin</label><select id="draftPinSelect" required><option value="">Choose a pin…</option>${pinOptions}</select></div>`
              : `<div><label class="field-label">Pin</label><input value="${escapeAttr(draftEvent.pinTitle)}" disabled /></div>`
          }
          <div>
            <label class="field-label" for="draftDate">Date</label>
            <input id="draftDate" type="date" value="${toDateInputValue(currentDate)}" required />
          </div>
          <div>
            <label class="field-label" for="draftTime">Time</label>
            <input id="draftTime" type="time" value="${toTimeInputValue(draftEvent.hour, draftEvent.minute)}" required />
          </div>
          <div>
            <label class="field-label" for="draftNotes">Notes</label>
            <textarea id="draftNotes" rows="2"></textarea>
          </div>
          <div>
            <label class="field-label" for="draftInvitees">Invite by username, email, or phone</label>
            <input id="draftInvitees" placeholder="comma separated" />
          </div>
          <p class="error-text" id="draftFormError" style="display:none;"></p>
          <div class="row">
            <button type="button" id="draftCancelBtn" class="btn" style="flex:1;">Cancel</button>
            <button type="submit" class="btn btn-primary" style="flex:1;">Confirm</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector("#draftCancelBtn").addEventListener("click", close);

    backdrop.querySelector("#confirmDraftForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = backdrop.querySelector("#draftFormError");
      errorEl.style.display = "none";

      const pinId = needsPin ? backdrop.querySelector("#draftPinSelect").value : draftEvent.pinId;
      const dateVal = backdrop.querySelector("#draftDate").value;
      const timeVal = backdrop.querySelector("#draftTime").value;
      const notes = backdrop.querySelector("#draftNotes").value.trim() || null;
      const inviteesRaw = backdrop.querySelector("#draftInvitees").value.trim();

      if (!pinId || !dateVal || !timeVal) {
        errorEl.textContent = "A pin, date, and time are all required to confirm.";
        errorEl.style.display = "block";
        return;
      }

      const scheduledAt = new Date(`${dateVal}T${timeVal}`);

      const { data: visit, error } = await supabase
        .from("visits")
        .insert({ pin_id: pinId, organizer_id: session.user.id, scheduled_at: scheduledAt.toISOString(), notes })
        .select()
        .single();

      if (error) {
        errorEl.textContent = error.message;
        errorEl.style.display = "block";
        return;
      }

      const invitees = inviteesRaw.split(",").map((s) => s.trim()).filter(Boolean);
      for (const invitee of invitees) {
        const isEmail = invitee.includes("@");
        const isPhone = /^\+?[0-9\-\s()]{7,}$/.test(invitee);
        if (isEmail) await supabase.from("visit_participants").insert({ visit_id: visit.id, invite_email: invitee });
        else if (isPhone) await supabase.from("visit_participants").insert({ visit_id: visit.id, invite_phone: invitee });
        else {
          const { data: profile } = await supabase.from("profiles").select("id").eq("username", invitee).maybeSingle();
          if (profile) await supabase.from("visit_participants").insert({ visit_id: visit.id, user_id: profile.id });
        }
      }

      draftEvent = null;
      close();
      currentDate = startOfDay(scheduledAt);
      switchView("day");
    });
  }

  // ============================================================
  // Existing-visit detail popup
  // ============================================================
  function openVisitDetail(visit) {
    const when = new Date(visit.scheduled_at);
    const isOrganizer = visit.organizer_id === session.user.id;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal stack">
        <h2 style="margin:0;">${escapeHtml(visit.pins?.title || "Visit")}</h2>
        <p class="muted">${when.toLocaleString()}</p>
        ${visit.notes ? `<p>${escapeHtml(visit.notes)}</p>` : ""}
        <div class="row">
          <a href="pin.html?id=${visit.pin_id}" class="btn" style="flex:1; text-align:center;">View pin</a>
          ${isOrganizer ? '<button id="cancelVisitBtn" class="btn btn-danger" style="flex:1;">Cancel visit</button>' : ""}
          <button id="visitCloseBtn" class="btn" style="flex:1;">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector("#visitCloseBtn").addEventListener("click", close);
    backdrop.querySelector("#cancelVisitBtn")?.addEventListener("click", async () => {
      if (!confirm("Cancel this planned visit?")) return;
      await supabase.from("visits").delete().eq("id", visit.id);
      close();
      switchView(viewMode);
    });
  }

  // ============================================================
  // Data + date helpers
  // ============================================================
  async function fetchVisits(rangeStart, rangeEnd) {
    const { data, error } = await supabase
      .from("visits")
      .select("id, pin_id, scheduled_at, notes, organizer_id, pins(title)")
      .gte("scheduled_at", rangeStart.toISOString())
      .lt("scheduled_at", rangeEnd.toISOString())
      .order("scheduled_at", { ascending: true });
    if (error) {
      console.error(error);
      return [];
    }
    return data;
  }

  function startOfDay(d) {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    return r;
  }
  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }
  function startOfWeek(d) {
    const r = startOfDay(d);
    r.setDate(r.getDate() - r.getDay());
    return r;
  }
  function startOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }
  function addMonths(d, n) {
    return new Date(d.getFullYear(), d.getMonth() + n, 1);
  }
  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function formatHourMinute(hour, minute) {
    const period = hour < 12 ? "AM" : "PM";
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
  }
  function toDateInputValue(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function toTimeInputValue(hour, minute) {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, "&quot;");
  }
}
