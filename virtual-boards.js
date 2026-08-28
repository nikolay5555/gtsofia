import { fetchSofiaTripUpdates, buildRealtimeIndex } from './gtfs-realtime.js';

let virtualBoardRefreshTimer = null;
let virtualBoardRealtimeIndex = new Map();
let virtualBoardRealtimeAvailable = false;

function virtualBoardEscapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function virtualBoardParseTime(value) {
  const match = String(value || "").match(
    /^(\d+):(\d{2})(?::(\d{2}))?$/
  );

  if (!match) return null;

  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3] || 0) / 60;
}

function virtualBoardFormatExactTime(totalMinutes) {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = Math.floor(normalized % 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function virtualBoardFormatExactDate(date) {
  return new Intl.DateTimeFormat("bg-BG", {
    timeZone: "Europe/Sofia",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function virtualBoardFormatRemaining(minutes) {
  if (minutes <= 0) return "Сега";
  if (minutes < 60) return `${minutes} мин.`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч. ${rest} мин.` : `${hours} ч.`;
}

function virtualBoardGetNowDate() {
  return new Date();
}

function virtualBoardGetSofiaMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Sofia",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Number(values.hour) * 60 + Number(values.minute) + Number(values.second) / 60;
}

function virtualBoardScheduleDateForMinutes(minutes, nowDate) {
  const safe = Number(minutes);
  if (!Number.isFinite(safe)) return null;

  const normalized = ((safe % 1440) + 1440) % 1440;
  const nowMinutes = virtualBoardGetSofiaMinutes(nowDate);
  let dayOffset = 0;

  if (safe >= 1440 || (normalized < 360 && nowMinutes > 18 * 60)) {
    dayOffset = -1;
  }

  const candidate = new Date(nowDate.getTime() + dayOffset * 86400000);
  const hh = Math.floor(normalized / 60);
  const mm = Math.floor(normalized % 60);
  candidate.setHours(hh, mm, 0, 0);
  return candidate;
}

function virtualBoardGetUpcoming(direction, schedule, stopIndex, nowDate) {
  const results = [];
  const nowMs = nowDate.getTime();
  const nowMinutes = virtualBoardGetSofiaMinutes(nowDate);

  for (const course of schedule || []) {
    const rawTime = course?.times?.[stopIndex];
    const scheduleMinutes = virtualBoardParseTime(rawTime);
    if (scheduleMinutes == null) continue;

    // A course that ends exactly at this stop is an arrival at its own terminal,
    // not a departure for a virtual stop board.
    const lastRealIndex = (course.times || []).reduce(
      (last, value, index) => (
        value !== null && value !== undefined && String(value).trim() !== ""
          ? index
          : last
      ),
      -1
    );
    if (lastRealIndex === stopIndex) continue;

    let liveDate = null;
    let isRealtime = false;
    const originalTripId = String(course?.original_trip_id || "");
    const realtimeStops = originalTripId ? virtualBoardRealtimeIndex.get(originalTripId) : null;
    const realtime = realtimeStops?.get(String(direction.stops?.[stopIndex]?.stop_id || ""));

    if (realtime?.time instanceof Date && Number.isFinite(realtime.time.getTime())) {
      liveDate = realtime.time;
      isRealtime = true;
    } else {
      // If GTFS-RT supplies only delay, apply it to the static schedule.
      let effectiveMinutes = scheduleMinutes;
      if (typeof realtime?.delay === "number" && Number.isFinite(realtime.delay)) {
        effectiveMinutes += realtime.delay / 60;
      }
      liveDate = virtualBoardScheduleDateForMinutes(effectiveMinutes, nowDate);
    }

    if (!(liveDate instanceof Date) || !Number.isFinite(liveDate.getTime())) continue;

    const deltaMs = liveDate.getTime() - nowMs;
    if (deltaMs < -30000) continue;

    const remainingMinutes = Math.max(0, Math.ceil(deltaMs / 60000));
    const destination = String(course?.trip_headsign || direction?.headsign || direction?.destination || "").trim();

    results.push({
      exactDate: liveDate,
      exactMinutes: scheduleMinutes,
      remainingMinutes,
      car: course?.car || "",
      originalTripId,
      destination,
      isRealtime
    });
  }

  results.sort((a, b) =>
    a.exactDate - b.exactDate ||
    a.remainingMinutes - b.remainingMinutes ||
    String(a.originalTripId).localeCompare(String(b.originalTripId))
  );

  const unique = [];
  const seen = new Set();
  for (const item of results) {
    const key = `${item.exactDate.getTime()}|${item.originalTripId}|${item.destination}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= 3) break;
  }
  return unique;
}

function virtualBoardBuildRoutes(context) {
  const scheduleLines = Array.isArray(window.scheduleLines) ? window.scheduleLines : [];
  const transportData = window.transportData || {};
  const schedules = transportData.schedules || {};
  const selectedStopId = context.stopId;
  const selectedDayType = context.dayType || "weekday";
  const nowDate = virtualBoardGetNowDate();
  const grouped = new Map();

  for (const line of scheduleLines) {
    const routeSchedule = schedules[line.id];
    if (!routeSchedule) continue;

    for (const direction of Array.isArray(line.directions) ? line.directions : []) {
      const stopIndex = (direction.stops || []).findIndex(
        stop => String(stop?.stop_id || "") === String(selectedStopId || "")
      );
      if (stopIndex < 0) continue;

      const directionStops = Array.isArray(direction.stops) ? direction.stops : [];
      if (directionStops.length > 0 && stopIndex === directionStops.length - 1) continue;

      const directionSchedule = routeSchedule[direction.key];
      const daySchedule = directionSchedule?.[selectedDayType] || [];
      if (!daySchedule.length) continue;

      const times = virtualBoardGetUpcoming(direction, daySchedule, stopIndex, nowDate);
      for (const time of times) {
        const destination = time.destination || direction.headsign || direction.destination || "";
        const groupKey = `${line.id}|${destination}`;

        if (!grouped.has(groupKey)) {
          grouped.set(groupKey, { line, destination, times: [] });
        }
        grouped.get(groupKey).times.push(time);
      }
    }
  }

  const routes = Array.from(grouped.values());
  for (const route of routes) {
    route.times.sort((a, b) => a.exactDate - b.exactDate);
    route.times = route.times.slice(0, 3);
  }

  routes.sort((a, b) => {
    const aTime = a.times[0]?.exactDate?.getTime() ?? Infinity;
    const bTime = b.times[0]?.exactDate?.getTime() ?? Infinity;
    if (aTime !== bTime) return aTime - bTime;
    return String(a.line.number).localeCompare(String(b.line.number), "bg", {
      numeric: true,
      sensitivity: "base"
    });
  });

  return routes;
}

function virtualBoardArrivalHtml(arrival) {
  const exact = arrival.isRealtime
    ? virtualBoardFormatExactDate(arrival.exactDate)
    : virtualBoardFormatExactTime(arrival.exactMinutes);
  const remaining = virtualBoardFormatRemaining(arrival.remainingMinutes);
  const indicatorClass = arrival.isRealtime
    ? "virtual-board-live-indicator"
    : "virtual-board-live-indicator virtual-board-scheduled-indicator";

  return `
    <div class="virtual-board-arrival">
      <span class="${indicatorClass}" aria-label="${arrival.isRealtime ? "В реално време" : "По разписание"}"></span>
      <strong>${exact}</strong>
      <span>(${remaining})</span>
    </div>`;
}

function virtualBoardRouteHtml(entry) {
  return `
    <article class="virtual-board-route">
      <div class="virtual-board-route-main">
        ${lineIdentityHtml(entry.line)}
        <img
          class="virtual-board-destination-arrow"
          src="Icons/destinationarrow.svg"
          alt=""
        />
        <strong class="virtual-board-destination">
          ${virtualBoardEscapeHtml(entry.destination)}
        </strong>
      </div>

      <div class="virtual-board-times">
        ${entry.times.map(virtualBoardArrivalHtml).join("")}
      </div>
    </article>`;
}

function renderVirtualBoard() {
  const context = window.getScheduleSelection?.();
  const section = document.getElementById("virtualBoardSection");
  const container = document.getElementById("virtualBoardContainer");
  if (!section || !container || !context?.stopId) return;

  const routes = virtualBoardBuildRoutes(context);
  const statusText = virtualBoardRealtimeAvailable
    ? "Времена в реално време"
    : "Времената са по разписание";

  container.innerHTML = `
    <div class="virtual-board-heading-row">
      <div>
        <div class="schedule-section-kicker">Виртуално табло</div>
        <h2>${virtualBoardEscapeHtml(context.stopName || "")}</h2>
        <div class="virtual-board-status">${statusText}</div>
      </div>

      <div class="virtual-board-heading-actions">
        <button id="closeVirtualBoardButton" class="schedule-close-button" type="button">Затвори</button>
      </div>
    </div>

    ${routes.length
      ? `<div class="virtual-board-list">${routes.slice(0, 12).map(virtualBoardRouteHtml).join("")}</div>`
      : `<div class="schedule-no-data">Няма предстоящи пристигания по разписание.</div>`}
  `;

  const closeButton = document.getElementById("closeVirtualBoardButton");
  if (closeButton) {
    closeButton.addEventListener("click", () => window.stopVirtualBoard?.());
  }

  section.hidden = false;
}

async function refreshVirtualBoardRealtime() {
  try {
    const updates = await fetchSofiaTripUpdates();
    virtualBoardRealtimeIndex = buildRealtimeIndex(updates);
    virtualBoardRealtimeAvailable = virtualBoardRealtimeIndex.size > 0;
  } catch (error) {
    console.warn("Sofia GTFS-RT Trip Updates unavailable; using schedule fallback.", error);
    virtualBoardRealtimeIndex = new Map();
    virtualBoardRealtimeAvailable = false;
  }

  renderVirtualBoard();
}

function startVirtualBoard() {
  renderVirtualBoard();
  refreshVirtualBoardRealtime();

  if (virtualBoardRefreshTimer) clearInterval(virtualBoardRefreshTimer);
  virtualBoardRefreshTimer = setInterval(refreshVirtualBoardRealtime, 10000);
}

function stopVirtualBoard() {
  if (virtualBoardRefreshTimer) {
    clearInterval(virtualBoardRefreshTimer);
    virtualBoardRefreshTimer = null;
  }

  virtualBoardRealtimeIndex = new Map();
  virtualBoardRealtimeAvailable = false;

  const section = document.getElementById("virtualBoardSection");
  if (section) section.hidden = true;
}

window.startVirtualBoard = startVirtualBoard;
window.stopVirtualBoard = stopVirtualBoard;
