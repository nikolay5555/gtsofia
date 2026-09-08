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
  let routeMetaByNumber = new Map();
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
    const trip = {
      tripId: "",
      routeId: "",
      directionId: "",
      scheduleRelationship: null
    };

    while (state.index < bytes.length) {
      const field = readField(bytes, state);
      if (field.fieldNumber === 2 && field.wireType === 2) trip.startTime = decodeString(field.value);
      else if (field.fieldNumber === 3 && field.wireType === 2) trip.startDate = decodeString(field.value);
      else if (field.fieldNumber === 1 && field.wireType === 2) trip.tripId = decodeString(field.value);
      else if (field.fieldNumber === 4 && field.wireType === 0) trip.scheduleRelationship = Number(field.value);
      else if (field.fieldNumber === 5 && field.wireType === 2) trip.routeId = decodeString(field.value);
      else if (field.fieldNumber === 6 && field.wireType === 0) trip.directionId = String(Number(field.value));
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
    let feedTimestamp = null;

    while (state.index < bytes.length) {
      const field = readField(bytes, state);
      if (field.fieldNumber === 1 && field.wireType === 2) {
        const headerState = { index: 0 };
        while (headerState.index < field.value.length) {
          const headerField = readField(field.value, headerState);
          if (headerField.fieldNumber === 3 && headerField.wireType === 0) {
            feedTimestamp = Number(headerField.value) * 1000;
          }
        }
      } else if (field.fieldNumber === 2 && field.wireType === 2) {
        const entity = decodeFeedEntity(field.value);
        if (entity?.trip?.tripId) updates.push(entity);
      }
    }

    return { updates, feedTimestamp: feedTimestamp || Date.now() };
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
      return {
        id,
        number,
        type: /^N/i.test(number) ? "night" : "bus",
        icon: "",
        color: "#BE1E2D",
        textColor: "#FFFFFF"
      };
    }

    const type = typeof getLineType === "function" ? getLineType(route) : "bus";
    const icon = typeof getTransportIcon === "function" ? getTransportIcon(type, number) : "";
    const color = typeof getLineColor === "function" ? getLineColor(route, type) : "#BE1E2D";
    return {
      id: route.route_id,
      number,
      type,
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

    const rounded = Math.max(0, Math.ceil(minutes));
    const clock = formatArrivalClock(timestamp);
    const live = showLive ? '<span class="vb-arrival-live" aria-hidden="true"></span>' : '';

    return `<div class="vb-arrival-main">${live}<span class="vb-arrival-clock">${escapeHtml(clock)}</span><span class="vb-arrival-separator" aria-hidden="true">·</span><span class="vb-arrival-minutes">${rounded} мин.</span></div>`;
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

  function getSofiaDateParts() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: SOFIA_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const get = type => parts.find(part => part.type === type)?.value || "";
    return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")) };
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

  function getStaticDirectionForTrip(staticTrip) {
    if (!staticTrip?.route_id) return null;
    const directions = transportData?.directions?.[String(staticTrip.route_id)] || {};
    const headsign = String(staticTrip.trip_headsign || '').trim();
    for (const [key, direction] of Object.entries(directions)) {
      const directionHeadsign = String(direction?.headsign || direction?.destination || '').trim();
      if (directionHeadsign === headsign) return { key, ...direction };
    }
    return null;
  }

  function shouldHideTerminalArrival(routeId, stopId, staticTrip) {
    const directions = transportData?.directions?.[String(routeId)] || {};
    const entries = Object.entries(directions).filter(([, direction]) =>
      Array.isArray(direction?.pattern) && direction.pattern.length
    );
    if (entries.length < 2) return false;

    const selected = String(stopId ?? "").trim();
    let hasFirst = false;
    let hasLast = false;
    for (const [, direction] of entries) {
      const pattern = direction.pattern.map(String);
      const indexes = pattern.map((id, index) =>
        stopIdsMatch(id, selected) ? index : -1
      ).filter(index => index >= 0);
      if (!indexes.length) continue;
      if (indexes.includes(0)) hasFirst = true;
      if (indexes.includes(pattern.length - 1)) hasLast = true;
    }
    if (!hasFirst || !hasLast) return false;

    const staticDirection = getStaticDirectionForTrip(staticTrip);
    if (!staticDirection?.pattern?.length) return false;
    const pattern = staticDirection.pattern.map(String);
    const indexes = pattern.map((id, index) =>
      stopIdsMatch(id, selected) ? index : -1
    ).filter(index => index >= 0);

    // At a terminal that is simultaneously the origin of the reverse trip,
    // do not show the trip whose destination is the selected terminal itself.
    return indexes.includes(pattern.length - 1) && !indexes.includes(0);
  }

  function getMetroScheduledArrivals(stop) {
    const now = getNowGtfsSeconds();
    const weekend = isWeekendInSofia();
    const selectedStop = String(stop?.stop_id || stop?.stop_code || '').trim();
    if (!selectedStop) return [];

    const result = [];
    for (const route of (transportData?.routes || [])) {
      if (String(route?.route_type) !== '1') continue;

      const routeId = String(route.route_id || '').trim();
      const directionSet = transportData?.directions?.[routeId] || {};
      const scheduleSet = transportData?.schedules?.[routeId] || {};
      const meta = getLineMeta(routeId, route.route_short_name || '');

      for (const [directionKey, direction] of Object.entries(directionSet)) {
        const pattern = Array.isArray(direction?.pattern) ? direction.pattern.map(String) : [];
        const stopIndex = pattern.findIndex(id => stopIdsMatch(id, selectedStop));
        if (stopIndex < 0) continue;

        const daySchedules = scheduleSet?.[directionKey]?.[weekend ? 'weekend' : 'weekday'];
        if (!Array.isArray(daySchedules)) continue;

        const arrivals = [];
        for (const schedule of daySchedules) {
          const rawTime = Array.isArray(schedule?.times) ? schedule.times[stopIndex] : null;
          const seconds = parseGtfsTime(rawTime);
          if (seconds == null) continue;

          const todayTimestamp = gtfsSecondsToTodayTimestamp(seconds);
          let timestamp = todayTimestamp;
          if (timestamp < Date.now() / 1000) timestamp += 86400;
          arrivals.push(timestamp);
        }

        arrivals.sort((a, b) => a - b);
        const unique = [...new Set(arrivals)].slice(0, 4);
        if (!unique.length) continue;

        result.push({
          route_id: routeId,
          route_ref: meta.number || route.route_short_name || '—',
          destination: direction?.destination || direction?.headsign || '',
          times: unique.map(timestamp => ({ timestamp, delay: null, scheduled: true })),
          meta
        });
      }
    }
    return result;
  }

  function buildRealtimeRoutes(updates, stop, generatedAt) {
    const selectedStopIds = [stop.stop_id, stop.stop_code, String(stop.stop_id || "").replace(/^M/i, "")]
      .filter(Boolean)
      .map(String);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const grouped = new Map();

    for (const entity of updates) {
      const trip = entity?.trip;
      if (!trip || trip.scheduleRelationship === 3 || trip.scheduleRelationship === 2) continue;

      const staticTrip = findStaticTrip(trip.tripId);
      const routeId = trip.routeId || staticTrip?.route_id || "";
      const route = routeById.get(String(routeId));
      const meta = getLineMeta(routeId, route?.route_short_name || "");
      const destination = staticTrip?.trip_headsign || route?.route_long_name?.split("-")?.at(-1)?.trim() || "";

      const relevant = (entity.stopTimeUpdates || []).filter(update => {
        if (!update?.stopId || update.scheduleRelationship === 1 || update.scheduleRelationship === 2) return false;
        return selectedStopIds.some(id => stopIdsMatch(id, update.stopId));
      });

      for (const update of relevant) {
        if (shouldHideTerminalArrival(routeId, update.stopId, staticTrip)) continue;

        const event = update.arrival?.time != null
          ? update.arrival
          : update.departure?.time != null
            ? update.departure
            : null;
        if (!event || !Number.isFinite(event.time)) continue;

        const arrivalSeconds = Number(event.time);
        if (arrivalSeconds < nowSeconds - 30 || arrivalSeconds > nowSeconds + 3 * 3600) continue;

        const key = `${String(routeId)}|${String(destination)}|${String(meta.number || "")}`;
        if (!grouped.has(key)) {
          grouped.set(key, {
            route_id: routeId,
            route_ref: meta.number || route?.route_short_name || "—",
            destination,
            times: [],
            meta
          });
        }
        grouped.get(key).times.push({
          timestamp: arrivalSeconds,
          t: Math.max(0, (arrivalSeconds - nowSeconds) / 60)
        });
      }
    }

    const routes = [];
    for (const row of grouped.values()) {
      const seen = new Set();
      row.times = row.times
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter(item => {
          if (seen.has(item.timestamp)) return false;
          seen.add(item.timestamp);
          return true;
        })
        .slice(0, 4)
        .map(item => ({ t: item.t, timestamp: item.timestamp }));
      if (row.times.length) routes.push(row);
    }

    routes.sort((a, b) => a.times[0].timestamp - b.times[0].timestamp);
    return {
      status: routes.length ? "ok" : "ok",
      routes,
      generatedAt
    };
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchVirtualBoardViaServer(stop) {
    const stopCode = String(stop?.stop_code || stop?.stop_id || '').trim();
    if (!stopCode) throw new Error('Липсва код на спирката.');

    const url = `api/virtual-board?stop_code=${encodeURIComponent(stopCode)}`;
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/json'
      }
    }, 20000);

    if (!response.ok) {
      let message = `Realtime API заявката върна ${response.status}.`;
      try {
        const data = await response.json();
        message = data?.error || message;
      } catch {
        // The endpoint normally returns JSON on success and errors.
      }
      throw new Error(message);
    }

    const data = await response.json();
    const generatedAt = data?.generated_at || Date.now();
    const realtimeRoutes = Array.isArray(data?.routes)
      ? data.routes
          .filter(route => route && Array.isArray(route.times))
          .filter(route => {
            const staticTrip = findStaticTrip(route.trip_id);
            return !staticTrip || !shouldHideTerminalArrival(
              route.route_id || staticTrip?.route_id || '',
              stop.stop_id,
              staticTrip
            );
          })
          .map(route => {
            const staticTrip = findStaticTrip(route.trip_id);
            const staticDirection = getStaticDirectionForTrip(staticTrip);
            const routeMeta = getLineMeta(
              route.route_id || staticTrip?.route_id || '',
              route.route_ref || ''
            );

            return {
              ...route,
              route_id: route.route_id || staticTrip?.route_id || '',
              route_ref: route.route_ref || routeMeta.number || '—',
              destination: route.destination
                || staticTrip?.trip_headsign
                || staticDirection?.destination
                || staticDirection?.headsign
                || '',
              times: route.times
                .map(time => ({
                  timestamp: Number(time?.timestamp),
                  delay: Number.isFinite(Number(time?.delay)) ? Number(time.delay) : null
                }))
                .filter(time => Number.isFinite(time.timestamp))
            };
          })
          .filter(route => route.times.length)
      : [];

    const realtime = {
      status: data?.status || 'empty',
      generatedAt,
      routes: isMetroStop(stop) ? [] : realtimeRoutes
    };
    const metroRoutes = getMetroScheduledArrivals(stop);

    // Realtime rows are kept per trip by the API because Sofia's feed often
    // does not populate direction_id. Merge them back by line + destination
    // here, after terminal-direction filtering, so opposite directions never
    // get mixed into the same row.
    const mergedRealtime = new Map();
    for (const route of realtime.routes) {
      const staticTrip = findStaticTrip(route.trip_id);
      const staticDirection = getStaticDirectionForTrip(staticTrip);
      const destination = route.destination
        || staticTrip?.trip_headsign
        || staticDirection?.destination
        || staticDirection?.headsign
        || '';
      const key = `${String(route.route_id || '')}|${destination}|${String(route.route_ref || '')}`;

      if (!mergedRealtime.has(key)) {
        mergedRealtime.set(key, {
          ...route,
          destination,
          times: []
        });
      }
      mergedRealtime.get(key).times.push(...(route.times || []));
    }

    const mergedSurfaceRoutes = [...mergedRealtime.values()]
      .map(route => ({
        ...route,
        times: route.times
          .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
          .filter((time, index, list) =>
            index === 0 || Number(time.timestamp) !== Number(list[index - 1].timestamp)
          )
          .slice(0, 4)
      }))
      .filter(route => route.times.length);

    // Sofia Traffic currently does not provide usable Trip Updates for metro.
    // Keep surface transport realtime-only and add metro from the static GTFS
    // timetable when the selected stop is a metro station.
    const realtimeRouteIds = new Set(
      mergedSurfaceRoutes.map(route => String(route?.route_id || ''))
    );

    const routes = [
      ...mergedSurfaceRoutes,
      ...metroRoutes.filter(route =>
        !realtimeRouteIds.has(String(route.route_id || ''))
      )
    ];

    return {
      status: routes.length ? 'ok' : 'empty',
      generatedAt,
      routes
    };
  }

  async function fetchVirtualBoard(stop) {
    return fetchVirtualBoardViaServer(stop);
  }

  async function renderStopBoard(stop, boardData = null) {
    selectedStopId = String(stop.stop_id);
    const panel = boardPanel();
    if (!panel) return;

    panel.innerHTML = `
      <div class="virtual-board-header">
        <div>
          <div class="virtual-board-kicker">Спирка ${escapeHtml(stop.stop_code || stop.stop_id || "")}</div>
          <h2>${escapeHtml(stop.stop_name || stop.name || "Спирка")}</h2>
        </div>
        <div class="virtual-board-header-actions">
          <button type="button" class="virtual-board-refresh is-loading" id="virtualBoardRefresh" disabled>Обнови</button>
          <button type="button" class="virtual-board-close" id="virtualBoardClose" aria-label="Затвори таблото">×</button>
        </div>
      </div>
      <div class="virtual-board-list"><div class="virtual-board-loading">Зареждане…</div></div>
    `;

    document.getElementById("virtualBoardClose")?.addEventListener("click", () => {
      selectedStopId = null;
      renderEmptyBoard();
    });

    try {
      const data = boardData || await fetchVirtualBoard(stop);
      const list = panel.querySelector(".virtual-board-list");

      if (data.status !== "ok" || !data.routes.length) {
        list.innerHTML = `<div class="virtual-board-no-data">Няма налични realtime пристигания за тази спирка.</div>`;
        return;
      }

      const rows = data.routes
        .map(route => ({
          ...route,
          arrivals: (route.times || [])
            .map(time => ({
              timestamp: Number(time?.timestamp),
              delay: Number.isFinite(Number(time?.delay)) ? Number(time.delay) : null
            }))
            .filter(time => Number.isFinite(time.timestamp))
            .filter(time => getArrivalMinutes(time.timestamp) >= 0)
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(0, 4)
        }))
        .filter(route => route.arrivals.length)
        .sort((a, b) => a.arrivals[0].timestamp - b.arrivals[0].timestamp);

      if (!rows.length) {
        list.innerHTML = `<div class="virtual-board-no-data">Няма налични realtime пристигания за тази спирка.</div>`;
        return;
      }

      list.innerHTML = rows.map((row, index) => {
        const meta = getLineMeta(row.route_id || row.routeId, row.route_ref);
        const arrivals = row.arrivals;
        return `
          <article class="vb-row">
            <div class="schedule-summary-route-row vb-route-row">
              ${lineIdentityHtml(meta)}
              ${destinationHtml(row.destination || row.headsign || "")}
            </div>
            <div class="vb-time-block">
              ${countdownHtml(arrivals[0], true)}
              ${arrivals.length > 1 ? `<div class="vb-next-times">${arrivals.slice(1).map(time => `<span>${escapeHtml(formatArrivalClock(time.timestamp))}</span>`).join("")}</div>` : ""}
            </div>
          </article>
        `;
      }).join("");
    } catch (error) {
      console.error("Realtime virtual board error:", error);
      panel.querySelector(".virtual-board-list").innerHTML = `<div class="virtual-board-error">Realtime данните не могат да бъдат заредени.</div>`;
    } finally {
      const refreshButton = document.getElementById("virtualBoardRefresh");
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.classList.remove("is-loading");
        refreshButton.addEventListener("click", refreshSelectedBoard, { once: true });
      }
    }
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

    refreshTimer = setInterval(() => {
      if (selectedStopId) refreshSelectedBoard();
    }, REFRESH_MS);
  }

  async function refreshSelectedBoard() {
    if (!selectedStopId) return;

    const stop = findStopById(selectedStopId);
    if (!stop) return;

    const refreshButton = document.getElementById("virtualBoardRefresh");
    refreshButton?.classList.add("is-loading");
    if (refreshButton) refreshButton.disabled = true;

    try {
      const data = await fetchVirtualBoard(stop);
      await renderStopBoard(stop, data);
    } catch (error) {
      console.error("Неуспешно зареждане на GTFS-Realtime виртуално табло:", error);
      const list = boardPanel()?.querySelector(".virtual-board-list");
      if (list) list.innerHTML = `<div class="virtual-board-error">Realtime данните не могат да бъдат заредени.</div>`;
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
      routeMetaByNumber = new Map(
        lines.map(line => [String(line.number).trim(), line])
      );

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
