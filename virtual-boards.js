let virtualBoardRefreshTimer = null;

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

  if (!match) {
    return null;
  }

  return (
    Number(match[1]) * 60 +
    Number(match[2]) +
    Number(match[3] || 0) / 60
  );
}

function virtualBoardFormatExactTime(totalMinutes) {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = Math.floor(normalized % 60);

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function virtualBoardFormatRemaining(minutes) {
  if (minutes <= 0) {
    return "Сега";
  }

  if (minutes < 60) {
    return `${minutes} мин.`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (!rest) {
    return `${hours} ч.`;
  }

  return `${hours} ч. ${rest} мин.`;
}

function virtualBoardGetNowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

function virtualBoardGetUpcoming(route, direction, schedule, stopIndex, nowMinutes) {
  const results = [];

  for (const course of schedule || []) {
    const rawTime = course?.times?.[stopIndex];
    let arrival = virtualBoardParseTime(rawTime);

    if (arrival == null) {
      continue;
    }

    // GTFS allows times >= 24:00. Around midnight, normalize those
    // service-day times so 24:10 behaves like 00:10 on the board.
    if (arrival >= 1440 && nowMinutes < 360) {
      arrival -= 1440;
    }

    let delta = arrival - nowMinutes;

    // If today's occurrence has already passed, do not show it.
    // For a service-day time after midnight, the normalization above
    // makes the comparison work naturally.
    if (delta < -0.5) {
      continue;
    }

    results.push({
      exactMinutes: arrival,
      remainingMinutes: Math.max(0, Math.ceil(delta)),
      car: course?.car || ""
    });
  }

  results.sort((a, b) => a.remainingMinutes - b.remainingMinutes || a.exactMinutes - b.exactMinutes);

  const unique = [];
  const seen = new Set();

  for (const item of results) {
    const key = `${item.exactMinutes}|${item.car}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
    if (unique.length >= 3) {
      break;
    }
  }

  return unique;
}

function virtualBoardBuildRoutes(context) {
  const scheduleLines = Array.isArray(window.scheduleLines)
    ? window.scheduleLines
    : [];

  const transportData = window.transportData || {};
  const schedules = transportData.schedules || {};
  const selectedStopId = context.stopId;
  const selectedDayType = context.dayType || "weekday";
  const nowMinutes = virtualBoardGetNowMinutes();
  const routes = [];

  for (const line of scheduleLines) {
    const routeSchedule = schedules[line.id];
    if (!routeSchedule) {
      continue;
    }

    for (const direction of Array.isArray(line.directions) ? line.directions : []) {
      const stopIndex = (direction.stops || []).findIndex(
        stop => String(stop?.stop_id || "") === String(selectedStopId || "")
      );

      if (stopIndex < 0) {
        continue;
      }

      // A virtual board shows departures from the selected stop. If the
      // selected stop is the final stop of this direction, the schedule
      // time represents an arrival there, not a departure from there.
      // Such a direction must therefore not be shown on the board.
      const directionStops = Array.isArray(direction.stops)
        ? direction.stops
        : [];

      if (directionStops.length > 0 && stopIndex === directionStops.length - 1) {
        continue;
      }

      const directionSchedule = routeSchedule[direction.key];
      const daySchedule = directionSchedule?.[selectedDayType] || [];
      const times = virtualBoardGetUpcoming(
        line,
        direction,
        daySchedule,
        stopIndex,
        nowMinutes
      );

      if (!times.length) {
        continue;
      }

      routes.push({
        line,
        direction,
        times
      });
    }
  }

  routes.sort((a, b) => {
    const aTime = a.times[0]?.remainingMinutes ?? Infinity;
    const bTime = b.times[0]?.remainingMinutes ?? Infinity;

    if (aTime !== bTime) {
      return aTime - bTime;
    }

    return String(a.line.number).localeCompare(
      String(b.line.number),
      "bg",
      { numeric: true, sensitivity: "base" }
    );
  });

  return routes;
}

function virtualBoardArrivalHtml(arrival) {
  const exact = virtualBoardFormatExactTime(arrival.exactMinutes);
  const remaining = virtualBoardFormatRemaining(arrival.remainingMinutes);

  return `
    <div class="virtual-board-arrival">
      <span class="virtual-board-live-indicator" aria-label="Времето се обновява автоматично"></span>
      <strong>${exact}</strong>
      <span>(${remaining})</span>
    </div>`;
}

function virtualBoardRouteHtml(entry) {
  const line = entry.line;
  const direction = entry.direction;

  return `
    <article class="virtual-board-route">
      <div class="virtual-board-route-main">
        ${lineIdentityHtml(line)}
        <img
          class="virtual-board-destination-arrow"
          src="Icons/destinationarrow.svg"
          alt=""
        />
        <strong class="virtual-board-destination">
          ${virtualBoardEscapeHtml(direction.headsign || direction.destination || "")}
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

  if (!section || !container || !context?.stopId) {
    return;
  }

  const stopName = context.stopName || "";
  const routes = virtualBoardBuildRoutes(context);

  container.innerHTML = `
    <div class="virtual-board-heading-row">
      <div>
        <div class="schedule-section-kicker">Виртуално табло</div>
        <h2>${virtualBoardEscapeHtml(stopName)}</h2>
      </div>

      <div class="virtual-board-heading-actions">
        <button id="closeVirtualBoardButton" class="schedule-close-button" type="button">Затвори</button>
      </div>
    </div>

    ${routes.length
      ? `<div class="virtual-board-list">
          ${routes.slice(0, 12).map(virtualBoardRouteHtml).join("")}
        </div>`
      : `<div class="schedule-no-data">Няма предстоящи пристигания по разписание.</div>`}
  `;

  section.hidden = false;
}

function startVirtualBoard() {
  renderVirtualBoard();

  if (virtualBoardRefreshTimer) {
    clearInterval(virtualBoardRefreshTimer);
  }

  virtualBoardRefreshTimer = setInterval(() => {
    renderVirtualBoard();
    updateVirtualBoardClock();
  }, 10000);
}

function stopVirtualBoard() {
  if (virtualBoardRefreshTimer) {
    clearInterval(virtualBoardRefreshTimer);
    virtualBoardRefreshTimer = null;
  }

  const section = document.getElementById("virtualBoardSection");
  if (section) {
    section.hidden = true;
  }
}

window.startVirtualBoard = startVirtualBoard;
window.stopVirtualBoard = stopVirtualBoard;
