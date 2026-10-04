```javascript
(() => {
  const SOFIA_TIME_ZONE = "Europe/Sofia";
  const REFRESH_MS = 15000;
  const SOFIA_CENTER = [42.6977, 23.3219];
  const FAVORITE_STOPS_KEY = "gtsofia.favoriteStops";

  let map = null;
  let selectedStopId = null;
  let selectedStopMarker = null;
  let refreshTimer = null;
  let countdownTimer = null;
  let refreshInFlight = false;
  let boardRenderToken = 0;
  let lastExpiredPrimaryArrival = null;
  let clockTimer = null;
  let stopMarkers = null;
  let stopMarkersById = new Map();
  let transportData = null;
  let routeById = new Map();
  let routeMetaById = new Map();
  let routeMetaByNumber = new Map();
  let tripById = new Map();

  const boardPanel = () => document.getElementById("virtualBoardBody");

  // Realtime stop updates can disappear shortly after a vehicle passes the
  // selected stop. Remember the exact realtime course while it is observed,
  // so its static counterpart can never resurrect after the RT ETA has passed.
  const CONSUMED_REALTIME_ARRIVALS_KEY = "gtsofia.virtualBoard.consumedRealtimeArrivals.v3";
  const CONSUMED_REALTIME_ARRIVAL_TTL_MS = 20 * 60 * 1000;
  const consumedRealtimeArrivals = new Map();
  let consumedRealtimeArrivalsLoaded = false;

  function loadConsumedRealtimeArrivals() {
    if (consumedRealtimeArrivalsLoaded) return;
    consumedRealtimeArrivalsLoaded = true;

    try {
      const raw = sessionStorage.getItem(CONSUMED_REALTIME_ARRIVALS_KEY);
      const stored = JSON.parse(raw || "[]");
      if (!Array.isArray(stored)) return;

      const now = Date.now();
      for (const item of stored) {
        const key = String(item?.key || "").trim();
        const arrivalTimestamp = Number(item?.arrivalTimestamp);
        const expiresAt = Number(item?.expiresAt);
        if (
          key
          && Number.isFinite(arrivalTimestamp)
          && Number.isFinite(expiresAt)
          && expiresAt > now
        ) {
          consumedRealtimeArrivals.set(key, { arrivalTimestamp, expiresAt });
        }
      }
    } catch {
      // sessionStorage is optional; the in-memory map still protects the
      // current page session when storage is unavailable.
    }
  }

  function persistConsumedRealtimeArrivals() {
    try {
      sessionStorage.setItem(
        CONSUMED_REALTIME_ARRIVALS_KEY,
        JSON.stringify([...consumedRealtimeArrivals.entries()].map(([key, value]) => ({
          key,
          arrivalTimestamp: Number(value?.arrivalTimestamp),
          expiresAt: Number(value?.expiresAt)
        })))
      );
    } catch {
      // Keep the in-memory state.
    }
  }

  function pruneConsumedRealtimeArrivals() {
    loadConsumedRealtimeArrivals();
    const now = Date.now();
    let changed = false;
    for (const [key, value] of consumedRealtimeArrivals) {
      if (!Number.isFinite(Number(value?.expiresAt)) || Number(value.expiresAt) <= now) {
        consumedRealtimeArrivals.delete(key);
        changed = true;
      }
    }
    if (changed) persistConsumedRealtimeArrivals();
  }

  function getConsumedRealtimeArrivalKey(
    stopId,
    routeId,
    destination,
    scheduledTimestamp,
    sourceTripId = ""
  ) {
    const stopKey = normalizeStopKey(stopId);
    if (!stopKey) return "";

    const tripId = String(sourceTripId || "").trim();
    if (tripId) {
      return [stopKey, "trip", tripId].join("|");
    }

    const timestamp = Number(scheduledTimestamp);
    if (!Number.isFinite(timestamp)) return "";
    return [
      stopKey,
      String(routeId || "").trim(),
      normalizeDirectionText(destination),
      Math.floor(timestamp / 60)
    ].join("|");
  }

  function rememberConsumedRealtimeArrivals(stop, matches, nowSeconds = Date.now() / 1000) {
    pruneConsumedRealtimeArrivals();
    const stopId = String(stop?.stop_id || stop?.stop_code || "").trim();
    if (!stopId) return;

    const now = Number(nowSeconds);
    if (!Number.isFinite(now)) return;

    let changed = false;
    for (const match of matches || []) {
      const realtime = match?.realtime;
      const staticCourse = match?.static;
      const actualTimestamp = Number(realtime?.timestamp);
      if (!Number.isFinite(actualTimestamp)) continue;

      const routeId = String(
        realtime?.route_id || staticCourse?.route_id || ""
      ).trim();
      const destination = String(
        staticCourse?.destination || realtime?.destination || ""
      ).trim();
      const sourceTripId = String(
        staticCourse?.source_trip_id || realtime?.source_trip_id || realtime?.trip_id || ""
      ).trim();
      const scheduledTimestamp = Number(
        staticCourse?.timestamp ?? realtime?.scheduled_timestamp
      );
      const key = getConsumedRealtimeArrivalKey(
        stopId,
        routeId,
        destination,
        scheduledTimestamp,
        sourceTripId
      );
      if (!key) continue;

      const previous = consumedRealtimeArrivals.get(key);
      // Once the previously observed ETA has passed, keep the course consumed
      // even if a later/older feed update reports a newer ETA. This is the
      // continuity guarantee that prevents early vehicles from resurrecting
      // their original static times.
      if (previous && Number(previous.arrivalTimestamp) <= now) continue;

      const expiresAt = Math.max(
        Date.now() + CONSUMED_REALTIME_ARRIVAL_TTL_MS,
        actualTimestamp * 1000 + CONSUMED_REALTIME_ARRIVAL_TTL_MS
      );
      if (
        !previous
        || Number(previous.arrivalTimestamp) !== actualTimestamp
        || Number(previous.expiresAt) !== expiresAt
      ) {
        consumedRealtimeArrivals.set(key, {
          arrivalTimestamp: actualTimestamp,
          expiresAt
        });
        changed = true;
      }
    }

    if (changed) persistConsumedRealtimeArrivals();
  }

  function isConsumedRealtimeScheduledArrival(staticCourse, stopId = selectedStopId, nowSeconds = Date.now() / 1000) {
    pruneConsumedRealtimeArrivals();
    const key = getConsumedRealtimeArrivalKey(
      stopId,
      staticCourse?.route_id,
      staticCourse?.destination,
      staticCourse?.timestamp,
      staticCourse?.source_trip_id
    );
    if (!key) return false;

    const entry = consumedRealtimeArrivals.get(key);
    if (!entry) return false;
    const arrivalTimestamp = Number(entry.arrivalTimestamp);
    return Number.isFinite(arrivalTimestamp)
      && arrivalTimestamp <= Number(nowSeconds);
  }

  function getFavoriteStops() {
    try {
      const value = JSON.parse(localStorage.getItem(FAVORITE_STOPS_KEY) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function isFavoriteStop(stopId) {
    return getFavoriteStops().some(item => String(item.stop_id) === String(stopId));
  }

  function setFavoriteStop(stop) {
    const favorites = getFavoriteStops();
    const index = favorites.findIndex(item => String(item.stop_id) === String(stop.stop_id));

    if (index >= 0) {
      favorites.splice(index, 1);
    } else {
      favorites.push({
        stop_id: String(stop.stop_id),
        stop_code: String(stop.stop_code || stop.stop_id || ""),
        stop_name: String(stop.stop_name || stop.name || "Спирка")
      });
    }

    localStorage.setItem(FAVORITE_STOPS_KEY, JSON.stringify(favorites));
    return index < 0;
  }

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

  function getCurrentScheduleDayType() {
    if (typeof getTransportCalendarDayType === 'function') {
      return getTransportCalendarDayType();
    }

    const day = new Intl.DateTimeFormat("en-US", {
      timeZone: SOFIA_TIME_ZONE,
      weekday: "short"
    }).format(new Date());

    return day === "Sat" || day === "Sun"
      ? "weekend"
      : "weekday";
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

  function normalizeProxyStopCode(stop) {
    const rawCode = String(stop?.stop_code ?? stop?.stop_id ?? "").trim();
    if (!rawCode) return { candidates: [], isMetro: false };

    const rawId = String(stop?.stop_id ?? "").trim();
    const isMetro = /^M/i.test(rawCode) || /^M/i.test(rawId);
    const digits = rawCode.replace(/\D/g, "");

    // Dimitar's proxy is fed the public stop code. For surface stops the
    // proxy expects the numeric code without GTFS left-padding; keep the
    // original spelling as a second candidate because both forms exist in
    // different Sofia Traffic data generations.
    const candidates = [];
    if (digits) {
      candidates.push(String(Number(digits)));
      candidates.push(digits);
    }
    candidates.push(rawCode);

    return {
      candidates: [...new Set(candidates.filter(Boolean))],
      isMetro
    };
  }

  function getLineMeta(routeId, routeRef) {
    const id = String(routeId ?? "").trim();
    const ref = String(routeRef ?? "").trim();
    if (id && routeMetaById.has(id)) return routeMetaById.get(id);
    if (ref && routeMetaByNumber.has(ref)) return routeMetaByNumber.get(ref);

    const route = id ? routeById.get(id) : null;
    const number = ref || route?.route_short_name || "—";
    if (!route) {
      const subtype = /^N/i.test(number) ? "night" : null;
      return {
        id,
        number,
        type: "bus",
        subtype,
        icon: subtype === "night" ? "Icons/Active icons/night-bus.svg" : "Icons/Active icons/bus.svg",
        color: "#BE1E2D",
        textColor: "#FFFFFF"
      };
    }

    const type = typeof getLineType === 'function' ? getLineType(route) : "bus";
    const subtype = typeof getLineSubtype === 'function' ? getLineSubtype(route) : null;
    const icon = typeof getTransportIcon === 'function' ? getTransportIcon(type, number, subtype) : "";
    const color = typeof getLineColor === 'function' ? getLineColor(route, type) : "#BE1E2D";
    return {
      id: route.route_id,
      number,
      type,
      subtype,
      icon,
      color,
      textColor: route.route_text_color ? `#${route.route_text_color}` : "#FFFFFF"
    };
  }

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

  function parseGeneratedAt(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    const parsed = Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function getArrivalMinutes(timestamp) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return null;
    return Math.max(0, (seconds - Date.now() / 1000) / 60);
  }

  function formatArrivalCountdown(timestamp, nowSeconds = Date.now() / 1000) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return "";

    const remainingSeconds = Math.max(0, seconds - nowSeconds);
    // Preserve the old “Сега” window numerically: everything below one minute
    // is displayed as 0 мин. For one minute and above, use nearest-minute
    // rounding so 1:30 -> 2 мин. while 1:29 -> 1 мин.
    if (remainingSeconds < 60) return "0 мин.";
    return `${Math.max(1, Math.round(remainingSeconds / 60))} мин.`;
  }

  function formatArrivalClock(timestamp) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return "—";

    return new Intl.DateTimeFormat("bg-BG", {
      timeZone: SOFIA_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date(seconds * 1000));
  }

  function countdownHtml(arrival, showLive) {
    const timestamp = Number(arrival?.timestamp);
    const minutes = getArrivalMinutes(timestamp);
    if (!Number.isFinite(minutes)) return "";

    const clock = formatArrivalClock(timestamp);
    const live = showLive ? '<span class="vb-arrival-live" aria-hidden="true"></span>' : '';
    const countdown = formatArrivalCountdown(timestamp);

    return `<div class="vb-arrival-main">${live}<span class="vb-arrival-clock">${escapeHtml(clock)}</span><span class="vb-arrival-separator" aria-hidden="true">·</span><span class="vb-arrival-minutes" data-arrival-timestamp="${timestamp}">${escapeHtml(countdown)}</span></div>`;
  }

  function normalizeStopKey(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    const withoutMetroPrefix = raw.replace(/^M/i, "");
    const numeric = withoutMetroPrefix.replace(/^0+(?=\d)/, "");
    return numeric || "0";
  }

  function stopIdsMatch(left, right) {
    const leftRaw = String(left ?? "").trim();
    const rightRaw = String(right ?? "").trim();
    if (!leftRaw || !rightRaw) return false;

    // Metro station IDs (M1, M23, M302...) must never match surface
    // transport stop codes such as 0001, 0023, 0302.
    const leftMetro = /^M/i.test(leftRaw);
    const rightMetro = /^M/i.test(rightRaw);
    if (leftMetro !== rightMetro) return false;

    if (leftMetro && rightMetro) {
      return leftRaw.toUpperCase() === rightRaw.toUpperCase();
    }

    return normalizeStopKey(leftRaw) === normalizeStopKey(rightRaw);
  }

  function isMetroStop(stop) {
    return /^M/i.test(String(stop?.stop_id || "").trim())
      || /^M/i.test(String(stop?.stop_code || "").trim());
  }

  function getSofiaDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: SOFIA_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const get = type => parts.find(part => part.type === type)?.value || "";
    return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")) };
  }

  function getSofiaDateKey(date = new Date()) {
    const parts = getSofiaDateParts(date);
    if (![parts.year, parts.month, parts.day].every(Number.isFinite)) return "";
    return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  }

  function getSofiaWeekdayField(date = new Date()) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: SOFIA_TIME_ZONE,
      weekday: "long"
    }).format(date).toLowerCase();
    return weekday;
  }

  function isServiceActiveOnDate(serviceId, date = new Date()) {
    const id = String(serviceId ?? "").trim();
    if (!id) return true;

    const calendar = transportData?.calendar || {};
    const dateKey = getSofiaDateKey(date);
    if (!dateKey) return false;

    // serviceIdsByDate is generated directly from the full GTFS calendar plus
    // all calendar_dates exceptions, so the browser never has to ship or
    // interpret the large raw exception table. Outside the published window
    // we fail closed rather than inventing service.
    const byDate = calendar?.serviceIdsByDate;
    if (!byDate || !Object.prototype.hasOwnProperty.call(byDate, dateKey)) return false;
    return Array.isArray(byDate[dateKey])
      && byDate[dateKey].some(value => String(value).trim() === id);
  }

  function isScheduleRowActiveToday(schedule) {
    const serviceId = String(
      schedule?.service_id
      || findStaticTrip(schedule?.original_trip_id)?.service_id
      || ""
    ).trim();

    return isServiceActiveOnDate(serviceId);
  }

  function getSofiaOffsetMs(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: SOFIA_TIME_ZONE,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const raw = parts.find(part => part.type === "timeZoneName")?.value || "GMT+0";
    const match = raw.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!match) return 0;
    const sign = match[1] === "+" ? 1 : -1;
    return sign * (Number(match[2]) * 60 + Number(match[3] || 0)) * 60 * 1000;
  }

  function gtfsSecondsToTodayTimestamp(seconds) {
    const date = getSofiaDateParts();
    const baseUtc = Date.UTC(date.year, date.month - 1, date.day);
    const candidate = baseUtc + Number(seconds) * 1000 - getSofiaOffsetMs(new Date(baseUtc));
    return candidate / 1000;
  }

  function findStaticTrip(tripId) {
    return tripById.get(String(tripId)) || null;
  }

  function normalizeDirectionText(value) {
    return String(value ?? '')
      .trim()
      .toLocaleLowerCase('bg-BG')
      .replace(/\s+/g, ' ')
      .replace(/[–—]/g, '-')
      .replace(/[.]/g, '')
      .trim();
  }

  function getStaticDirectionForTrip(staticTrip) {
    if (!staticTrip?.route_id) return null;

    const routeId = String(staticTrip.route_id);
    const directions = transportData?.directions?.[routeId] || {};
    const tripId = String(staticTrip.trip_id || '').trim();
    if (!tripId) return null;

    // Direction identity follows the same model as Dimitar5555's data: a
    // trip belongs to a logical direction, and that direction is the unit
    // used by the board. Display text is not the identifier.
    for (const [key, direction] of Object.entries(directions)) {
      const tripIds = Array.isArray(direction?.trip_ids)
        ? direction.trip_ids.map(String)
        : [];
      if (tripIds.includes(tripId)) return { key, ...direction };
    }

    // Backward-compatible fallback for older generated data that does not
    // yet contain trip_ids on directions. Prefer the representative trip id,
    // then a unique shape id, and only finally the display headsign.
    for (const [key, direction] of Object.entries(directions)) {
      if (String(direction?.trip_id || '').trim() === tripId) {
        return { key, ...direction };
      }
    }

    const shapeId = String(staticTrip.shape_id || '').trim();
    if (shapeId) {
      const shapeMatches = Object.entries(directions).filter(([, direction]) =>
        String(direction?.shape_id || '').trim() === shapeId
      );
      if (shapeMatches.length === 1) {
        const [key, direction] = shapeMatches[0];
        return { key, ...direction };
      }
    }

    const headsign = normalizeDirectionText(staticTrip.trip_headsign);
    if (headsign) {
      for (const [key, direction] of Object.entries(directions)) {
        const directionHeadsign = normalizeDirectionText(
          direction?.headsign || direction?.destination
        );
        if (directionHeadsign && directionHeadsign === headsign) {
          return { key, ...direction };
        }
      }
    }

    return null;
  }

  function normalizeStopName(value) {
    return String(value ?? '')
      .trim()
      .toLocaleLowerCase('bg-BG')
      .replace(/["„“”'’]/g, '')
      .replace(/[–—-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getStopById(stopId) {
    const wanted = String(stopId ?? '').trim();
    if (!wanted) return null;
    return (transportData?.stops || []).find(stop =>
      stopIdsMatch(stop?.stop_id, wanted) || stopIdsMatch(stop?.stop_code, wanted)
    ) || null;
  }

  function getStopDistanceMeters(left, right) {
    const lat1 = Number(left?.stop_lat);
    const lon1 = Number(left?.stop_lon);
    const lat2 = Number(right?.stop_lat);
    const lon2 = Number(right?.stop_lon);
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;

    const toRad = value => value * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function isTerminalDirectionForStop(routeId, stopId, direction) {
    const pattern = Array.isArray(direction?.pattern) ? direction.pattern.map(String) : [];
    if (pattern.length < 2) return false;
    const selected = String(stopId ?? '').trim();
    if (!selected) return false;

    const terminalId = pattern[pattern.length - 1];
    if (stopIdsMatch(terminalId, selected)) return true;

    // GTFS can contain separate stop_ids for opposite platforms/approaches
    // of the same physical terminal (e.g. 0611/0612 at Дружба 2). Treat
    // those as the same terminal only when both the names match and the
    // coordinates are genuinely close, so identical names elsewhere do not
    // get filtered accidentally.
    const selectedStop = getStopById(selected);
    const terminalStop = getStopById(terminalId);
    if (!selectedStop || !terminalStop) return false;

    const selectedName = normalizeStopName(selectedStop.stop_name);
    const terminalName = normalizeStopName(terminalStop.stop_name);
    if (!selectedName || selectedName !== terminalName) return false;

    return getStopDistanceMeters(selectedStop, terminalStop) <= 300;
  }

  function getDirectionsForRouteAtStop(routeId, stopId) {
    const directionSet = transportData?.directions?.[String(routeId)] || {};
    return Object.entries(directionSet).filter(([, direction]) => {
      const pattern = Array.isArray(direction?.pattern) ? direction.pattern : [];
      return pattern.some(id => stopIdsMatch(id, stopId));
    }).map(([key, direction]) => ({ key, ...direction }));
  }

  function getDirectionTerminalStopId(direction) {
    const pattern = Array.isArray(direction?.pattern) ? direction.pattern.map(String) : [];
    return pattern.length ? String(pattern[pattern.length - 1]).trim() : '';
  }

  function getDirectionIdentity(direction, fallback = '') {
    const terminalStopId = getDirectionTerminalStopId(direction);
    return terminalStopId || String(direction?.key || fallback || '').trim();
  }

  function resolveDirectionForRealtimeRoute(routeId, stopId, staticTrip, destination = '', directionId = '') {
    const staticDirection = getStaticDirectionForTrip(staticTrip);
    if (staticDirection) return staticDirection;

    const directions = getDirectionsForRouteAtStop(routeId, stopId);
    if (!directions.length) return null;

    const wantedDestination = normalizeDirectionText(destination);
    if (wantedDestination) {
      const byDestination = directions.find(direction =>
        normalizeDirectionText(direction?.headsign || direction?.destination) === wantedDestination
      );
      if (byDestination) return byDestination;
    }

    const wantedDirectionId = String(directionId ?? '').trim();
    if (wantedDirectionId) {
      const byKey = directions.find(direction =>
        String(direction?.direction_id ?? direction?.key ?? '').trim() === wantedDirectionId
      );
      if (byKey) return byKey;
    }

    // Sofia's realtime feed often leaves direction_id empty. If this stop
    // belongs to only one static direction for the route, that direction is
    // unambiguous and can safely be used. This is what lets terminal stops
    // with separate GTFS stop IDs (such as 0611/0612) work correctly.
    return directions.length === 1 ? directions[0] : null;
  }

  function shouldHideTerminalArrival(routeId, stopId, staticTrip, destination = '', directionId = '') {
    const direction = resolveDirectionForRealtimeRoute(routeId, stopId, staticTrip, destination, directionId);
    if (direction?.pattern?.length && isTerminalDirectionForStop(routeId, stopId, direction)) return true;

    // The same physical terminal can be represented by different GTFS stop IDs
    // and even slightly different destination spellings (e.g. Ж.К. ДРУЖБА-2
    // vs Ж.к. Дружба 2). A destination matching the selected stop name is
    // therefore also treated as the terminal direction.
    const selectedStop = getStopById(stopId);
    const selectedName = normalizeStopName(selectedStop?.stop_name);
    const destinationName = normalizeStopName(destination);
    return !!selectedName && !!destinationName && selectedName === destinationName;
  }

  function isSkippedStaticSchedule(
    schedule,
    routeId,
    directionKey,
    selectedStopId,
    stopIndex,
    skippedTrips = []
  ) {
    if (!Array.isArray(skippedTrips) || !skippedTrips.length) return false;

    const scheduleRouteId = String(routeId || '').trim();
    const scheduleDirectionKey = String(directionKey || '').trim();
    const scheduleOriginalTripId = String(schedule?.original_trip_id || '').trim();
    const scheduleStartTime = parseGtfsTime(schedule?.start_time);
    const scheduleStopSequences = Array.isArray(schedule?.stop_sequences)
      ? schedule.stop_sequences
      : [];
    const selectedSequence = Number.isInteger(stopIndex)
      ? Number(scheduleStopSequences[stopIndex])
      : NaN;

    return skippedTrips.some(skipped => {
      if (!skipped) return false;

      const skippedRouteId = String(skipped.route_id || '').trim();
      if (skippedRouteId && scheduleRouteId && skippedRouteId !== scheduleRouteId) return false;

      const skippedStopId = String(skipped.stop_id || '').trim();
      if (skippedStopId) {
        if (!stopIdsMatch(skippedStopId, selectedStopId)) return false;
      } else {
        const skippedSequence = Number(skipped.stop_sequence);
        if (!Number.isFinite(skippedSequence) || !Number.isFinite(selectedSequence)) return false;
        if (skippedSequence !== selectedSequence) return false;
      }

      const skippedTripId = String(skipped.trip_id || '').trim();

      if (scheduleOriginalTripId && skippedTripId && scheduleOriginalTripId === skippedTripId) {
        return true;
      }

      if (!skippedTripId || scheduleStartTime == null) return false;

      const staticTrip = findStaticTrip(skippedTripId);
      if (!staticTrip) return false;

      const skippedDirection = getStaticDirectionForTrip(staticTrip);
      if (skippedDirection?.key
        && scheduleDirectionKey
        && String(skippedDirection.key) !== scheduleDirectionKey) {
        return false;
      }

      const skippedStartTime = parseGtfsTime(skipped.start_time);
      if (skippedStartTime == null) return false;

      return skippedStartTime === scheduleStartTime;
    });
  }

  function getStaticArrivalCandidates(stop, expectedType, skippedTrips = []) {
    const nowTimestamp = Date.now() / 1000;
    const horizonTimestamp = nowTimestamp + 2 * 60 * 60;
    const dayType = getCurrentScheduleDayType();
    const selectedStop = String(stop?.stop_id || stop?.stop_code || '').trim();
    if (!selectedStop) return [];

    const result = [];

    for (const route of (transportData?.routes || [])) {
      const routeType = typeof getLineType === 'function'
        ? getLineType(route)
        : String(route?.type || '').trim().toLowerCase();
      if (expectedType === 'surface' ? routeType === 'metro' : routeType !== expectedType) continue;

      const routeId = String(route?.route_id || '').trim();
      if (!routeId) continue;

      const directionSet = transportData?.directions?.[routeId] || {};
      const scheduleSet = transportData?.schedules?.[routeId] || {};
      const meta = getLineMeta(routeId, route.route_short_name || route.route_ref || '');

      for (const [directionKey, direction] of Object.entries(directionSet)) {
        const pattern = Array.isArray(direction?.pattern)
          ? direction.pattern.map(String)
          : [];
        const stopIndex = pattern.findIndex(id => stopIdsMatch(id, selectedStop));
        if (stopIndex < 0) continue;
        if (isTerminalDirectionForStop(routeId, selectedStop, direction)) continue;

        const daySchedules = scheduleSet?.[directionKey]?.[dayType];
        if (!Array.isArray(daySchedules)) continue;

        for (const schedule of daySchedules) {
          if (!isScheduleRowActiveToday(schedule)) continue;
          const times = Array.isArray(schedule?.times) ? schedule.times : [];
          const rawTime = times[stopIndex] ?? null;
          const seconds = parseGtfsTime(rawTime);
          if (seconds == null) continue;

          let timestamp = gtfsSecondsToTodayTimestamp(seconds);
          if (timestamp < nowTimestamp) timestamp += 86400;
          if (timestamp < nowTimestamp || timestamp > horizonTimestamp) continue;

          let terminalIndex = -1;
          for (let i = Math.min(times.length, pattern.length) - 1; i >= 0; i -= 1) {
            if (parseGtfsTime(times[i]) != null) {
              terminalIndex = i;
              break;
            }
          }
          if (terminalIndex < stopIndex) continue;

          const terminalStopId = String(
            pattern[terminalIndex] || getDirectionTerminalStopId(direction) || ''
          ).trim();
          if (!terminalStopId || stopIdsMatch(terminalStopId, selectedStop)) continue;

          if (isSkippedStaticSchedule(
            schedule,
            routeId,
            directionKey,
            selectedStop,
            stopIndex,
            skippedTrips
          )) continue;

          const isPartialCourse = !stopIdsMatch(
            terminalStopId,
            getDirectionTerminalStopId(direction)
          );
          const terminalStop = getStopById(terminalStopId);
          const destination = isPartialCourse
            ? (terminalStop?.stop_name || direction?.destination || direction?.headsign || '')
            : (direction?.destination || direction?.headsign || terminalStop?.stop_name || '');
          const sourceTripId = String(schedule?.original_trip_id || '').trim();
          const logicalTripId = String(schedule?.trip_id || '').trim();

          result.push({
            course_id: [routeId, directionKey, sourceTripId || logicalTripId, timestamp].join('|'),
            source_trip_id: sourceTripId,
            logical_trip_id: logicalTripId,
            route_id: routeId,
            route_ref: meta.number || route.route_short_name || route.route_ref || '—',
            direction_key: directionKey,
            terminal_stop_id: terminalStopId,
            destination,
            timestamp,
            scheduled_timestamp: timestamp,
            delay: null,
            scheduled: true,
            source: 'static',
            meta
          });
        }
      }
    }

    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  function getMetroScheduledArrivals(stop) {
    return getStaticArrivalCandidates(stop, 'metro');
  }

  function getSurfaceScheduledArrivals(stop, skippedTrips = []) {
    return getStaticArrivalCandidates(stop, 'surface', skippedTrips);
  }

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 45000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
      const data = await response.json();
      return { response, data };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchVirtualBoardViaServer(stop) {
    const stopCode = String(stop?.stop_code || stop?.stop_id || '').trim();
    if (!stopCode) throw new Error('Липсва код на спирката.');

    const url = `api/virtual-board?stop_code=${encodeURIComponent(stopCode)}`;
    const { response, data } = await fetchJsonWithTimeout(url, {
      headers: { Accept: 'application/json' }
    }, 20000);

    if (!response.ok) {
      const message = data?.error || `Realtime API заявката върна ${response.status}.`;
      throw new Error(message);
    }

    const generatedAt = data?.generated_at || Date.now();
    const skippedTrips = Array.isArray(data?.skipped_trips) ? data.skipped_trips : [];
    const metroStop = isMetroStop(stop);

    // Metro has no usable GTFS-RT feed in this project. It intentionally uses
    // the static timetable only; realtime is never consulted for metro stops.
    if (metroStop) {
      const metroCandidates = getMetroScheduledArrivals(stop);
      const mergedMetro = typeof globalThis.GtsofiaVirtualBoardArrivals?.mergeArrivalCandidates === 'function'
        ? globalThis.GtsofiaVirtualBoardArrivals.mergeArrivalCandidates({
          staticCandidates: metroCandidates,
          realtimeCandidates: [],
          nowSeconds: Date.now() / 1000,
          maxResults: 4,
          isStaticConsumed: () => false
        }).routes
        : [];
      return {
        status: mergedMetro.length ? 'ok' : 'empty',
        generatedAt,
        routes: mergedMetro
      };
    }

    const realtimeCandidates = [];
    const realtimeRoutes = Array.isArray(data?.routes) ? data.routes : [];

    for (const route of realtimeRoutes) {
      if (!route || !Array.isArray(route.times) || !route.times.length) continue;

      const staticTrip = findStaticTrip(route.trip_id);
      const routeId = String(route.route_id || staticTrip?.route_id || '').trim();
      if (!routeId) continue;

      if (route.destination_stop_id && shouldHideTerminalArrival(
        routeId,
        route.destination_stop_id,
        staticTrip,
        route.destination || '',
        route.direction_id || route.directionId || ''
      )) continue;

      if (shouldHideTerminalArrival(
        routeId,
        stop.stop_id,
        staticTrip,
        route.destination || '',
        route.direction_id || route.directionId || ''
      )) continue;

      const staticDirection = getStaticDirectionForTrip(staticTrip)
        || resolveDirectionForRealtimeRoute(
          routeId,
          stop.stop_id,
          staticTrip,
          route.destination || '',
          route.direction_id || route.directionId || ''
        );
      const routeMeta = getLineMeta(routeId, route.route_ref || '');
      const staticTerminalId = getDirectionTerminalStopId(staticDirection);
      const realtimeTerminalId = String(route.destination_stop_id || '').trim();
      const isPartialRealtime = !!realtimeTerminalId
        && !!staticTerminalId
        && !stopIdsMatch(realtimeTerminalId, staticTerminalId);
      const realtimeTerminal = isPartialRealtime ? getStopById(realtimeTerminalId) : null;
      const destination = isPartialRealtime
        ? (realtimeTerminal?.stop_name
          || route.destination
          || staticTrip?.trip_headsign
          || staticDirection?.destination
          || staticDirection?.headsign
          || '')
        : (staticDirection?.destination
          || staticDirection?.headsign
          || route.destination
          || staticTrip?.trip_headsign
          || '');

      // The API returns a row per realtime trip. Keep only the earliest arrival
      // at the requested stop for that trip; duplicate TripUpdate events must
      // never consume two positions in the passenger-facing four-item list.
      const earliest = route.times
        .map(time => ({
          timestamp: Number(time?.timestamp),
          scheduled_timestamp: Number.isFinite(Number(time?.scheduled_time))
            ? Number(time.scheduled_time)
            : null,
          delay: Number.isFinite(Number(time?.delay)) ? Number(time.delay) : null,
          stop_schedule_relationship: Number(time?.stop_schedule_relationship),
          stop_schedule_relationship_name: String(time?.stop_schedule_relationship_name || 'SCHEDULED')
        }))
        .filter(time => Number.isFinite(time.timestamp))
        .sort((a, b) => a.timestamp - b.timestamp)[0];
      if (!earliest) continue;

      realtimeCandidates.push({
        course_id: `rt|${route.trip_id || ''}|${routeId}|${earliest.timestamp}`,
        source_trip_id: String(route.trip_id || '').trim(),
        trip_id: String(route.trip_id || '').trim(),
        route_id: routeId,
        route_ref: route.route_ref || routeMeta.number || '—',
        direction_key: staticDirection?.key || '',
        destination,
        timestamp: earliest.timestamp,
        scheduled_timestamp: earliest.scheduled_timestamp,
        delay: earliest.delay,
        scheduled: false,
        source: 'realtime',
        realtime: true,
        schedule_relationship: Number(route?.schedule_relationship),
        schedule_relationship_name: String(route?.schedule_relationship_name || 'SCHEDULED'),
        destination_stop_id: realtimeTerminalId,
        meta: routeMeta
      });
    }

    const staticCandidates = getSurfaceScheduledArrivals(stop, skippedTrips);
    const merger = globalThis.GtsofiaVirtualBoardArrivals?.mergeArrivalCandidates;
    if (typeof merger !== 'function') {
      throw new Error('Arrival merge engine is not available.');
    }

    const nowSeconds = Date.now() / 1000;
    const merged = merger({
      staticCandidates,
      realtimeCandidates,
      nowSeconds,
      maxResults: 4,
      isStaticConsumed: candidate => isConsumedRealtimeScheduledArrival(candidate)
    });

    // Persist only courses whose realtime ETA has already reached/passed this
    // stop. The cache is keyed by exact source trip ID whenever possible, so a
    // shifted/early realtime course can never resurrect as its static schedule.
    rememberConsumedRealtimeArrivals(stop, merged.matches);

    return {
      status: merged.routes.length ? 'ok' : 'empty',
      generatedAt,
      routes: merged.routes
    };
  }

  async function fetchVirtualBoard(stop) {
    return fetchVirtualBoardViaServer(stop);
  }

  async function renderStopBoard(stop, boardData = null) {
    const renderToken = ++boardRenderToken;
    selectedStopId = String(stop.stop_id);
    lastExpiredPrimaryArrival = null;
    const panel = boardPanel();
    if (!panel) return;

    panel.innerHTML = `
      <div class="virtual-board-header">
        <div>
          <div class="virtual-board-kicker">Спирка ${escapeHtml(stop.stop_code || stop.stop_id || "")}</div>
          <h2>${escapeHtml(stop.stop_name || stop.name || "Спирка")}</h2>
        </div>
        <div class="virtual-board-header-actions">
          <button type="button" class="virtual-board-refresh is-loading" id="virtualBoardRefresh" disabled aria-label="Обнови таблото" title="Обнови таблото"><span aria-hidden="true">↻</span></button>
          <button type="button" class="virtual-board-favorite${isFavoriteStop(stop.stop_id) ? " is-favorite" : ""}" id="virtualBoardFavorite" aria-label="${isFavoriteStop(stop.stop_id) ? "Премахни от любими" : "Добави в любими"}" title="${isFavoriteStop(stop.stop_id) ? "Премахни от любими" : "Добави в любими"}"><span aria-hidden="true">${isFavoriteStop(stop.stop_id) ? "★" : "☆"}</span></button>
          <button type="button" class="virtual-board-close" id="virtualBoardClose" aria-label="Затвори таблото">×</button>
        </div>
      </div>
      <div class="virtual-board-list"><div class="virtual-board-loading">Зареждане…</div></div>
    `;

    document.getElementById("virtualBoardClose")?.addEventListener("click", () => {
      ++boardRenderToken;
      selectedStopId = null;
      lastExpiredPrimaryArrival = null;
      if (selectedStopMarker) {
        selectedStopMarker.setStyle({
          fillColor: "#111827",
          color: "#ffffff",
          fillOpacity: 1
        });
        selectedStopMarker = null;
      }
      renderEmptyBoard();
    });

    document.getElementById("virtualBoardFavorite")?.addEventListener("click", event => {
      const button = event.currentTarget;
      const favorite = setFavoriteStop(stop);
      button.classList.toggle("is-favorite", favorite);
      button.querySelector("span").textContent = favorite ? "★" : "☆";
      button.setAttribute("aria-label", favorite ? "Премахни от любими" : "Добави в любими");
      button.setAttribute("title", favorite ? "Премахни от любими" : "Добави в любими");
    });

    try {
      const data = boardData || await fetchVirtualBoard(stop);
      if (renderToken !== boardRenderToken || selectedStopId !== String(stop.stop_id)) return;
      const list = panel.querySelector(".virtual-board-list");

      if (data.status !== "ok" || !data.routes.length) {
        list.innerHTML = `<div class="virtual-board-no-data">Няма предстоящи заминавания.</div>`;
        return;
      }

      const rows = data.routes
        .map(route => ({
          ...route,
          arrivals: (route.times || [])
            .map(time => ({
              timestamp: Number(time?.timestamp),
              delay: Number.isFinite(Number(time?.delay)) ? Number(time?.delay) : null,
              scheduled: Boolean(time?.scheduled)
            }))
            .filter(time => Number.isFinite(time.timestamp))
            .filter(time => getArrivalMinutes(time.timestamp) >= 0)
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(0, 4)
        }))
        .filter(route => route.arrivals.length)
        .sort((a, b) => a.arrivals[0].timestamp - b.arrivals[0].timestamp);

      if (!rows.length) {
        list.innerHTML = `<div class="virtual-board-no-data">Няма предстоящи заминавания.</div>`;
        return;
      }

      list.innerHTML = rows.map((row, index) => {
        const meta = getLineMeta(row.route_id || row.routeId, row.route_ref);
        const arrivals = row.arrivals;
        const nextTimes = arrivals.slice(1, 4).map(time => {
          const tooltip = formatArrivalCountdown(time.timestamp);
          const clock = formatArrivalClock(time.timestamp);
          return `<span class="vb-next-time" tabindex="0" data-arrival-timestamp="${time.timestamp}" data-tooltip="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}">${escapeHtml(clock)}</span>`;
        }).join("");
        return `
          <article class="vb-row">
            <div class="schedule-summary-route-row vb-route-row">
              ${lineIdentityHtml(meta)}
              ${destinationHtml(row.destination || row.headsign || "")}
            </div>
            <div class="vb-time-block">
              ${countdownHtml(arrivals[0], !arrivals[0]?.scheduled)}
              ${arrivals.length > 1 ? `<div class="vb-next-times">${nextTimes}</div>` : ""}
            </div>
          </article>
        `;
      }).join("");
    } catch (error) {
      if (renderToken !== boardRenderToken || selectedStopId !== String(stop.stop_id)) return;
      console.error("Realtime virtual board error:", error);
      panel.querySelector(".virtual-board-list").innerHTML = `<div class="virtual-board-error">Realtime данните не могат да бъдат заредени.</div>`;
    } finally {
      if (renderToken !== boardRenderToken || selectedStopId !== String(stop.stop_id)) return;
      const refreshButton = document.getElementById("virtualBoardRefresh");
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.classList.remove("is-loading");
        refreshButton.addEventListener("click", () => refreshSelectedBoard(true), { once: true });
      }
    }
  }

  function renderEmptyBoard() {
    const panel = boardPanel();
    if (!panel) return;

    const favorites = getFavoriteStops();
    const favoritesHtml = favorites.length
      ? `
        <div class="virtual-board-favorites">
          <div class="virtual-board-favorites-heading">
            <h3>Любими спирки</h3>
          </div>
          <div class="virtual-board-favorites-list">
            ${favorites.map(stop => `
              <button type="button" class="virtual-board-favorite-stop" data-stop-id="${escapeHtml(stop.stop_id)}">
                <span class="virtual-board-favorite-stop-star" aria-hidden="true">★</span>
                <span class="virtual-board-favorite-stop-info">
                  <strong>${escapeHtml(stop.stop_name || "Спирка")}</strong>
                  <span>[${escapeHtml(stop.stop_code || stop.stop_id || "")}]</span>
                </span>
                <span class="virtual-board-favorite-stop-arrow" aria-hidden="true">→</span>
              </button>
            `).join("")}
          </div>
        </div>
      `
      : "";

    panel.innerHTML = `
      <div class="virtual-board-empty">
        <p>Изберете спирка от картата, за да видите следващите пристигания</p>
        ${favoritesHtml}
      </div>
    `;

    panel.querySelectorAll(".virtual-board-favorite-stop").forEach(button => {
      button.addEventListener("click", () => {
        const stop = findStopById(button.dataset.stopId);
        if (stop) selectStopOnMap(stop);
      });
    });
  }

  function findStopById(stopId) {
    return (transportData?.stops || []).find(
      stop => String(stop.stop_id) === String(stopId)
    ) || null;
  }

  function selectStopOnMap(stop) {
    if (!stop || !map) return;

    if (selectedStopMarker) {
      selectedStopMarker.setStyle({
        fillColor: "#111827",
        color: "#ffffff",
        fillOpacity: 1
      });
    }
    const lat = Number(stop.stop_lat);
    const lon = Number(stop.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const marker = stopMarkersById.get(String(stop.stop_id));
    if (marker) {
      marker.setStyle({
        fillColor: "#BE1E2D",
        color: "#ffffff",
        fillOpacity: 1
      });
      selectedStopMarker = marker;
    } else {
      selectedStopMarker = null;
    }

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

      const seen = new Set();
      return stops
        .filter(stop => {
          const name = normalized(stop.name || stop.stop_name);
          const code = normalized(stop.stop_code || stop.stop_id);
          return name.includes(needle) || code.includes(needle);
        })
        .filter(stop => {
          const key = String(stop.stop_code || stop.stop_id || "").trim();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
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
    stopMarkersById.clear();
    selectedStopMarker = null;

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
        fillOpacity: 1,
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
      stopMarkersById.set(String(stop.stop_id), marker);
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

    return stops.filter(stop => {
      const stopId = String(stop?.stop_id ?? "").trim();
      if (!activeStopIds.has(stopId)) return false;

      // GTFS contains station entrances/exits and other child locations
      // (location_type 2/3/4) which reuse stop IDs of real transport stops.
      // Virtual boards must show only actual boarding stops/stations.
      const locationType = String(stop?.location_type ?? "0").trim();
      return locationType === "0";
    });
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

  function updateBoardCountdowns() {
    const panel = boardPanel();
    if (!panel || !selectedStopId) return;

    const nowSeconds = Date.now() / 1000;
    let expiredPrimaryArrival = null;

    panel.querySelectorAll("[data-arrival-timestamp]").forEach(element => {
      const timestamp = Number(element.dataset.arrivalTimestamp);
      if (!Number.isFinite(timestamp)) return;

      const countdown = formatArrivalCountdown(timestamp, nowSeconds);
      if (element.classList.contains("vb-arrival-minutes")) {
        element.textContent = countdown;
        if (timestamp <= nowSeconds && expiredPrimaryArrival === null) {
          expiredPrimaryArrival = timestamp;
        }
        return;
      }

      element.dataset.tooltip = countdown;
      element.setAttribute("aria-label", countdown);
    });

    // Do not hold an expired primary arrival. Once its actual timestamp is
    // reached, immediately rebuild the board so the next merged RT/static
    // course can take its place. refreshInFlight prevents duplicate requests.
    if (
      expiredPrimaryArrival !== null
      && expiredPrimaryArrival !== lastExpiredPrimaryArrival
      && !refreshInFlight
    ) {
      lastExpiredPrimaryArrival = expiredPrimaryArrival;
      void refreshSelectedBoard(true);
    }
  }

  function startTimers() {
    clearInterval(refreshTimer);
    clearInterval(countdownTimer);

    countdownTimer = setInterval(updateBoardCountdowns, 1000);
    refreshTimer = setInterval(() => {
      if (selectedStopId) refreshSelectedBoard();
    }, REFRESH_MS);

    updateBoardCountdowns();
  }

  async function refreshSelectedBoard(force = false) {
    if (!selectedStopId || refreshInFlight) return;
    const requestedStopId = String(selectedStopId);
    const requestToken = boardRenderToken;
    const stop = findStopById(requestedStopId);
    if (!stop) return;

    const refreshButton = document.getElementById("virtualBoardRefresh");
    refreshButton?.classList.add("is-loading");
    if (refreshButton) refreshButton.disabled = true;
    refreshInFlight = true;

    try {
      const data = await fetchVirtualBoard(stop);
      if (requestToken !== boardRenderToken || selectedStopId !== requestedStopId) return;

      await renderStopBoard(stop, data);
    } catch (error) {
      if (requestToken !== boardRenderToken || selectedStopId !== requestedStopId) return;
      console.error("Неуспешно зареждане на GTFS-Realtime виртуално табло:", error);
      const list = boardPanel()?.querySelector(".virtual-board-list");
      if (list) list.innerHTML = `<div class="virtual-board-error">Realtime данните не могат да бъдат заредени.</div>`;
    } finally {
      refreshInFlight = false;

      // Automatic refreshes can fail (network hiccup, proxy timeout, malformed
      // response). In that case the board previously stayed in the spinning
      // state forever because only renderStopBoard() reset the button.
      // Restore the button whenever this refresh still belongs to the visible
      // board so the next automatic/manual refresh can run normally.
      if (requestToken === boardRenderToken && selectedStopId === requestedStopId) {
        const button = document.getElementById("virtualBoardRefresh");
        if (button) {
          button.disabled = false;
          button.classList.remove("is-loading");
        }
      }
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
        (transportData.sourceTrips || []).map(trip => [
          String(trip.trip_id),
          trip
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

      const allStops = transportData.stops || [];
      const stops = getActiveStops(allStops);
      initMap(stops);
      setupStopSearch(stops);
      setupGeolocation();
      renderEmptyBoard();

      const requestedStopId = new URLSearchParams(window.location.search).get("stop");
      if (requestedStopId) {
        const requestedStop = findStopById(requestedStopId);
        if (requestedStop) {
          selectStopOnMap(requestedStop);
        }
      }

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

  // Small test seam; production pages do not use this object.
  globalThis.__gtsofiaVirtualBoardTestInternals = {
    isServiceActiveOnDate,
    isScheduleRowActiveToday,
    getSofiaDateKey
  };
})();
```
