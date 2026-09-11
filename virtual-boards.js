(() => {
  const SOFIA_TIME_ZONE = "Europe/Sofia";
  const REFRESH_MS = 15000;
  const SOFIA_CENTER = [42.6977, 23.3219];

  let map = null;
  let selectedStopId = null;
  let refreshTimer = null;
  let clockTimer = null;
  let stopMarkers = null;
  let stopMarkersById = new Map();
  let transportData = null;
  let routeById = new Map();
  let routeMetaById = new Map();
  let routeMetaByNumber = new Map();
  let tripById = new Map();
  let tripStopsById = new Map();

  const boardPanel = () => document.getElementById("virtualBoardBody");
  // Vehicle departure latch: nothing is captured until the vehicle has
  // actually reached/departed its first stop.
  const vehicleDepartureState = new Map();

  function vehicleTripKey(row) {
    return `${String(row?.trip_id || "").trim()}|${String(row?.route_id || "").trim()}|${String(row?.direction_id || "").trim()}`;
  }

  function captureVehicleAfterFirstStop(row) {
    if (!row?.trip_id) return false;
    const key = vehicleTripKey(row);
    if (vehicleDepartureState.get(key)?.departed) return true;

    const firstStop = Array.isArray(row?.tracking_stops)
      ? row.tracking_stops
          .filter(item => item?.stop_id)
          .sort((a, b) => Number(a?.stop_sequence ?? 0) - Number(b?.stop_sequence ?? 0))[0]
      : null;

    const firstDeparture = Number(firstStop?.departure_timestamp ?? firstStop?.arrival_timestamp);
    if (Number.isFinite(firstDeparture) && firstDeparture <= Date.now() / 1000) {
      vehicleDepartureState.set(key, {
        departed: true,
        departure_timestamp: firstDeparture,
        destination_stop_id: row.destination_stop_id || ""
      });
      return true;
    }
    return false;
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

    const clock = formatArrivalClock(timestamp);
    const live = showLive ? '<span class="vb-arrival-live" aria-hidden="true"></span>' : '';
    const countdown = minutes < 1
      ? 'Сега'
      : `${Math.ceil(minutes)} мин.`;

    return `<div class="vb-arrival-main">${live}<span class="vb-arrival-clock">${escapeHtml(clock)}</span><span class="vb-arrival-separator" aria-hidden="true">·</span><span class="vb-arrival-minutes">${countdown}</span></div>`;
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

    // Backward-compatible fallback for an older transport.json that does not
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
        if (isTerminalDirectionForStop(routeId, selectedStop, direction)) continue;

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

  function getSurfaceScheduledArrivals(stop) {
    const nowTimestamp = Date.now() / 1000;
    const horizonTimestamp = nowTimestamp + 2 * 60 * 60;
    const weekend = isWeekendInSofia();
    const selectedStop = String(stop?.stop_id || stop?.stop_code || '').trim();
    if (!selectedStop) return [];

    const result = [];

    for (const route of (transportData?.routes || [])) {
      // Static fallback applies only to surface transport. Metro keeps its
      // existing static timetable logic below.
      if (String(route?.route_type) === '1') continue;

      const routeId = String(route?.route_id || '').trim();
      if (!routeId) continue;

      const directionSet = transportData?.directions?.[routeId] || {};
      const scheduleSet = transportData?.schedules?.[routeId] || {};
      const meta = getLineMeta(routeId, route.route_short_name || '');

      for (const [directionKey, direction] of Object.entries(directionSet)) {
        const pattern = Array.isArray(direction?.pattern) ? direction.pattern.map(String) : [];
        const stopIndex = pattern.findIndex(id => stopIdsMatch(id, selectedStop));
        if (stopIndex < 0) continue;

        // The generated schedule keeps partial courses in the parent direction
        // by padding the unused tail with nulls. Therefore the actual terminal
        // of a particular course must be derived from that course's own times,
        // not from direction.pattern alone.
        const daySchedules = scheduleSet?.[directionKey]?.[weekend ? 'weekend' : 'weekday'];
        if (!Array.isArray(daySchedules)) continue;

        const rowsByTerminal = new Map();
        for (const schedule of daySchedules) {
          const times = Array.isArray(schedule?.times) ? schedule.times : [];
          const rawTime = times[stopIndex] ?? null;
          const seconds = parseGtfsTime(rawTime);
          if (seconds == null) continue;

          // Find the last actually served stop for THIS course. A partial course
          // has nulls after its final stop, while a full course reaches the end
          // of the parent direction.
          let terminalIndex = -1;
          for (let i = Math.min(times.length, pattern.length) - 1; i >= 0; i--) {
            if (parseGtfsTime(times[i]) != null) {
              terminalIndex = i;
              break;
            }
          }
          if (terminalIndex < stopIndex) continue;

          const terminalStopId = String(
            pattern[terminalIndex] || getDirectionTerminalStopId(direction) || ''
          ).trim();
          if (!terminalStopId) continue;

          // A course whose actual terminal is the selected stop is still a
          // terminal arrival and should not appear on the board. This check is
          // per COURSE, which is the crucial difference from the old logic.
          if (stopIdsMatch(terminalStopId, selectedStop)) continue;

          let timestamp = gtfsSecondsToTodayTimestamp(seconds);
          if (timestamp < nowTimestamp) timestamp += 86400;
          if (timestamp < nowTimestamp || timestamp > horizonTimestamp) continue;

          const existing = rowsByTerminal.get(terminalStopId);
          if (!existing) {
            rowsByTerminal.set(terminalStopId, {
              timestamp,
              terminalStopId
            });
          } else if (timestamp < existing.timestamp) {
            existing.timestamp = timestamp;
          }
        }

        for (const { timestamp, terminalStopId } of rowsByTerminal.values()) {
          const isPartialCourse = !stopIdsMatch(terminalStopId, getDirectionTerminalStopId(direction));
          const terminalStop = getStopById(terminalStopId);
          const destination = isPartialCourse
            ? (terminalStop?.stop_name || direction?.destination || direction?.headsign || '')
            : (direction?.destination || direction?.headsign || terminalStop?.stop_name || '');

          result.push({
            route_id: routeId,
            direction_key: directionKey,
            direction,
            terminal_stop_id: terminalStopId,
            route_ref: meta.number || route.route_short_name || '—',
            destination,
            times: [{ timestamp, delay: null, scheduled: true }],
            meta,
            scheduled: true
          });
        }
      }
    }

    return result.sort((a, b) => a.times[0].timestamp - b.times[0].timestamp);
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
      const staticDirection = getStaticDirectionForTrip(staticTrip);
      const destination = staticDirection?.destination
        || staticDirection?.headsign
        || staticTrip?.trip_headsign
        || route?.route_long_name?.split("-")?.at(-1)?.trim()
        || "";

      const relevant = (entity.stopTimeUpdates || []).filter(update => {
        if (!update?.stopId || update.scheduleRelationship === 1 || update.scheduleRelationship === 2) return false;
        return selectedStopIds.some(id => stopIdsMatch(id, update.stopId));
      });

      for (const update of relevant) {
        if (shouldHideTerminalArrival(routeId, update.stopId, staticTrip, destination)) continue;

        const event = update.arrival?.time != null
          ? update.arrival
          : update.departure?.time != null
            ? update.departure
            : null;
        if (!event || !Number.isFinite(event.time)) continue;

        const arrivalSeconds = Number(event.time);
        if (arrivalSeconds < nowSeconds - 30 || arrivalSeconds > nowSeconds + 3 * 3600) continue;

        // Realtime TripUpdates can represent a partial course whose actual
        // final stop is an intermediate stop of the static parent direction.
        // Use the realtime trip's actual terminal as the board identity when
        // it is available; otherwise fall back to the static direction.
        const realtimeTerminalId = String(
          (entity.stopTimeUpdates || [])
            .filter(item => item?.stopId && ![1, 2].includes(item.scheduleRelationship))
            .sort((a, b) => Number(b?.stopSequence ?? -1) - Number(a?.stopSequence ?? -1))
            .find(item => item?.stopId)?.stopId || ''
        ).trim();
        const staticTerminalId = getDirectionTerminalStopId(staticDirection);
        const directionIdentity = realtimeTerminalId
          ? (stopIdsMatch(realtimeTerminalId, staticTerminalId)
              ? getDirectionIdentity(staticDirection, realtimeTerminalId)
              : realtimeTerminalId)
          : getDirectionIdentity(staticDirection, normalizeDirectionText(destination));
        const key = `${String(routeId)}|${directionIdentity}|${String(meta.number || "")}`;
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
            return !shouldHideTerminalArrival(
              route.route_id || staticTrip?.route_id || '',
              stop.stop_id,
              staticTrip,
              route.destination || '',
              route.direction_id || route.directionId || ''
            );
          })
          .map(route => {
            const staticTrip = findStaticTrip(route.trip_id);
            const routeId = route.route_id || staticTrip?.route_id || '';
            // Realtime trip_ids are not guaranteed to be present in today's
            // static GTFS export. In that case, resolve the logical direction
            // from the selected stop + realtime destination instead of leaving
            // the direction key empty. This is essential for short-turns such
            // as trolley 3 -> Пътностроителна техника.
            const staticDirection = getStaticDirectionForTrip(staticTrip)
              || resolveDirectionForRealtimeRoute(
                routeId,
                stop.stop_id,
                staticTrip,
                route.destination || '',
                route.direction_id || route.directionId || ''
              );
            const routeMeta = getLineMeta(
              routeId,
              route.route_ref || ''
            );

            return {
              ...route,
              route_id: route.route_id || staticTrip?.route_id || '',
              route_ref: route.route_ref || routeMeta.number || '—',
              direction_key: staticDirection?.key || '',
              destination_stop_id: route.destination_stop_id || '',
              tracking_stops: Array.isArray(route.tracking_stops) ? route.tracking_stops : [],
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
      const realtimeRouteId = String(route.route_id || staticTrip?.route_id || '').trim();
      const staticDirection = getStaticDirectionForTrip(staticTrip)
        || resolveDirectionForRealtimeRoute(
          realtimeRouteId,
          stop.stop_id,
          staticTrip,
          route.destination || '',
          route.direction_id || route.directionId || ''
        );
      const staticTerminalId = getDirectionTerminalStopId(staticDirection);
      const realtimeTerminalId = String(route.destination_stop_id || '').trim();
      const isPartialRealtime = !!realtimeTerminalId
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
      // The board row is a displayed line + destination, not a raw GTFS
      // stop_id. The same physical terminal can have multiple GTFS stop IDs
      // (platforms / approaches), which previously split one direction into
      // two rows. Partial courses still remain separate because their
      // displayed destination is their actual terminal stop name.
      const directionIdentity = normalizeDirectionText(destination);
      const key = `${String(route.route_id || staticTrip?.route_id || '')}|${directionIdentity}|${String(route.route_ref || '')}`;

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

    // For surface transport, use the static timetable as a fallback during
    // the two hours before the next scheduled course when CGM has not yet
    // published realtime data for that line/direction. Once realtime appears,
    // it wins and replaces the static fallback.
    const scheduledSurfaceRoutes = isMetroStop(stop) ? [] : getSurfaceScheduledArrivals(stop);
    function directionPatternsShareLongPrefix(shortDirection, longDirection, selectedStopId) {
      const shortPattern = Array.isArray(shortDirection?.pattern)
        ? shortDirection.pattern.map(String)
        : [];
      const longPattern = Array.isArray(longDirection?.pattern)
        ? longDirection.pattern.map(String)
        : [];
      if (!shortPattern.length || shortPattern.length >= longPattern.length) return false;

      let commonPrefix = 0;
      while (
        commonPrefix < shortPattern.length
        && commonPrefix < longPattern.length
        && stopIdsMatch(shortPattern[commonPrefix], longPattern[commonPrefix])
      ) {
        commonPrefix++;
      }

      // A short-turn does not have to be a literal prefix. It can take a
      // slightly different branch immediately before its terminal (as with
      // trolley 3: the two variants share the first 19 stops, then diverge).
      const shortRatio = commonPrefix / shortPattern.length;
      const longRatio = commonPrefix / longPattern.length;
      if (commonPrefix < 5 || shortRatio < 0.8 || longRatio < 0.7) return false;

      const shortStopIndex = shortPattern.findIndex(id => stopIdsMatch(id, selectedStopId));
      const longStopIndex = longPattern.findIndex(id => stopIdsMatch(id, selectedStopId));
      if (shortStopIndex < 0 || longStopIndex < 0) return false;

      // The shared section must actually extend beyond the selected stop;
      // otherwise this is merely two unrelated directions that happen to
      // start at the same origin.
      return commonPrefix > Math.max(shortStopIndex, longStopIndex);
    }

    function realtimeOverridesScheduledDirection(realtimeRoute, scheduledRoute, selectedStopId) {
      const routeId = String(scheduledRoute?.route_id || '');
      if (!routeId || routeId !== String(realtimeRoute?.route_id || '')) return false;

      const realtimeDirectionKey = String(realtimeRoute?.direction_key || '').trim();
      const scheduledDirectionKey = String(scheduledRoute?.direction_key || '').trim();
      if (realtimeDirectionKey && scheduledDirectionKey && realtimeDirectionKey === scheduledDirectionKey) {
        return true;
      }

      // Operational short-turn case: realtime may belong to a shorter static
      // direction (e.g. trolley 3 -> Пътностроителна техника), while the
      // scheduled fallback is the longer parent direction (-> Ж.К. ЛЕВСКИ Г).
      // For a realtime route that is actually visible at this stop, retain the
      // stricter, stop-aware check.
      if (!realtimeDirectionKey || !scheduledDirectionKey) return false;
      const directionSet = transportData?.directions?.[routeId] || {};
      const shortDirection = directionSet[realtimeDirectionKey];
      const longDirection = directionSet[scheduledDirectionKey];
      if (!shortDirection || !longDirection) return false;
      if (!directionPatternsShareLongPrefix(shortDirection, longDirection, selectedStopId)) return false;

      const realtimeTerminalId = String(realtimeRoute?.destination_stop_id || '').trim();
      const realtimeDestinationKey = normalizeDirectionText(realtimeRoute?.destination || '');
      const shortDestinationKey = normalizeDirectionText(
        shortDirection?.destination || shortDirection?.headsign || ''
      );

      return (
        (!!realtimeTerminalId && isTerminalDirectionForStop(routeId, realtimeTerminalId, shortDirection))
        || (!!shortDestinationKey && realtimeDestinationKey === shortDestinationKey)
      );
    }

    function activeShortDirectionOverridesScheduledDirection(scheduledRoute, activeDirections) {
      const routeId = String(scheduledRoute?.route_id || '').trim();
      const scheduledDirectionKey = String(scheduledRoute?.direction_key || '').trim();
      if (!routeId || !scheduledDirectionKey) return false;

      const directionSet = transportData?.directions?.[routeId] || {};
      const longDirection = directionSet[scheduledDirectionKey];
      if (!longDirection) return false;

      for (const activeDirection of activeDirections) {
        if (String(activeDirection?.route_id || '').trim() !== routeId) continue;
        const shortDirectionKey = String(activeDirection?.key || '').trim();
        if (!shortDirectionKey || shortDirectionKey === scheduledDirectionKey) continue;

        const shortDirection = directionSet[shortDirectionKey];
        if (!shortDirection) continue;

        // This test intentionally does NOT require the selected stop to be
        // present in the short direction. A short-turn must suppress the
        // longer scheduled parent even at stops that exist only after the
        // point where the two patterns diverge (e.g. trolley 3 at stop 2125).
        const shortPattern = Array.isArray(shortDirection?.pattern)
          ? shortDirection.pattern.map(String)
          : [];
        const longPattern = Array.isArray(longDirection?.pattern)
          ? longDirection.pattern.map(String)
          : [];
        if (!shortPattern.length || shortPattern.length >= longPattern.length) continue;

        // There are two forms of an operational short-turn:
        //   1) the short route is a prefix of the full route (e.g. 3 ->
        //      Пътностроителна техника vs Левски Г in one direction);
        //   2) the short route starts later and is effectively a suffix of
        //      the full route (the reverse direction of trolley 3).
        let commonPrefix = 0;
        while (
          commonPrefix < shortPattern.length &&
          commonPrefix < longPattern.length &&
          stopIdsMatch(shortPattern[commonPrefix], longPattern[commonPrefix])
        ) {
          commonPrefix++;
        }

        let commonSuffix = 0;
        while (
          commonSuffix < shortPattern.length &&
          commonSuffix < longPattern.length &&
          stopIdsMatch(
            shortPattern[shortPattern.length - 1 - commonSuffix],
            longPattern[longPattern.length - 1 - commonSuffix]
          )
        ) {
          commonSuffix++;
        }

        const prefixShortRatio = commonPrefix / shortPattern.length;
        const prefixLongRatio = commonPrefix / longPattern.length;
        const suffixShortRatio = commonSuffix / shortPattern.length;
        const suffixLongRatio = commonSuffix / longPattern.length;

        const prefixMatch =
          commonPrefix >= 5 &&
          prefixShortRatio >= 0.8 &&
          prefixLongRatio >= 0.7 &&
          commonPrefix < shortPattern.length;

        const suffixMatch =
          commonSuffix >= 5 &&
          suffixShortRatio >= 0.8 &&
          suffixLongRatio >= 0.7 &&
          commonSuffix < shortPattern.length;

        if (!prefixMatch && !suffixMatch) continue;

        // The defining property of an operational short-turn is the route
        // pattern itself, not the passenger-facing destination text. The
        // short variant intentionally ends at a different terminal, so the
        // destination names are normally different (e.g. an active short
        // turn ending at Пътностроителна техника vs the regular terminal
        // Левски Г). We therefore suppress the longer static direction when
        // an active realtime direction is a genuine strict prefix/suffix of
        // it. Unrelated directions with only a common origin/section are
        // protected by the strong overlap ratios and by requiring that the
        // short pattern is actually shorter than the long one.
        return true;
      }

      return false;
    }

    // A realtime row suppresses its own logical direction. It may also
    // suppress a longer scheduled direction when the realtime course belongs
    // to a shorter direction whose stop pattern is a true prefix of that
    // longer route (an operational short-turn such as trolley 3).
    const realtimeLogicalRoutes = mergedSurfaceRoutes.filter(route =>
      String(route.direction_key || '').trim()
    );

    const realtimeDirectionKeys = new Set(
      mergedSurfaceRoutes.map(route => {
        const routeId = String(route.route_id || '');
        const destinationKey = normalizeDirectionText(route.destination || '');
        return `${routeId}|${destinationKey}|${String(route.route_ref || '')}`;
      })
    );

    // active_trip_ids comes from the complete GTFS-RT feed, not just the
    // selected stop. This is needed for short-turns: at a stop that exists
    // only on the longer parent route, no short-turn trip can be visible
    // locally, but the active short-turn service still means the longer
    // scheduled fallback must not be shown.
    const activeDirections = [];
    const seenActiveDirectionKeys = new Set();
    for (const tripId of (Array.isArray(data?.active_trip_ids) ? data.active_trip_ids : [])) {
      const activeTrip = findStaticTrip(tripId);
      if (!activeTrip) continue;
      const activeDirection = getStaticDirectionForTrip(activeTrip);
      if (!activeDirection?.key) continue;
      const activeKey = `${String(activeTrip.route_id || '')}|${String(activeDirection.key)}`;
      if (seenActiveDirectionKeys.has(activeKey)) continue;
      seenActiveDirectionKeys.add(activeKey);
      activeDirections.push({
        route_id: String(activeTrip.route_id || ''),
        key: String(activeDirection.key),
        trip_id: String(activeTrip.trip_id || '')
      });
    }

    const surfaceFallbackRoutes = scheduledSurfaceRoutes.filter(route => {
      if (realtimeLogicalRoutes.some(realtimeRoute =>
        realtimeOverridesScheduledDirection(realtimeRoute, route, stop.stop_id)
      )) {
        return false;
      }

      if (activeShortDirectionOverridesScheduledDirection(route, activeDirections)) {
        return false;
      }

      // Passenger-facing merge for equivalent named terminals (e.g. 94 /
      // stop 1699 vs 1700).
      const routeId = String(route.route_id || '');
      const destinationKey = normalizeDirectionText(route.destination || '');
      const displayedKey = `${routeId}|${destinationKey}|${String(route.route_ref || '')}`;
      return !realtimeDirectionKeys.has(displayedKey);
    });

    // Some GTFS exports contain duplicate static directions with the same
    // destination/pattern. Keep only the earliest fallback row for a given
    // line + destination so the board never shows duplicate static entries.
    const fallbackByKey = new Map();
    for (const route of surfaceFallbackRoutes) {
      // Deduplicate by the direction the passenger actually sees. Different
      // GTFS terminal stop IDs can represent the same named destination.
      const destinationKey = normalizeDirectionText(route.destination || '');
      const key = `${String(route.route_id || '')}|${destinationKey}|${String(route.route_ref || '')}`;
      const existing = fallbackByKey.get(key);
      if (!existing || Number(route.times?.[0]?.timestamp) < Number(existing.times?.[0]?.timestamp)) {
        fallbackByKey.set(key, route);
      }
    }

    const surfaceRoutes = [...mergedSurfaceRoutes, ...fallbackByKey.values()]
      .sort((a, b) => Number(a.times?.[0]?.timestamp) - Number(b.times?.[0]?.timestamp));

    // Sofia Traffic currently does not provide usable Trip Updates for metro.
    // Keep surface transport realtime-only and add metro from the static GTFS
    // timetable when the selected stop is a metro station.
    const realtimeRouteIds = new Set(
      mergedSurfaceRoutes.map(route => String(route?.route_id || ''))
    );

    const routes = [
      ...surfaceRoutes,
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
          <button type="button" class="virtual-board-refresh is-loading" id="virtualBoardRefresh" disabled aria-label="Обнови таблото"><span aria-hidden="true">↻</span></button>
          <button type="button" class="virtual-board-close" id="virtualBoardClose" aria-label="Затвори таблото">×</button>
        </div>
      </div>
      <div class="virtual-board-list"><div class="virtual-board-loading">Зареждане…</div></div>
    `;

    document.getElementById("virtualBoardClose")?.addEventListener("click", () => {
      selectedStopId = null;
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

    try {
      const data = boardData || await fetchVirtualBoard(stop);
      const list = panel.querySelector(".virtual-board-list");

      if (data.status !== "ok" || !data.routes.length) {
        list.innerHTML = `<div class="virtual-board-no-data">Няма налични пристигания за тази спирка.</div>`;
        return;
      }

      const rows = data.routes
        .map(route => ({
          ...route,
          arrivals: (route.times || [])
            .map(time => ({
              timestamp: Number(time?.timestamp),
              delay: Number.isFinite(Number(time?.delay)) ? Number(time.delay) : null,
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
        list.innerHTML = `<div class="virtual-board-no-data">Няма налични пристигания за тази спирка.</div>`;
        return;
      }

      list.innerHTML = rows.map((row, index) => {
        const meta = getLineMeta(row.route_id || row.routeId, row.route_ref);
        const arrivals = row.arrivals;
        const nextTimes = arrivals.slice(1, 4).map(time => {
          const minutes = getArrivalMinutes(time.timestamp);
          const tooltip = Number.isFinite(minutes)
            ? (minutes < 1 ? "Сега" : `${Math.ceil(minutes)} мин.`)
            : "";
          const clock = formatArrivalClock(time.timestamp);
          return `<span class="vb-next-time" tabindex="0" data-tooltip="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}">${escapeHtml(clock)}</span>`;
        }).join("");
        captureVehicleAfterFirstStop(row);

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
