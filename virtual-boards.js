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
  let tripById = new Map();
  let tripStopsById = new Map();

  const boardPanel = () => document.getElementById("virtualBoardBody");

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

    if (![hour, minute, second].every(Number.isFinite)) return null;
    return hour * 3600 + minute * 60 + second;
  }

  // Minimal GTFS-Realtime protobuf decoder for TripUpdates.
  function readVarint(bytes, state) {
    let value = 0n;
    let shift = 0n;

    while (state.index < bytes.length) {
      const byte = bytes[state.index++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
      if (shift > 70n) throw new Error("Невалиден GTFS-RT varint.");
    }

    throw new Error("Непълен GTFS-RT varint.");
  }

  function readField(bytes, state) {
    const tag = Number(readVarint(bytes, state));
    const fieldNumber = tag >>> 3;
    const wireType = tag & 7;

    if (!fieldNumber) throw new Error("Невалидно GTFS-RT поле.");

    if (wireType === 0) {
      return { fieldNumber, wireType, value: readVarint(bytes, state) };
    }

    if (wireType === 1) {
      const end = state.index + 8;
      if (end > bytes.length) throw new Error("Непълно GTFS-RT съобщение.");
      const value = bytes.subarray(state.index, end);
      state.index = end;
      return { fieldNumber, wireType, value };
    }

    if (wireType === 2) {
      const length = Number(readVarint(bytes, state));
      const end = state.index + length;
      if (end > bytes.length) throw new Error("Непълно GTFS-RT protobuf съобщение.");
      const value = bytes.subarray(state.index, end);
      state.index = end;
      return { fieldNumber, wireType, value };
    }

    if (wireType === 5) {
      const end = state.index + 4;
      if (end > bytes.length) throw new Error("Непълно GTFS-RT съобщение.");
      const value = bytes.subarray(state.index, end);
      state.index = end;
      return { fieldNumber, wireType, value };
    }

    throw new Error(`Неподдържан GTFS-RT wire type: ${wireType}`);
  }

  function decodeString(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function toSignedInt32(value) {
    const n = Number(value & 0xffffffffn) >>> 0;
    return n > 0x7fffffff ? n - 0x100000000 : n;
  }

  function decodeTripDescriptor(bytes) {
    const state = { index: 0 };
    const trip = { tripId: "", routeId: "", directionId: "" };

    while (state.index < bytes.length) {
      const field = readField(bytes, state);
      if (field.wireType !== 2) continue;
      if (field.fieldNumber === 1) trip.tripId = decodeString(field.value);
      else if (field.fieldNumber === 5) trip.routeId = decodeString(field.value);
      else if (field.fieldNumber === 6) trip.directionId = decodeString(field.value);
    }

    return trip;
  }

  function decodeStopTimeEvent(bytes) {
    const state = { index: 0 };
    const result = { delay: null, time: null };

    while (state.index < bytes.length) {
      const field = readField(bytes, state);
      if (field.fieldNumber === 1 && field.wireType === 0) {
        result.delay = toSignedInt32(field.value);
      } else if (field.fieldNumber === 2 && field.wireType === 0) {
        result.time = Number(field.value);
      }
    }

    return result;
  }

  function decodeStopTimeUpdate(bytes) {
    const state = { index: 0 };
    const result = {
      stopSequence: null,
      stopId: "",
      arrival: null,
      departure: null,
      scheduleRelationship: null
    };

    while (state.index < bytes.length) {
      const field = readField(bytes, state);
      if (field.fieldNumber === 1 && field.wireType === 0) {
        result.stopSequence = Number(field.value);
      } else if (field.fieldNumber === 2 && field.wireType === 2) {
        result.arrival = decodeStopTimeEvent(field.value);
      } else if (field.fieldNumber === 3 && field.wireType === 2) {
        result.departure = decodeStopTimeEvent(field.value);
      } else if (field.fieldNumber === 4 && field.wireType === 2) {
        result.stopId = decodeString(field.value);
      } else if (field.fieldNumber === 5 && field.wireType === 0) {
        result.scheduleRelationship = Number(field.value);
      }
    }

    return result;
  }

  function decodeTripUpdate(bytes) {
    const state = { index: 0 };
    const result = { trip: null, stopTimeUpdates: [] };

    while (state.index < bytes.length) {
      const field = readField(bytes, state);
      if (field.fieldNumber === 1 && field.wireType === 2) {
        result.trip = decodeTripDescriptor(field.value);
      } else if (field.fieldNumber === 2 && field.wireType === 2) {
        result.stopTimeUpdates.push(decodeStopTimeUpdate(field.value));
      }
    }

    return result;
  }

  function decodeFeedEntity(bytes) {
    const state = { index: 0 };
    let tripUpdate = null;

    while (state.index < bytes.length) {
      const field = readField(bytes, state);
      if (field.fieldNumber === 3 && field.wireType === 2) {
        tripUpdate = decodeTripUpdate(field.value);
      }
    }

    return tripUpdate;
  }

  function decodeGtfsRealtimeFeed(buffer) {
    const bytes = new Uint8Array(buffer);
    const state = { index: 0 };
    const updates = [];

    while (state.index < bytes.length) {
      const field = readField(bytes, state);
      if (field.fieldNumber === 2 && field.wireType === 2) {
        const entity = decodeFeedEntity(field.value);
        if (entity?.trip?.tripId) updates.push(entity);
      }
    }

    return updates;
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

  function countdownHtml(arrivalUnix, isFirst) {
    if (arrivalUnix == null) {
      return `<span class="vb-arrival vb-arrival-empty">Няма realtime данни</span>`;
    }

    const diffSeconds = Math.max(0, arrivalUnix - Math.floor(Date.now() / 1000));
    const minutes = Math.max(0, Math.ceil(diffSeconds / 60));
    const time = new Intl.DateTimeFormat("bg-BG", {
      timeZone: SOFIA_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date(arrivalUnix * 1000));

    return `
      <span class="vb-arrival">
        ${isFirst ? '<span class="live-indicator vb-arrival-live" aria-hidden="true"></span>' : ''}
        <span class="vb-arrival-time">${escapeHtml(time)}</span>
        <span class="vb-arrival-countdown">${minutes < 1 ? "след <1 мин" : `след ${minutes} мин`}</span>
      </span>
    `;
  }

  function getStaticTrip(tripId) {
    return tripById.get(String(tripId)) || null;
  }

  function getRealtimeStopId(stopUpdate, tripId) {
    const explicitStopId = String(stopUpdate?.stopId || '').trim();
    if (explicitStopId) return explicitStopId;

    const stopSequence = Number(stopUpdate?.stopSequence);
    if (!Number.isFinite(stopSequence) || stopSequence < 1) return '';

    const tripStops = tripStopsById.get(String(tripId));
    return tripStops?.[stopSequence - 1] || '';
  }

  function collectRealtimeStopRows(stopId) {
    const groups = new Map();
    const updates = Array.isArray(window.gtfsRealtimeTripUpdates)
      ? window.gtfsRealtimeTripUpdates
      : [];
    const nowUnix = Math.floor(Date.now() / 1000);
    const targetStopId = String(stopId);

    for (const update of updates) {
      const tripDescriptor = update?.trip || {};
      const tripId = String(tripDescriptor.tripId || "");
      if (!tripId) continue;

      const stopUpdates = Array.isArray(update.stopTimeUpdates)
        ? update.stopTimeUpdates
        : [];
      const stopUpdate = stopUpdates.find(item => {
        const realtimeStopId = getRealtimeStopId(item, tripId);
        return realtimeStopId === targetStopId;
      });
      if (!stopUpdate) continue;

      // 1 = SKIPPED, 2 = NO_DATA, 3 = CANCELED.
      if ([1, 2, 3].includes(stopUpdate.scheduleRelationship)) continue;

      const arrivalEvent = stopUpdate.arrival || stopUpdate.departure;
      const arrivalUnix = Number(arrivalEvent?.time);
      if (!Number.isFinite(arrivalUnix) || arrivalUnix < nowUnix - 60) continue;

      const staticTrip = getStaticTrip(tripId);
      const routeId = String(
        tripDescriptor.routeId || staticTrip?.route_id || ""
      );
      if (!routeId) continue;

      const headsign = staticTrip?.trip_headsign || "";
      const groupKey = `${routeId}|${headsign}`;
      let group = groups.get(groupKey);

      if (!group) {
        group = {
          routeId,
          headsign,
          arrivals: []
        };
        groups.set(groupKey, group);
      }

      group.arrivals.push(arrivalUnix);
    }

    return [...groups.values()]
      .map(group => ({
        ...group,
        arrivals: [...new Set(group.arrivals)].sort((a, b) => a - b),
      }))
      .map(group => ({
        ...group,
        arrivals: group.arrivals.slice(0, 4),
        nextArrivalUnix: group.arrivals[0] ?? null
      }))
      .sort((a, b) => {
        if (a.nextArrivalUnix == null) return 1;
        if (b.nextArrivalUnix == null) return -1;
        return a.nextArrivalUnix - b.nextArrivalUnix;
      });
  }

  function renderStopBoard(stop) {
    selectedStopId = String(stop.stop_id);
    const rows = collectRealtimeStopRows(stop.stop_id);
    const panel = boardPanel();

    if (!panel) return;

    const activeRows = rows.filter(row => row.nextArrivalUnix != null);
    const titleName = stop.name || stop.stop_name || "Спирка";
    const titleCode = stop.stop_code || stop.stop_id || "";

    panel.innerHTML = `
      <div class="virtual-board-header">
        <div>
          <div class="virtual-board-kicker">Спирка ${escapeHtml(titleCode)}</div>
          <h2>${escapeHtml(titleName)}</h2>
        </div>
        <div class="virtual-board-header-actions">
          <button type="button" class="virtual-board-refresh" id="virtualBoardRefresh">Обнови</button>
          <button
            type="button"
            class="virtual-board-close"
            id="virtualBoardClose"
            aria-label="Затвори таблото"
          >×</button>
        </div>
      </div>

      <div class="virtual-board-list">
        ${
          rows.length
            ? rows
                .map((row, index) => {
                  const meta = getLineMeta(row.routeId);
                  const futureItems = row.arrivals || [row.nextArrivalUnix];

                  return `
                    <article class="vb-row">
                      <div class="schedule-summary-route-row vb-route-row">
                        ${lineIdentityHtml(meta)}
                        ${destinationHtml(row.headsign)}
                      </div>

                      <div class="vb-time-block">
                        ${countdownHtml(row.nextArrivalUnix, index === 0)}
                        ${
                          futureItems.length > 1
                            ? `
                              <div class="vb-next-times">
                                ${futureItems
                                  .slice(1)
                                  .map(
                                    time =>
                                      `<span>${escapeHtml(new Intl.DateTimeFormat("bg-BG", {
                                        timeZone: SOFIA_TIME_ZONE,
                                        hour: "2-digit",
                                        minute: "2-digit",
                                        hourCycle: "h23"
                                      }).format(new Date(Number(time) * 1000)))}</span>`
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
        <p>Изберете спирка от картата, за да видите следващите пристигания</p>
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

    const renderer = L.svg();

    for (const stop of stops) {
      const lat = Number(stop.stop_lat);
      const lon = Number(stop.stop_lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
      }

      const clickTarget = L.circleMarker([lat, lon], {
        radius: 16,
        weight: 0,
        stroke: false,
        fillColor: "#111827",
        fillOpacity: 0.01,
        renderer,
        pane: "markerPane"
      });

      const marker = L.circleMarker([lat, lon], {
        radius: 7,
        weight: 2,
        color: "#ffffff",
        fillColor: "#111827",
        fillOpacity: 0.9,
        renderer,
        pane: "markerPane"
      });

      const stopTooltip = escapeHtml(stop.name || stop.stop_name || "Спирка");
      marker.bindTooltip(stopTooltip, { direction: "top", offset: [0, -5] });
      clickTarget.bindTooltip(stopTooltip, { direction: "top", offset: [0, -12] });

      const select = () => selectStopOnMap(stop);
      clickTarget.on("click", select);
      marker.on("click", select);

      clickTarget.addTo(stopMarkers);
      marker.addTo(stopMarkers);
    }
  }

  function getActiveStops(stops) {
    const activeStopIds = new Set();

    for (const directionSet of Object.values(transportData?.directions || {})) {
      for (const direction of Object.values(directionSet || {})) {
        for (const stop of direction?.stops || []) {
          const stopId = String(stop?.stop_id ?? "").trim();
          if (stopId) activeStopIds.add(stopId);
        }
      }
    }

    return stops.filter(stop => activeStopIds.has(String(stop?.stop_id ?? "").trim()));
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


  function startTimers() {
    clearInterval(refreshTimer);
    clearInterval(clockTimer);

    refreshTimer = setInterval(() => {
      loadRealtimeTripUpdates()
        .then(() => {
          if (selectedStopId) {
            const selectedStop = findStopById(selectedStopId);
            if (selectedStop) renderStopBoard(selectedStop);
          }
        })
        .catch(error => console.error("GTFS-Realtime refresh error:", error));
    }, REFRESH_MS);

    refreshSelectedBoard();
  }

  async function loadRealtimeTripUpdates() {
    const response = await fetch(
      "https://gtfs.sofiatraffic.bg/api/v1/trip-updates",
      {
        cache: "no-store",
        mode: "cors"
      }
    );

    if (!response.ok) {
      throw new Error(`GTFS-Realtime заявката върна ${response.status}.`);
    }

    const buffer = await response.arrayBuffer();
    window.gtfsRealtimeTripUpdates = decodeGtfsRealtimeFeed(buffer);
    window.gtfsRealtimeUpdatedAt = Date.now();
    return window.gtfsRealtimeTripUpdates;
  }

  async function refreshSelectedBoard() {
    if (!selectedStopId) return;

    const refreshButton = document.getElementById("virtualBoardRefresh");
    refreshButton?.classList.add("is-loading");

    try {
      await loadRealtimeTripUpdates();
      const selectedStop = findStopById(selectedStopId);
      if (selectedStop) renderStopBoard(selectedStop);
    } catch (error) {
      console.error("Неуспешно зареждане на GTFS-Realtime:", error);
    } finally {
      refreshButton?.classList.remove("is-loading");
    }
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

      tripById = new Map(
        (transportData.trips || []).map(trip => [
          String(trip.trip_id),
          trip
        ])
      );

      tripStopsById = new Map();
      for (const directionSet of Object.values(transportData.directions || {})) {
        for (const direction of Object.values(directionSet || {})) {
          const tripId = String(direction?.trip_id || '').trim();
          if (!tripId) continue;
          const stopIds = Array.isArray(direction?.stops)
            ? direction.stops.map(stop => String(stop?.stop_id || '').trim()).filter(Boolean)
            : [];
          if (stopIds.length) tripStopsById.set(tripId, stopIds);
        }
      }

      const lines = convertGtfsRoutes(
        transportData.routes || [],
        transportData.trips || [],
        transportData.directions || {}
      );

      routeMetaById = new Map(
        lines.map(line => [String(line.id), line])
      );

      await loadRealtimeTripUpdates();

      const allStops = transportData.stops || [];
      const stops = getActiveStops(allStops);
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
