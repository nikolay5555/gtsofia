(() => {
  const SOFIA_CENTER = [42.6977, 23.3219];
  const REFRESH_MS = 15000;
  const SOFIA_TIME_ZONE = "Europe/Sofia";

  let map = null;
  let transportData = null;
  let markersLayer = null;
  let userMarker = null;
  let refreshTimer = null;
  let routeMetaById = new Map();
  let routeMetaByNumber = new Map();
  let tripById = new Map();
  let stopById = new Map();
  let allVehicles = [];
  let selectedType = "all";
  let routeQuery = "";
  let isLoading = false;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalize(value) {
    return String(value ?? "")
      .trim()
      .toLocaleLowerCase("bg-BG")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function stopIdsMatch(left, right) {
    const a = String(left ?? "").trim().replace(/^M/i, "");
    const b = String(right ?? "").trim().replace(/^M/i, "");
    if (!a || !b) return false;

    const aDigits = a.replace(/\D/g, "");
    const bDigits = b.replace(/\D/g, "");

    if (aDigits && bDigits) return String(Number(aDigits)) === String(Number(bDigits));
    return normalize(a) === normalize(b);
  }

  function getLineMeta(routeId, routeRef = "") {
    const id = String(routeId ?? "").trim();
    const ref = String(routeRef ?? "").trim();

    if (id && routeMetaById.has(id)) return routeMetaById.get(id);
    if (ref && routeMetaByNumber.has(ref)) return routeMetaByNumber.get(ref);

    const route = id ? (transportData?.routes || []).find(item => String(item.route_id) === id) : null;
    const number = ref || route?.route_short_name || "—";
    const type = route && typeof getLineType === "function" ? getLineType(route) : "bus";

    return {
      id,
      number,
      type,
      icon: route && typeof getTransportIcon === "function" ? getTransportIcon(type, number) : "",
      color: route && typeof getLineColor === "function"
        ? getLineColor(route, type)
        : "#BE1E2D",
      textColor: route?.route_text_color ? `#${route.route_text_color}` : "#FFFFFF"
    };
  }

  // Same line icon + pill + destination arrow/name rendering used by the
  // existing virtual boards, kept here for the live-vehicle popup.
  function linePillHtml(line) {
    const number = escapeHtml(line?.number || "—");
    const typeClass = line?.type === "metro" ? " metro" : "";
    const color = escapeHtml(line?.color || "#BE1E2D");
    const textColor = escapeHtml(line?.textColor || "#FFFFFF");

    return `<span class="schedule-line-pill${typeClass}" style="--line-color:${color}; --line-text-color:${textColor}; background-color:${color}; color:${textColor};">${number}</span>`;
  }

  function lineIdentityHtml(line) {
    const icon = line?.icon
      ? `<span class="schedule-line-icon"><img src="${escapeHtml(line.icon)}" alt="" aria-hidden="true"></span>`
      : "";

    return `<span class="schedule-line-identity">${icon}${linePillHtml(line)}</span>`;
  }

  function destinationHtml(destination) {
    return `<span class="schedule-summary-arrow direction-arrow" aria-hidden="true"><img src="Icons/destinationarrow.svg" alt=""></span><strong class="schedule-summary-destination vb-destination">${escapeHtml(destination || "—")}</strong>`;
  }

  function getDestination(vehicle) {
    const tripId = String(vehicle?.trip_id || "").trim();
    const staticTrip = tripById.get(tripId);

    if (staticTrip?.trip_headsign) return String(staticTrip.trip_headsign).trim();

    const routeId = String(vehicle?.route_id || "").trim();
    const stopId = String(vehicle?.current_stop_id || "").trim();
    const directionId = String(vehicle?.direction_id || "").trim();

    const directions = Object.values(transportData?.directions?.[routeId] || {});

    const exactTripDirection = directions.find(direction =>
      String(direction?.trip_id || "").trim() === tripId
      || (Array.isArray(direction?.trip_ids) && direction.trip_ids.some(id => String(id) === tripId))
    );
    if (exactTripDirection) {
      return String(exactTripDirection.destination || exactTripDirection.headsign || "").trim();
    }

    if (directionId) {
      const directionById = directions.find(direction =>
        String(direction?.direction_id || direction?.key || "").trim() === directionId
      );
      if (directionById) {
        return String(directionById.destination || directionById.headsign || "").trim();
      }
    }

    if (stopId) {
      const atStop = directions.filter(direction =>
        Array.isArray(direction?.pattern)
          && direction.pattern.some(id => stopIdsMatch(id, stopId))
      );
      const uniqueDestinations = [...new Set(
        atStop
          .map(direction => String(direction?.destination || direction?.headsign || "").trim())
          .filter(Boolean)
      )];

      if (uniqueDestinations.length === 1) return uniqueDestinations[0];
    }

    return "Направлението не е указано";
  }

  function getCurrentStopName(vehicle) {
    const stopId = String(vehicle?.current_stop_id || "").trim();
    if (!stopId) return "";

    const exact = stopById.get(stopId);
    if (exact) return String(exact.stop_name || exact.name || "").trim();

    for (const stop of transportData?.stops || []) {
      if (stopIdsMatch(stop?.stop_id, stopId) || stopIdsMatch(stop?.stop_code, stopId)) {
        return String(stop.stop_name || stop.name || "").trim();
      }
    }

    return "";
  }

  function formatFeedTime(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return "—";

    return new Intl.DateTimeFormat("bg-BG", {
      timeZone: SOFIA_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).format(new Date(value * 1000));
  }

  function formatSpeed(speed) {
    const value = Number(speed);
    if (!Number.isFinite(value) || value < 0) return "";

    const kmh = value * 3.6;
    return `${Math.round(kmh)} км/ч`;
  }

  function vehicleMarkerHtml(vehicle, meta) {
    const number = escapeHtml(meta?.number || "—");
    const icon = meta?.icon
      ? `<span class="realtime-vehicle-icon"><img src="${escapeHtml(meta.icon)}" alt="" aria-hidden="true"></span>`
      : "";
    const color = escapeHtml(meta?.color || "#BE1E2D");
    const textColor = escapeHtml(meta?.textColor || "#FFFFFF");

    const bearing = Number(vehicle?.bearing);
    // The shared destination arrow points east by default; GTFS-RT bearing
    // is measured clockwise from north, so 90° - bearing aligns the arrow.
    const bearingTransform = Number.isFinite(bearing)
      ? `style="transform: rotate(${Math.round(90 - bearing)}deg)"`
      : "";

    return `
      <div class="realtime-vehicle-marker" style="--vehicle-color:${color}; --vehicle-text-color:${textColor};" title="${escapeHtml(meta?.number || "Линия")}">
        <span class="realtime-vehicle-arrow" ${bearingTransform}>
          <img src="Icons/destinationarrow.svg" alt="" aria-hidden="true">
        </span>
        ${icon}
        <span class="realtime-vehicle-pill">${number}</span>
      </div>
    `;
  }

  function vehiclePopupHtml(vehicle, meta) {
    const destination = getDestination(vehicle);
    const currentStop = getCurrentStopName(vehicle);
    const speed = formatSpeed(vehicle?.speed);
    const vehicleId = vehicle?.label || vehicle?.id || "—";
    const plate = vehicle?.license_plate ? ` · ${escapeHtml(vehicle.license_plate)}` : "";
    const status = escapeHtml(vehicle?.current_status_name || "Статусът не е указан");
    const lastUpdate = formatFeedTime(vehicle?.timestamp);

    return `
      <div class="realtime-vehicle-popup">
        <div class="realtime-popup-route">
          ${lineIdentityHtml(meta)}
          <span class="realtime-popup-live"><span class="live-indicator"></span> В реално време</span>
        </div>

        <div class="schedule-summary-route-row realtime-popup-destination">
          ${destinationHtml(destination)}
        </div>

        <div class="realtime-popup-grid">
          <div>
            <span>Превозно средство</span>
            <strong>${escapeHtml(vehicleId)}${plate}</strong>
          </div>
          <div>
            <span>Статус</span>
            <strong>${status}</strong>
          </div>
          ${currentStop ? `
            <div>
              <span>Най-близка спирка</span>
              <strong>${escapeHtml(currentStop)}</strong>
            </div>
          ` : ""}
          ${speed ? `
            <div>
              <span>Скорост</span>
              <strong>${escapeHtml(speed)}</strong>
            </div>
          ` : ""}
        </div>

        <div class="realtime-popup-footer">Позиция към ${escapeHtml(lastUpdate)}</div>
      </div>
    `;
  }

  function buildMarkerIcon(vehicle, meta) {
    return L.divIcon({
      className: "realtime-vehicle-icon-wrap",
      html: vehicleMarkerHtml(vehicle, meta),
      iconSize: [108, 38],
      iconAnchor: [54, 19],
      popupAnchor: [0, -20]
    });
  }

  function filterVehicles() {
    const needle = normalize(routeQuery);

    return allVehicles.filter(vehicle => {
      const meta = getLineMeta(vehicle?.route_id);

      if (selectedType !== "all" && meta?.type !== selectedType) return false;

      if (needle) {
        const lineNumber = normalize(meta?.number);
        if (!lineNumber.includes(needle)) return false;
      }

      return true;
    });
  }

  function renderVehicles() {
    if (!markersLayer) return;

    markersLayer.clearLayers();

    const visibleVehicles = filterVehicles();
    const bounds = [];

    for (const vehicle of visibleVehicles) {
      const latitude = Number(vehicle?.latitude);
      const longitude = Number(vehicle?.longitude);

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

      const meta = getLineMeta(vehicle?.route_id);
      const marker = L.marker([latitude, longitude], {
        icon: buildMarkerIcon(vehicle, meta),
        keyboard: true,
        riseOnHover: true
      });

      marker.bindPopup(vehiclePopupHtml(vehicle, meta), {
        maxWidth: 360,
        minWidth: 260,
        className: "realtime-vehicle-popup-shell"
      });

      marker.addTo(markersLayer);
      bounds.push([latitude, longitude]);
    }

    const count = document.getElementById("realtimeVehicleCount");
    if (count) count.textContent = `${visibleVehicles.length}`;

    const filterCount = document.getElementById("realtimeFilterCount");
    if (filterCount) {
      filterCount.textContent = `${visibleVehicles.length} превозни средства`;
    }
  }

  function updateStatus(payload) {
    const status = document.getElementById("realtimeMapStatus");
    if (!status) return;

    if (payload.status === "ok") {
      const time = formatFeedTime(payload.generated_at);
      status.textContent = `${payload.vehicles.length} позиции · последно обновяване ${time}`;
    } else {
      status.textContent = "Няма налични realtime позиции.";
    }
  }

  async function fetchVehicles() {
    const response = await fetch("/api/vehicle-positions", {
      cache: "no-store",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      let message = `Realtime feed error: ${response.status}`;
      try {
        const body = await response.json();
        if (body?.error) message = body.error;
      } catch {
        // Keep the HTTP status as the user-facing fallback.
      }
      throw new Error(message);
    }

    return response.json();
  }

  async function refreshVehicles() {
    if (isLoading) return;

    isLoading = true;
    const button = document.getElementById("realtimeMapRefresh");
    button?.classList.add("is-loading");
    if (button) button.disabled = true;

    try {
      const payload = await fetchVehicles();
      allVehicles = Array.isArray(payload?.vehicles) ? payload.vehicles : [];

      updateStatus(payload || { status: "empty" });
      renderVehicles();
    } catch (error) {
      console.error("GTSofia realtime map error:", error);

      const status = document.getElementById("realtimeMapStatus");
      if (status) status.textContent = "Realtime данните не могат да бъдат заредени.";

      allVehicles = [];
      renderVehicles();
    } finally {
      isLoading = false;
      button?.classList.remove("is-loading");
      if (button) button.disabled = false;
    }
  }

  function setupFilters() {
    document.querySelectorAll(".realtime-mode-filter").forEach(button => {
      button.addEventListener("click", () => {
        selectedType = String(button.dataset.type || "all");

        document.querySelectorAll(".realtime-mode-filter").forEach(item => {
          item.classList.toggle("active", item === button);
        });

        renderVehicles();
      });
    });

    const search = document.getElementById("realtimeRouteSearch");
    search?.addEventListener("input", () => {
      routeQuery = search.value.trim();
      renderVehicles();
    });
  }

  function setupGeolocation() {
    const button = document.getElementById("realtimeMapLocate");
    if (!button) return;

    button.addEventListener("click", () => {
      if (!navigator.geolocation) {
        window.alert("Този браузър не поддържа определяне на локация.");
        return;
      }

      button.disabled = true;
      button.classList.add("is-loading");

      navigator.geolocation.getCurrentPosition(
        position => {
          const latitude = position.coords.latitude;
          const longitude = position.coords.longitude;

          if (!userMarker) {
            userMarker = L.circleMarker([latitude, longitude], {
              radius: 8,
              weight: 3,
              color: "#ffffff",
              fillColor: "#2563eb",
              fillOpacity: 1
            }).addTo(map);

            userMarker.bindTooltip("Вашата локация", {
              direction: "top",
              offset: [0, -8]
            });
          } else {
            userMarker.setLatLng([latitude, longitude]);
          }

          map.setView([latitude, longitude], Math.max(map.getZoom(), 14), {
            animate: true
          });

          button.disabled = false;
          button.classList.remove("is-loading");
        },
        error => {
          console.warn("Грешка при определяне на локацията:", error);
          button.disabled = false;
          button.classList.remove("is-loading");
          window.alert("Не успяхме да определим вашата локация. Проверете разрешението за достъп до местоположението.");
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 30000
        }
      );
    });
  }

  function initMap() {
    if (typeof L === "undefined") {
      const element = document.getElementById("realtimeMap");
      if (element) {
        element.innerHTML = `<div class="virtual-map-error">Картата не може да бъде заредена.</div>`;
      }
      return;
    }

    map = L.map("realtimeMap", {
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

    markersLayer = L.layerGroup().addTo(map);

    setTimeout(() => map.invalidateSize(), 100);
  }

  function startAutoRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshVehicles, REFRESH_MS);
  }

  async function initializeRealtimeMap() {
    try {
      transportData = await loadTransportData();

      tripById = new Map(
        (transportData.trips || []).map(trip => [
          String(trip.trip_id),
          trip
        ])
      );

      stopById = new Map(
        (transportData.stops || []).map(stop => [
          String(stop.stop_id),
          stop
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

      routeMetaByNumber = new Map(
        lines.map(line => [String(line.number).trim(), line])
      );

      initMap();
      setupFilters();
      setupGeolocation();

      document.getElementById("realtimeMapRefresh")?.addEventListener(
        "click",
        refreshVehicles
      );

      await refreshVehicles();
      startAutoRefresh();
    } catch (error) {
      console.error("GTSofia realtime map initialization error:", error);

      const status = document.getElementById("realtimeMapStatus");
      if (status) {
        status.textContent = "Картата не може да бъде инициализирана.";
      }
    }
  }

  document.addEventListener("DOMContentLoaded", initializeRealtimeMap);
})();
