let virtualBoardRefreshTimer = null;
let virtualBoardRealtimeAvailable = false;
let virtualBoardProxyRoutes = null;
const VIRTUAL_BOARD_PROXY_URL =
  "https://sft-proxy.onrender.com/virtual-board?stop_code=";

function virtualBoardEscapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// schedules.js is a regular script, while this file is an ES module.
// Its helper functions therefore are not visible here. Keep the exact same
// line identity markup locally instead of changing the schedules page API.
function virtualBoardLinePillHtml(line) {
  const number = virtualBoardEscapeHtml(line?.number || "");
  const background = virtualBoardEscapeHtml(line?.color || "#BE1E2D");
  const textColor = virtualBoardEscapeHtml(line?.textColor || "#FFFFFF");

  if (line?.type === "metro") {
    return `
      <span
        class="schedule-line-pill metro"
        style="background:${background};color:${textColor}"
      >
        ${number}
      </span>`;
  }

  return `
    <span
      class="schedule-line-pill"
      style="background:${background}"
    >
      ${number}
    </span>`;
}

function virtualBoardLineIdentityHtml(line) {
  const icon = virtualBoardEscapeHtml(line?.icon || "");

  return `
    <span class="schedule-line-identity">
      <span class="schedule-line-icon">
        <img src="${icon}" alt="" />
      </span>
      ${virtualBoardLinePillHtml(line)}
    </span>`;
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

function virtualBoardGetMinutesForSofiaDate(date) {
  return virtualBoardGetSofiaMinutes(date);
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

function virtualBoardNormalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function virtualBoardFindLine(routeRef, routeType) {
  const lines = Array.isArray(window.scheduleLines) ? window.scheduleLines : [];
  const ref = String(routeRef ?? "").trim();
  const type = String(routeType ?? "").toLowerCase();
  const typeAliases = {
    trolley: ["trolley", "trolleybus"],
    trolleybus: ["trolley", "trolleybus"],
    bus: ["bus"],
    tram: ["tram"],
    metro: ["metro"]
  };
  const aliases = typeAliases[type] || [type];

  return (
    lines.find(line =>
      String(line?.number ?? "").trim() === ref &&
      aliases.includes(String(line?.type ?? "").toLowerCase())
    ) ||
    lines.find(line => String(line?.number ?? "").trim() === ref) ||
    null
  );
}

function virtualBoardProxyTimeToArrival(timeEntry, nowDate) {
  const raw = timeEntry?.t;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 0) return null;

  const exactDate = new Date(nowDate.getTime() + minutes * 60000);
  if (!Number.isFinite(exactDate.getTime())) return null;

  const remainingMinutes = Math.max(0, Math.ceil(minutes));
  const explicitRealtime =
    timeEntry?.is_realtime ??
    timeEntry?.realtime ??
    timeEntry?.live;

  // The virtual-board proxy is a realtime departures endpoint. When it does
  // not provide an explicit per-time flag, its returned times are treated as
  // realtime. If it does provide a false flag, respect it.
  const isRealtime = explicitRealtime === undefined
    ? true
    : Boolean(explicitRealtime);

  return {
    exactDate,
    exactMinutes: virtualBoardGetMinutesForSofiaDate(exactDate),
    remainingMinutes,
    car: "",
    originalTripId: "",
    destination: "",
    isRealtime
  };
}

function virtualBoardBuildProxyRoutes(proxyRoutes, context, nowDate) {
  const grouped = new Map();
  const selectedStopName = virtualBoardNormalizeName(context.stopName);

  for (const proxyRoute of proxyRoutes || []) {
    const routeRef = String(proxyRoute?.route_ref ?? "").trim();
    if (!routeRef) continue;

    const line = virtualBoardFindLine(routeRef, proxyRoute?.type);
    if (!line) continue;

    const destination = String(proxyRoute?.destination ?? "").trim();
    if (!destination) continue;

    // Do not show a vehicle whose displayed destination is the selected
    // terminal itself. At a terminal we are interested in the departures in
    // the opposite direction, not in the vehicle arriving at its own terminal.
    if (
      selectedStopName &&
      virtualBoardNormalizeName(destination) === selectedStopName
    ) {
      continue;
    }

    const arrivals = [];
    for (const timeEntry of proxyRoute?.times || []) {
      const arrival = virtualBoardProxyTimeToArrival(timeEntry, nowDate);
      if (!arrival) continue;
      arrival.destination = destination;
      arrivals.push(arrival);
    }
    if (!arrivals.length) continue;

    const groupKey = `${line.id}|${destination}`;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, { line, destination, times: [] });
    }
    grouped.get(groupKey).times.push(...arrivals);
  }

  const routes = Array.from(grouped.values());
  for (const route of routes) {
    route.times.sort((a, b) => a.exactDate - b.exactDate);
    const unique = [];
    const seen = new Set();
    for (const time of route.times) {
      const key = `${time.exactDate.getTime()}|${time.destination}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(time);
      if (unique.length >= 3) break;
    }
    route.times = unique;
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

async function virtualBoardFetchProxy(context) {
  const stopCode = String(context?.stopId ?? "").trim();
  if (!stopCode) throw new Error("Missing stop code");

  const response = await fetch(
    `${VIRTUAL_BOARD_PROXY_URL}${encodeURIComponent(stopCode)}`,
    {
      cache: "no-store"
    }
  );

  if (!response.ok) {
    throw new Error(`Virtual board proxy HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload?.status && payload.status !== "ok") {
    throw new Error(`Virtual board proxy status: ${payload.status}`);
  }

  if (!Array.isArray(payload?.routes)) {
    throw new Error("Virtual board proxy returned no routes array");
  }

  return payload.routes;
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

      const times = virtualBoardGetUpcoming(direction, daySchedule, stopIndex, nowDate, line.id);
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
  const liveIndicator = arrival.isRealtime
    ? '<span class="virtual-board-live-indicator" aria-label="В реално време"></span>'
    : '';

  return `
    <div class="virtual-board-arrival">
      ${liveIndicator}
      <strong>${exact}</strong>
      <span>(${remaining})</span>
    </div>`;
}

function virtualBoardRouteHtml(entry) {
  return `
    <article class="virtual-board-route">
      <div class="virtual-board-route-main">
        ${virtualBoardLineIdentityHtml(entry.line)}
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

  const routes = virtualBoardProxyRoutes
    ? virtualBoardBuildProxyRoutes(virtualBoardProxyRoutes, context, virtualBoardGetNowDate())
    : virtualBoardBuildRoutes(context);
  container.innerHTML = `
    <div class="virtual-board-heading-row">
      <div>
        <div class="schedule-section-kicker">Виртуално табло</div>
        <h2>${virtualBoardEscapeHtml(context.stopName || "")}</h2>
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
  const context = window.getScheduleSelection?.();
  if (!context?.stopId) return;

  try {
    virtualBoardProxyRoutes = await virtualBoardFetchProxy(context);
    virtualBoardRealtimeAvailable = true;
  } catch (error) {
    console.warn("Virtual board realtime proxy unavailable; using schedule fallback.", error);
    virtualBoardProxyRoutes = null;
    virtualBoardRealtimeAvailable = false;
  }

  renderVirtualBoard();
}

function startVirtualBoard() {
  virtualBoardProxyRoutes = null;
  virtualBoardRealtimeAvailable = false;
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

  virtualBoardProxyRoutes = null;
  virtualBoardRealtimeAvailable = false;

  const section = document.getElementById("virtualBoardSection");
  if (section) section.hidden = true;
}

window.startVirtualBoard = startVirtualBoard;
window.stopVirtualBoard = stopVirtualBoard;
