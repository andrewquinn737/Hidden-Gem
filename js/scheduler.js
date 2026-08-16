import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { openPinDetail } from "./pinDetailModal.js";
import { setupSheetDrag } from "./sheetDrag.js";

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
    const viewModeBtn = document.getElementById("viewModeBtn");
    const dropdown = document.getElementById("viewModeDropdown");
    viewModeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === "none" ? "flex" : "none";
    });
    document.addEventListener("click", () => (dropdown.style.display = "none"));
    document.querySelectorAll("[data-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        dropdown.style.display = "none";
        switchView(btn.dataset.view);
      });
    });
  }

  async function switchView(mode) {
    viewMode = mode;
    document.getElementById("upcomingView").style.display = "none";
    document.getElementById("viewModeBtn").textContent = `${mode[0].toUpperCase()}${mode.slice(1)} ▾`;
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

  async function renderDayView(preserveScroll = false) {
    document.getElementById("dayNavLabel").textContent = currentDate.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });

    const dayStart = currentDate;
    const dayEnd = addDays(currentDate, 1);
    visitsCache = await fetchVisits(dayStart, dayEnd);

    const grid = document.getElementById("dayView");
    const savedScrollTop = preserveScroll ? grid.scrollTop : null;
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

    if (savedScrollTop != null) {
      grid.scrollTop = savedScrollTop;
      return;
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

    const isOrganizer = visit.organizer_id === session.user.id;
    let justDragged = false;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (justDragged) {
        justDragged = false;
        return;
      }
      openVisitDetail(visit);
    });

    // Owner-only: hold and drag to a different hour slot to reschedule,
    // instead of opening the detail popup.
    if (isOrganizer) {
      let pressTimer = null;
      let dragging = false;
      let startX = 0;
      let startY = 0;

      chip.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        startX = e.clientX;
        startY = e.clientY;
        pressTimer = setTimeout(() => {
          dragging = true;
          chip.classList.add("dragging");
          chip.style.pointerEvents = "none";
          chip.setPointerCapture?.(e.pointerId);
        }, 500);
      });
      chip.addEventListener("pointermove", (e) => {
        if (dragging) {
          chip.style.transform = `translateY(${e.clientY - startY}px)`;
          return;
        }
        if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) clearTimeout(pressTimer);
      });
      const endDrag = async (e) => {
        clearTimeout(pressTimer);
        if (!dragging) return;
        dragging = false;
        justDragged = true;
        setTimeout(() => (justDragged = false), 0);
        chip.style.transform = "";
        chip.style.pointerEvents = "";
        chip.classList.remove("dragging");
        const dropEl = document.elementFromPoint(e.clientX, e.clientY);
        const targetSlot = dropEl?.closest(".cal-hour-slot");
        if (targetSlot) {
          const newHour = Number(targetSlot.dataset.hour);
          const newMinute = quarterHourFromPointer(targetSlot, e.clientY);
          if (newHour !== d.getHours() || newMinute !== d.getMinutes()) {
            const updated = new Date(d);
            updated.setHours(newHour, newMinute);
            await supabase.from("visits").update({ scheduled_at: updated.toISOString() }).eq("id", visit.id);
            await renderDayView(true);
          }
        }
      };
      chip.addEventListener("pointerup", endDrag);
      chip.addEventListener("pointercancel", endDrag);
    }

    return chip;
  }

  function renderDraftChip() {
    const chip = document.createElement("div");
    chip.className = "calendar-event";
    const label = draftEvent.pinTitle || "New event — pick a pin";
    const timeLabel = formatHourMinute(draftEvent.hour, draftEvent.minute);
    chip.textContent = `${timeLabel} · ${label}`;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      openConfirmDraftModal();
    });
    return chip;
  }

  // Swipe left/right to change day, long-press an empty slot to start a
  // new draft event there, pinch with two fingers to zoom the hour rows
  // taller/shorter. Pointer Events unify mouse + touch.
  function setupDayGestures() {
    const grid = document.getElementById("dayView");
    let pointerStart = null;
    let longPressTimer = null;
    let longPressFired = false;

    const activePointers = new Map(); // pointerId -> {x, y}
    let pinchStartDist = null;
    let pinchStartRowHeight = null;
    const MIN_ROW = 30;
    const MAX_ROW = 140;

    function currentRowHeight() {
      const val = parseFloat(getComputedStyle(grid).getPropertyValue("--hour-row-height"));
      return val || 48;
    }
    function pointerDistance() {
      const pts = Array.from(activePointers.values());
      if (pts.length < 2) return null;
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }

    grid.addEventListener("pointerdown", (e) => {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size === 2) {
        // A second finger landed — abandon any single-finger gesture in
        // progress and start tracking the pinch instead.
        clearTimeout(longPressTimer);
        pointerStart = null;
        pinchStartDist = pointerDistance();
        pinchStartRowHeight = currentRowHeight();
        return;
      }
      if (activePointers.size > 1) return;

      if (e.target.closest(".calendar-event")) return;
      const slot = e.target.closest(".cal-hour-slot");
      pointerStart = {
        x: e.clientX,
        y: e.clientY,
        time: Date.now(),
        hour: slot ? Number(slot.dataset.hour) : null,
        minute: slot ? quarterHourFromPointer(slot, e.clientY) : 0,
      };
      longPressFired = false;
      longPressTimer = setTimeout(async () => {
        if (pointerStart && pointerStart.hour != null) {
          longPressFired = true;
          draftEvent = { pinId: null, pinTitle: null, hour: pointerStart.hour, minute: pointerStart.minute };
          await renderDayView(true);
          openConfirmDraftModal();
        }
      }, 500);
    });

    grid.addEventListener("pointermove", (e) => {
      if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 2 && pinchStartDist) {
        const dist = pointerDistance();
        if (!dist) return;
        const scale = dist / pinchStartDist;
        const newHeight = Math.min(MAX_ROW, Math.max(MIN_ROW, pinchStartRowHeight * scale));
        grid.style.setProperty("--hour-row-height", `${newHeight}px`);
        return;
      }

      if (!pointerStart) return;
      const dx = Math.abs(e.clientX - pointerStart.x);
      const dy = Math.abs(e.clientY - pointerStart.y);
      if (dx > 10 || dy > 10) clearTimeout(longPressTimer);
    });

    const releasePointer = (e) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) {
        pinchStartDist = null;
        pinchStartRowHeight = null;
      }
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
    };

    grid.addEventListener("pointerup", releasePointer);
    grid.addEventListener("pointercancel", (e) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) {
        pinchStartDist = null;
        pinchStartRowHeight = null;
      }
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
  }

  // ============================================================
  // Confirm-draft modal — finalizes a draft into a real visit
  // ============================================================
  async function openConfirmDraftModal() {
    const needsPin = !draftEvent.pinId;
    let searchablePins = [];
    if (needsPin) {
      const [{ data: owned }, { data: saved }] = await Promise.all([
        supabase.from("pins").select("id, title").eq("owner_id", session.user.id),
        supabase.from("pin_saves").select("pins(id, title)").eq("user_id", session.user.id),
      ]);
      const byId = new Map();
      (owned || []).forEach((p) => byId.set(p.id, p.title));
      (saved || []).forEach((s) => s.pins && byId.set(s.pins.id, s.pins.title));
      searchablePins = Array.from(byId, ([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title));
    }

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal stack">
        <h2 style="margin:0;">Confirm visit</h2>
        <form id="confirmDraftForm" class="stack">
          ${
            needsPin
              ? `<div>
                  <label class="field-label" for="draftPinSearch">Pin</label>
                  <input id="draftPinSearch" placeholder="Search your pins…" autocomplete="off" required />
                  <div id="draftPinResults" class="stack" style="max-height:160px; overflow-y:auto; margin-top:0.4rem;"></div>
                </div>`
              : `<div><label class="field-label">Pin</label><input value="${escapeAttr(draftEvent.pinTitle)}" disabled /></div>`
          }
          <div class="row" style="justify-content:flex-start;">
            <div style="flex:0 0 auto; width:min-content;">
              <label class="field-label" for="draftDate">Date</label>
              <input id="draftDate" type="date" value="${toDateInputValue(currentDate)}" required style="width:auto;" />
            </div>
            <div style="flex:0 0 auto; width:min-content;">
              <label class="field-label" for="draftTime">Time</label>
              <input id="draftTime" type="time" value="${toTimeInputValue(draftEvent.hour, draftEvent.minute)}" required style="width:auto;" />
            </div>
          </div>
          <div>
            <label class="field-label" for="draftNotes">Notes</label>
            <textarea id="draftNotes" rows="2"></textarea>
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

    // Cancelling/closing without confirming clears the draft entirely —
    // the "New event — pick a pin" chip only exists while this popup does.
    const dismiss = () => {
      backdrop.remove();
      draftEvent = null;
      switchView(viewMode);
    };
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) dismiss();
    });
    backdrop.querySelector("#draftCancelBtn").addEventListener("click", dismiss);

    let selectedPinId = draftEvent.pinId;
    if (needsPin) {
      const searchInput = backdrop.querySelector("#draftPinSearch");
      const resultsEl = backdrop.querySelector("#draftPinResults");
      function renderResults(filterText) {
        const matches = filterText
          ? searchablePins.filter((p) => p.title.toLowerCase().includes(filterText.toLowerCase()))
          : searchablePins;
        resultsEl.innerHTML = matches.length
          ? matches
              .map((p) => `<button type="button" class="btn draft-pin-option" data-id="${p.id}" style="width:100%; text-align:left; border:none;">${escapeHtml(p.title)}</button>`)
              .join("")
          : '<p class="muted" style="margin:0;">No matching pins.</p>';
        resultsEl.querySelectorAll(".draft-pin-option").forEach((btn) => {
          btn.addEventListener("click", () => {
            selectedPinId = btn.dataset.id;
            searchInput.value = btn.textContent;
            resultsEl.innerHTML = "";
          });
        });
      }
      searchInput.addEventListener("input", () => {
        selectedPinId = null;
        renderResults(searchInput.value.trim());
      });
      searchInput.addEventListener("focus", () => renderResults(searchInput.value.trim()));
    }

    backdrop.querySelector("#confirmDraftForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = backdrop.querySelector("#draftFormError");
      errorEl.style.display = "none";

      const pinId = selectedPinId;
      const dateVal = backdrop.querySelector("#draftDate").value;
      const timeVal = backdrop.querySelector("#draftTime").value;
      const notes = backdrop.querySelector("#draftNotes").value.trim() || null;

      if (!pinId || !dateVal || !timeVal) {
        errorEl.textContent = "A pin, date, and time are all required to confirm.";
        errorEl.style.display = "block";
        return;
      }

      const scheduledAt = new Date(`${dateVal}T${timeVal}`);

      const { error } = await supabase
        .from("visits")
        .insert({ pin_id: pinId, organizer_id: session.user.id, scheduled_at: scheduledAt.toISOString(), notes })
        .select()
        .single();

      if (error) {
        errorEl.textContent = error.message;
        errorEl.style.display = "block";
        return;
      }

      draftEvent = null;
      backdrop.remove();
      currentDate = startOfDay(scheduledAt);
      switchView("day");
    });
  }

  // ============================================================
  // Existing-visit detail popup — half-screen, same shell as pin
  // popups (sticky header, centered drag handle, X on desktop only).
  // ============================================================
  async function openVisitDetail(visit) {
    const when = new Date(visit.scheduled_at);
    const isOrganizer = visit.organizer_id === session.user.id;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal pin-detail-modal visit-detail-modal stack">
        <div class="post-header">
          <strong class="post-title">${escapeHtml(visit.pins?.title || "Visit")}</strong>
          <div class="post-header-center"><span class="post-drag-handle" aria-hidden="true"></span></div>
          <div class="post-header-end"><button class="post-close-btn" aria-label="Close">✕</button></div>
        </div>
        <div class="visit-detail-body stack">
          <p class="muted" style="margin:0;">${when.toLocaleString()}</p>
          <button id="visitPinNameBtn" class="btn-link" style="padding:0; font-weight:600; font-size:1rem; text-align:left;">📍 ${escapeHtml(visit.pins?.title || "Pin")}</button>
          ${visit.notes ? `<p style="margin:0;">${escapeHtml(visit.notes)}</p>` : ""}
          <div id="visitSharedWith" class="muted" style="margin:0;"></div>
          <div class="row">
            <button id="shareVisitBtn" class="btn" style="flex:1;">Share</button>
            ${isOrganizer ? '<button id="cancelVisitBtn" class="btn btn-danger" style="flex:1;">Cancel visit</button>' : ""}
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    const modalEl = backdrop.querySelector(".visit-detail-modal");
    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    modalEl.querySelector(".post-close-btn").addEventListener("click", close);
    setupSheetDrag(modalEl, { onDismiss: close });
    modalEl.querySelector("#visitPinNameBtn").addEventListener("click", () => {
      openPinDetail(visit.pin_id, {});
    });
    modalEl.querySelector("#cancelVisitBtn")?.addEventListener("click", async () => {
      if (!confirm("Cancel this planned visit?")) return;
      await supabase.from("visits").delete().eq("id", visit.id);
      close();
      switchView(viewMode);
    });
    modalEl.querySelector("#shareVisitBtn").addEventListener("click", async () => {
      const { data } = await supabase.from("visits").select("share_token").eq("id", visit.id).single();
      const url = `${window.location.origin}/invite.html?token=${data.share_token}`;
      const shareData = { title: "Hidden Gem — Visit", text: `Join me at ${visit.pins?.title || "a visit"}!`, url };
      if (navigator.share) {
        try {
          await navigator.share(shareData);
        } catch {
          // user cancelled the share sheet
        }
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        alert("Link copied to clipboard.");
      }
    });

    const { data: participants } = await supabase
      .from("visit_participants")
      .select("user_id, profiles(username)")
      .eq("visit_id", visit.id)
      .not("user_id", "is", null);
    const names = (participants || []).map((p) => p.profiles?.username).filter(Boolean);
    modalEl.querySelector("#visitSharedWith").textContent = names.length ? `Shared with: ${names.join(", ")}` : "";
  }

  // ============================================================
  // Visit-share overlay — landed on via a shared visit link. Shows just
  // the pin name and a Join event button over whatever view is already
  // showing, instead of a separate standalone page.
  // ============================================================
  async function maybeShowVisitShareOverlay() {
    const shareToken = params.get("visitShareToken");
    if (!shareToken) return;
    const { data, error } = await supabase.rpc("get_visit_by_share_token", { p_token: shareToken }).maybeSingle();
    if (error || !data) return;

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal pin-detail-modal share-overlay-modal stack">
        <div class="post-header">
          <strong class="post-title">${escapeHtml(data.pin_title)}</strong>
          <div class="post-header-center"><span class="post-drag-handle" aria-hidden="true"></span></div>
          <div class="post-header-end"><button class="post-close-btn" aria-label="Close">✕</button></div>
        </div>
        <div class="stack" style="padding:0.85rem;">
          <p class="muted" style="margin:0;">${new Date(data.scheduled_at).toLocaleString()}${data.organizer_username ? ` · shared by ${escapeHtml(data.organizer_username)}` : ""}</p>
          ${data.notes ? `<p style="margin:0;">${escapeHtml(data.notes)}</p>` : ""}
          <p class="error-text" id="shareJoinError" style="display:none;"></p>
          <button id="shareJoinBtn" class="btn btn-primary">Join event</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    const modalEl = backdrop.querySelector(".share-overlay-modal");
    const close = () => {
      backdrop.remove();
      const url = new URL(window.location.href);
      url.searchParams.delete("visitShareToken");
      window.history.replaceState({}, "", url);
    };
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    modalEl.querySelector(".post-close-btn").addEventListener("click", close);
    setupSheetDrag(modalEl, { onDismiss: close });

    modalEl.querySelector("#shareJoinBtn").addEventListener("click", async () => {
      const errorEl = modalEl.querySelector("#shareJoinError");
      errorEl.style.display = "none";
      const { error: joinError } = await supabase.rpc("accept_visit_share", { p_token: shareToken }).single();
      if (joinError) {
        errorEl.textContent = joinError.message;
        errorEl.style.display = "block";
        return;
      }
      close();
      currentDate = startOfDay(new Date(data.scheduled_at));
      switchView("day");
    });
  }
  await maybeShowVisitShareOverlay();

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
  // Rounds a pointer's vertical position within an hour slot down to the
  // nearest 15-minute mark, so long-press-create and drag-to-reschedule
  // both land on quarter/half-hour increments instead of always :00.
  function quarterHourFromPointer(slotEl, clientY) {
    const rect = slotEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return Math.min(45, Math.floor(frac * 4) * 15);
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
