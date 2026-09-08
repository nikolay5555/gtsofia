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

  const boardPanel = () => document.getElementById("virtualBoardContent");
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

  function linePillHtml(meta) {
    if (meta.type === "metro") {
      return `
        <span
          class="schedule-line-pill metro"
          style="background:${escapeHtml(meta.color)};color:${escapeHtml(meta.textColor || "#FFFFFF")}"
        >
          ${escapeHtml(meta.number)}
        </span>`;
    }

    return `
      <span
        class="schedule-line-pill"
        style="background:${escapeHtml(meta.color)};color:${escapeHtml(meta.textColor || "#FFFFFF")}"
      >
        ${escapeHtml(meta.number)}
      </span>`;
  }

  function lineIdentityHtml(meta) {
    return `
      <span class="schedule-line-identity">
        <span class="schedule-line-icon">
          ${meta.icon ? `<img src="${escapeHtml(meta.icon)}" alt="">` : ""}
        </span>
        ${linePillHtml(meta)}
      </span>`;
  }

  function destinationHtml(headsign) {
    return `
      <img
        class="direction-arrow vb-direction-arrow"
        src="Icons/destinationarrow.svg"
        alt=""
      />
      <strong class="schedule-summary-destination vb-destination">
        ${escapeHtml(headsign || "Без дестинация")}
      </strong>
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
        <span class="live-indicator vb-arrival-live" aria-hidden="true"></span>
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
          upcoming: uniqueArrivals
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
        <div class="virtual-board-live-copy">
          <span class="live-indicator" aria-hidden="true"></span>
          <span>Следващи пристигания · ${escapeHtml(
            isWeekendInSofia() ? "празнично разписание" : "делнично разписание"
          )}</span>
        </div>
        <button type="button" class="virtual-board-refresh" id="virtualBoardRefresh">
          Обнови
        </button>
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
                      <div class="schedule-summary-route-row vb-route-row">
                        ${lineIdentityHtml(meta)}
                        ${destinationHtml(row.headsign)}
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

    document.getElementById("virtualBoardRefresh")?.addEventListener("click", refreshSelectedBoard);
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

  function findStopById(stopId) {
    return (transportData?.stops || []).find(
      stop => String(stop.stop_id) === String(stopId)
    ) || null;
  }

  function selectStopOnMap(stop) {
    if (!stop || !map) return;
    const lat = Number(stop.stop_lat);
    const lon = Number(stop.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    renderStopBoard(stop);
    map.setView([lat, lon], Math.max(map.getZoom(), 15), { animate: true });
  }

  function setupStopSearch(stops) {
    const input = document.getElementById("stopSearch");
    const results = document.getElementById("stopSearchResults");
    if (!input || !results) return;

    const normalized = value => String(value || "")
      .toLocaleLowerCase("bg-BG")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    const searchStops = query => {
      const needle = normalized(query).trim();
      if (!needle) return [];

      return stops
        .filter(stop => {
          const name = normalized(stop.name || stop.stop_name);
          const code = normalized(stop.stop_code || stop.stop_id);
          return name.includes(needle) || code.includes(needle);
        })
        .slice(0, 8);
    };

    const renderResults = matches => {
      results.innerHTML = matches.length
        ? matches.map(stop => `
            <button type="button" class="virtual-stop-search-result" data-stop-id="${escapeHtml(stop.stop_id)}">
              <strong>${escapeHtml(stop.name || stop.stop_name || "Спирка")}</strong>
              <span>${escapeHtml(stop.stop_code || stop.stop_id || "")}</span>
            </button>
          `).join("")
        : `<div class="virtual-stop-search-empty">Няма намерени спирки.</div>`;

      results.hidden = false;

      results.querySelectorAll("[data-stop-id]").forEach(button => {
        button.addEventListener("click", () => {
          const stop = findStopById(button.dataset.stopId);
          if (stop) {
            input.value = stop.name || stop.stop_name || "";
            results.hidden = true;
            selectStopOnMap(stop);
          }
        });
      });
    };

    input.addEventListener("input", () => {
      const query = input.value.trim();
      if (!query) {
        results.hidden = true;
        results.innerHTML = "";
        return;
      }
      renderResults(searchStops(query));
    });

    input.addEventListener("focus", () => {
      if (input.value.trim()) renderResults(searchStops(input.value));
    });

    document.addEventListener("click", event => {
      if (!event.target.closest(".virtual-stop-search")) {
        results.hidden = true;
      }
    });
  }

  function setupGeolocation() {
    const button = document.getElementById("locateUserButton");
    if (!button) return;

    let userMarker = null;
    const locate = () => {
      if (!navigator.geolocation) {
        window.alert("Този браузър не поддържа определяне на локация.");
        return;
      }

      button.disabled = true;
      button.classList.add("is-loading");

      navigator.geolocation.getCurrentPosition(
        position => {
          const lat = position.coords.latitude;
          const lon = position.coords.longitude;

          if (!userMarker) {
            userMarker = L.circleMarker([lat, lon], {
              radius: 8,
              weight: 3,
              color: "#ffffff",
              fillColor: "#2563eb",
              fillOpacity: 1
            }).addTo(map);
            userMarker.bindTooltip("Вашата локация", { direction: "top", offset: [0, -8] });
          } else {
            userMarker.setLatLng([lat, lon]);
          }

          map.setView([lat, lon], Math.max(map.getZoom(), 15), { animate: true });
          button.disabled = false;
          button.classList.remove("is-loading");
        },
        error => {
          console.warn("Грешка при определяне на локацията:", error);
          button.disabled = false;
          button.classList.remove("is-loading");
          window.alert("Не успяхме да определим вашата локация. Проверете разрешението за достъп до местоположението.");
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
    };

    button.addEventListener("click", locate);
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
        radius: 11,
        weight: 2,
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
        selectStopOnMap(stop);
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

      const stops = transportData.stops || [];
      initMap(stops);
      setupStopSearch(stops);
      setupGeolocation();
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
