(() => {
  const SOFIA_TIME_ZONE = "Europe/Sofia";
  const REFRESH_MS = 15000;
  const SOFIA_CENTER = [42.6977, 23.3219];

  let map = null;
  let selectedStopId = null;
  let refreshTimer = null;
  let clockTimer = null;
  let stopMarkers = null;
  let transportData = null;
  let routeById = new Map();
  let routeMetaById = new Map();

  const boardPanel = () => document.getElementById("virtualBoardPanel");
  const clock = () => document.getElementById("virtualBoardClock");

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getSofiaParts() {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: SOFIA_TIME_ZONE,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date());

    const get = type => parts.find(part => part.type === type)?.value || "";

    return {
      weekday: get("weekday"),
      hour: Number(get("hour")),
      minute: Number(get("minute")),
      second: Number(get("second"))
    };
  }

  function isWeekendInSofia() {
    const day = new Intl.DateTimeFormat("en-US", {
      timeZone: SOFIA_TIME_ZONE,
      weekday: "short"
    }).format(new Date());

    return day === "Sat" || day === "Sun";
  }

  function getNowGtfsSeconds() {
    const parts = getSofiaParts();
    return (
      parts.hour * 3600 +
      parts.minute * 60 +
      parts.second
    );
  }

  function formatClockTime(totalSeconds) {
    const seconds = Math.max(0, Number(totalSeconds) || 0);
    const hour = Math.floor(seconds / 3600) % 24;
    const minute = Math.floor((seconds % 3600) / 60);

    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  function parseGtfsTime(value) {
    if (!value) return null;

    const parts = String(value).trim().split(":");
    if (parts.length !== 3) return null;

    const hour = Number(parts[0]);
    const minute = Number(parts[1]);
    const second = Number(parts[2]);

    if (![hour, minute, second].every(Number.isFinite)) {
      return null;
    }

    return hour * 3600 + minute * 60 + second;
  }

  function getLineMeta(routeId) {
    return routeMetaById.get(String(routeId)) || {
      id: routeId,
      number: "—",
      type: "other",
      color: "#BE1E2D",
      textColor: "#FFFFFF",
      icon: ""
    };
  }

  function typeLabel(type) {
    switch (type) {
      case "bus": return "Автобус";
      case "night": return "Нощна линия";
      case "trolleybus": return "Тролейбус";
      case "tram": return "Трамвай";
      case "metro": return "Метро";
      default: return "Линия";
    }
  }

  function routePillHtml(meta) {
    const isMetro = meta.type === "metro";
    const classes = isMetro
      ? "vb-line-pill vb-line-pill-metro"
      : "vb-line-pill";

    const style = `background:${escapeHtml(meta.color)};color:${escapeHtml(
      meta.textColor || "#FFFFFF"
    )};`;

    return `
      <span class="vb-line-identity">
        ${
          meta.icon
            ? `<img class="vb-line-icon" src="${escapeHtml(meta.icon)}" alt="">`
            : ""
        }
        <span class="${classes}" style="${style}">
          ${escapeHtml(meta.number)}
        </span>
      </span>
    `;
  }

  function destinationHtml(headsign) {
    return `
      <span class="vb-route-direction">
        <img
          class="vb-direction-arrow"
          src="Icons/destinationarrow.svg"
          alt=""
        />
        <span class="vb-destination">${escapeHtml(headsign || "Без дестинация")}</span>
      </span>
    `;
  }

  function countdownHtml(arrivalSeconds, nowSeconds) {
    if (arrivalSeconds == null) {
      return `
        <span class="vb-arrival vb-arrival-empty">
          Няма повече курсове
        </span>
      `;
    }

    const diffSeconds = Math.max(0, arrivalSeconds - nowSeconds);
    const minutes = Math.max(0, Math.ceil(diffSeconds / 60));

    return `
      <span class="vb-arrival">
        <span class="vb-arrival-time">${formatClockTime(arrivalSeconds)}</span>
        <span class="vb-arrival-countdown">
          ${minutes < 1 ? "след <1 мин" : `след ${minutes} мин`}
        </span>
      </span>
    `;
  }

  function collectStopRows(stopId) {
    const rows = [];
    const nowSeconds = getNowGtfsSeconds();
    const dayType = isWeekendInSofia() ? "weekend" : "weekday";

    for (const [routeId, directionSet] of Object.entries(
      transportData?.directions || {}
    )) {
      const meta = getLineMeta(routeId);
      const route = routeById.get(String(routeId));

      if (!route) continue;

      for (const [directionKey, direction] of Object.entries(directionSet || {})) {
        const stops = Array.isArray(direction?.stops) ? direction.stops : [];
        const stopIndexes = [];

        stops.forEach((stop, index) => {
          if (String(stop?.stop_id ?? "") === String(stopId)) {
            stopIndexes.push(index);
          }
        });

        if (!stopIndexes.length) continue;

        const schedules =
          transportData?.schedules?.[routeId]?.[directionKey]?.[dayType] || [];

        const arrivals = [];

        for (const schedule of schedules) {
          const times = Array.isArray(schedule?.times) ? schedule.times : [];

          for (const stopIndex of stopIndexes) {
            const arrival = parseGtfsTime(times[stopIndex]);
            if (arrival == null) continue;

            if (arrival >= nowSeconds) {
              arrivals.push(arrival);
            }
          }
        }

        arrivals.sort((a, b) => a - b);

        const uniqueArrivals = [...new Set(arrivals)].slice(0, 3);

        rows.push({
          routeId,
          number: meta.number,
          type: meta.type,
          headsign: direction?.headsign || direction?.destination || "",
          directionKey,
          nextArrival: uniqueArrivals[0] ?? null,
          upcoming: uniqueArrivals,
          label: typeLabel(meta.type)
        });
      }
    }

    rows.sort((a, b) => {
      if (a.nextArrival == null && b.nextArrival == null) {
        return a.number.localeCompare(b.number, "bg", {
          numeric: true,
          sensitivity: "base"
        });
      }
      if (a.nextArrival == null) return 1;
      if (b.nextArrival == null) return -1;
      return a.nextArrival - b.nextArrival;
    });

    return rows;
  }

  function renderStopBoard(stop) {
    selectedStopId = String(stop.stop_id);
    const rows = collectStopRows(stop.stop_id);
    const panel = boardPanel();

    if (!panel) return;

    const activeRows = rows.filter(row => row.nextArrival != null);
    const titleName = stop.name || stop.stop_name || "Спирка";
    const titleCode = stop.stop_code || stop.stop_id || "";

    panel.innerHTML = `
      <div class="virtual-board-header">
        <div>
          <div class="virtual-board-kicker">Спирка ${escapeHtml(titleCode)}</div>
          <h2>${escapeHtml(titleName)}</h2>
          <p>${rows.length} направления по GTFS</p>
        </div>
        <button
          type="button"
          class="virtual-board-close"
          id="virtualBoardClose"
          aria-label="Затвори таблото"
        >×</button>
      </div>

      <div class="virtual-board-live-line">
        <span class="live-indicator" aria-hidden="true"></span>
        <span>Следващи пристигания · ${escapeHtml(
          isWeekendInSofia() ? "празнично разписание" : "делнично разписание"
        )}</span>
      </div>

      <div class="virtual-board-list">
        ${
          rows.length
            ? rows
                .map((row, index) => {
                  const meta = getLineMeta(row.routeId);
                  const upcoming = row.upcoming || [];
                  const futureItems = upcoming.slice(0, 3);

                  return `
                    <article class="vb-row">
                      <div class="vb-row-main">
                        <div class="vb-line-block">
                          ${routePillHtml(meta)}
                        </div>
                        <div class="vb-route-block">
                          ${destinationHtml(row.headsign)}
                          <span class="vb-line-type">${escapeHtml(row.label)}</span>
                        </div>
                      </div>

                      <div class="vb-time-block">
                        ${countdownHtml(row.nextArrival, getNowGtfsSeconds())}
                        ${
                          futureItems.length > 1
                            ? `
                              <div class="vb-next-times">
                                ${futureItems
                                  .slice(1)
                                  .map(
                                    time =>
                                      `<span>${escapeHtml(
                                        formatClockTime(time)
                                      )}</span>`
                                  )
                                  .join("")}
                              </div>
                            `
                            : ""
                        }
                      </div>
                    </article>
                  `;
                })
                .join("")
            : `
              <div class="virtual-board-no-data">
                Няма намерени GTFS направления за тази спирка.
              </div>
            `
        }
      </div>

      ${
        activeRows.length === 0 && rows.length
          ? `<div class="virtual-board-no-service">Няма оставащи курсове за избраната спирка според текущото GTFS разписание.</div>`
          : ""
      }

      <div class="virtual-board-footnote">
        Времената са планови GTFS времена. Таблото се преизчислява автоматично според часовника на София.
      </div>
    `;

    document.getElementById("virtualBoardClose")?.addEventListener("click", () => {
      selectedStopId = null;
      renderEmptyBoard();
    });
  }

  function renderEmptyBoard() {
    const panel = boardPanel();
    if (!panel) return;

    panel.innerHTML = `
      <div class="virtual-board-empty">
        <div class="virtual-board-empty-title">Изберете спирка</div>
        <p>Всички спирки от GTFS са показани на картата. При клик ще видите линиите, направленията, точния час и оставащите минути до следващото пристигане.</p>
      </div>
    `;
  }

  function addStopMarkers(stops) {
    stopMarkers.clearLayers();

    const renderer = L.canvas({ padding: 0.5 });

    for (const stop of stops) {
      const lat = Number(stop.stop_lat);
      const lon = Number(stop.stop_lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
      }

      const marker = L.circleMarker([lat, lon], {
        radius: 4.5,
        weight: 1,
        color: "#ffffff",
        fillColor: "#111827",
        fillOpacity: 0.9,
        renderer,
        pane: "markerPane"
      });

      marker.bindTooltip(
        escapeHtml(stop.name || stop.stop_name || "Спирка"),
        { direction: "top", offset: [0, -5] }
      );

      marker.on("click", () => {
        renderStopBoard(stop);
        map.panTo([lat, lon], { animate: true, duration: 0.4 });
      });

      marker.addTo(stopMarkers);
    }
  }

  function initMap(stops) {
    if (typeof L === "undefined") {
      const mapElement = document.getElementById("virtualMap");
      if (mapElement) {
        mapElement.innerHTML =
          '<div class="virtual-map-error">Картата не може да бъде заредена.</div>';
      }
      return;
    }

    map = L.map("virtualMap", {
      center: SOFIA_CENTER,
      zoom: 12,
      minZoom: 10,
      preferCanvas: true,
      zoomControl: true
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    stopMarkers = L.layerGroup().addTo(map);

    addStopMarkers(stops);

    setTimeout(() => map.invalidateSize(), 100);
  }

  function updateClock() {
    const parts = getSofiaParts();
    const target = clock();

    if (!target) return;

    target.textContent =
      `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(
        2,
        "0"
      )}:${String(parts.second).padStart(2, "0")}`;
  }

  function refreshSelectedBoard() {
    if (!selectedStopId) return;

    const selectedStop = (transportData?.stops || []).find(
      stop => String(stop.stop_id) === selectedStopId
    );

    if (selectedStop) {
      renderStopBoard(selectedStop);
    }
  }

  function startTimers() {
    clearInterval(refreshTimer);
    clearInterval(clockTimer);

    clockTimer = setInterval(updateClock, 1000);
    refreshTimer = setInterval(refreshSelectedBoard, REFRESH_MS);

    updateClock();
    refreshSelectedBoard();
  }

  async function initializeVirtualBoards() {
    try {
      transportData = await loadTransportData();

      routeById = new Map(
        (transportData.routes || []).map(route => [
          String(route.route_id),
          route
        ])
      );

      const lines = convertGtfsRoutes(
        transportData.routes || [],
        transportData.trips || [],
        transportData.directions || {}
      );

      routeMetaById = new Map(
        lines.map(line => [String(line.id), line])
      );

      initMap(transportData.stops || []);
      startTimers();
    } catch (error) {
      console.error("Неуспешно зареждане на GTFS за виртуалните табла:", error);

      const panel = boardPanel();
      if (panel) {
        panel.innerHTML = `
          <div class="virtual-board-error">
            <strong>Виртуалното табло не може да бъде заредено.</strong>
            <span>${escapeHtml(error.message || "Неизвестна грешка.")}</span>
          </div>
        `;
      }
    }
  }

  document.addEventListener("DOMContentLoaded", initializeVirtualBoards);
})();
