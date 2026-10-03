(() => {
  const SOFIA_TIME_ZONE = "Europe/Sofia";
  const REFRESH_MS = 15000;
  const SOFIA_CENTER = [42.6977, 23.3219];

  let map = null;
  let selectedStopId = null;
  let refreshTimer = null;
  let countdownTimer = null;
  let refreshInFlight = false;
  let lastExpiredPrimaryArrival = null;
  let boardRenderToken = 0;
  let clockTimer = null;
  let stopMarkers = null;
  let stopMarkersById = new Map();
  let transportData = null;
  let routeById = new Map();
  let routeMetaById = new Map();
  let routeMetaByNumber = new Map();
  let tripById = new Map();
  let tripStopsById = new Map();

  // Realtime stop updates disappear shortly after the vehicle passes the
  // selected stop. Keep the scheduled time they represented so the static
  // fallback does not immediately resurrect the same course (e.g. 10:57
  // realtime for a 10:59 scheduled course).
  const CONSUMED_REALTIME_ARRIVALS_KEY = "gtsofia.virtualBoard.consumedRealtimeArrivals.v2";
  const CONSUMED_REALTIME_ARRIVAL_TTL_MS = 20 * 60 * 1000;
  const consumedRealtimeArrivals = new Map();
  let consumedRealtimeArrivalsLoaded = false;

  // Remember which concrete realtime course replaced which static course.
  // The realtime update may disappear immediately after passing the stop, so
  // the next refresh must still know which static course has been consumed.
  const REALTIME_COURSE_STATE_KEY = "gtsofia.virtualBoard.realtimeCourseStates.v2";
  const REALTIME_COURSE_STATE_TTL_MS = 2 * 60 * 60 * 1000;
  const realtimeCourseStates = new Map();
  let realtimeCourseStatesLoaded = false;

  const boardPanel = () => document.getElementById("virtualBoardBody");


  const FAVORITE_STOPS_KEY = "gtsofia.favoriteStops";

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
        const expiresAt = Number(item?.expiresAt);
        if (key && Number.isFinite(expiresAt) && expiresAt > now) {
          consumedRealtimeArrivals.set(key, expiresAt);
        }
      }
    } catch {
      // sessionStorage can be unavailable in private/restricted browsing
      // contexts. The in-memory map still protects the current page session.
    }
  }

  function pruneConsumedRealtimeArrivals() {
    loadConsumedRealtimeArrivals();
    const now = Date.now();
    let changed = false;

    for (const [key, expiresAt] of consumedRealtimeArrivals) {
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        consumedRealtimeArrivals.delete(key);
        changed = true;
      }
    }

    if (changed) persistConsumedRealtimeArrivals();
  }

  function persistConsumedRealtimeArrivals() {
    try {
      sessionStorage.setItem(
        CONSUMED_REALTIME_ARRIVALS_KEY,
        JSON.stringify([...consumedRealtimeArrivals.entries()].map(([key, expiresAt]) => ({ key, expiresAt })))
      );
    } catch {
      // Keep working with the in-memory cache when sessionStorage is blocked.
    }
  }

  function getConsumedRealtimeArrivalKey(stopId, routeId, destination, scheduledTimestamp) {
    const timestamp = Number(scheduledTimestamp);
    if (!Number.isFinite(timestamp)) return "";

    return [
      normalizeStopKey(stopId),
      String(routeId || "").trim(),
      normalizeDirectionText(destination),
      Math.floor(timestamp)
    ].join("|");
  }

  function rememberConsumedRealtimeArrivals(stop, realtimeRoutes) {
    pruneConsumedRealtimeArrivals();
    const nowSeconds = Date.now() / 1000;
    const stopId = String(stop?.stop_id || stop?.stop_code || "").trim();
    if (!stopId) return;

    let changed = false;
    for (const route of realtimeRoutes || []) {
      const routeId = String(route?.route_id || "").trim();
      if (!routeId) continue;

      const destination = String(route?.destination || "").trim();
      for (const time of route?.times || []) {
        const actualTimestamp = Number(time?.timestamp);
        const scheduledTimestamp = Number(
          time?.matched_scheduled_timestamp
          ?? time?.scheduled_time
          ?? getRealtimeScheduledTimestamp(time)
        );
        if (!Number.isFinite(actualTimestamp) || !Number.isFinite(scheduledTimestamp)) continue;

        // The upstream API intentionally keeps a passed stop update visible
        // for about 60 seconds. Remember the exact static course it replaced
        // while the realtime arrival is already at/past the current time, so
        // a transient feed gap does not resurrect the timetable time.
        if (actualTimestamp > nowSeconds) continue;

        const key = getConsumedRealtimeArrivalKey(
          stopId,
          routeId,
          destination,
          scheduledTimestamp
        );
        if (!key || consumedRealtimeArrivals.has(key)) continue;

        consumedRealtimeArrivals.set(key, Date.now() + CONSUMED_REALTIME_ARRIVAL_TTL_MS);
        changed = true;
      }
    }

    if (changed) persistConsumedRealtimeArrivals();
  }

  function isConsumedRealtimeScheduledArrival(stopId, routeId, destination, scheduledTimestamp) {
    pruneConsumedRealtimeArrivals();
    const key = getConsumedRealtimeArrivalKey(stopId, routeId, destination, scheduledTimestamp);
    return !!key && consumedRealtimeArrivals.has(key);
  }

  function loadRealtimeCourseStates() {
    if (realtimeCourseStatesLoaded) return;
    realtimeCourseStatesLoaded = true;

    try {
      const raw = sessionStorage.getItem(REALTIME_COURSE_STATE_KEY);
      const stored = JSON.parse(raw || "[]");
      if (!Array.isArray(stored)) return;

      const now = Date.now();
      for (const state of stored) {
        const key = String(state?.key || "").trim();
        const expiresAt = Number(state?.expiresAt);
        if (key && Number.isFinite(expiresAt) && expiresAt > now) {
          realtimeCourseStates.set(key, {
            ...state,
            expiresAt
          });
        }
      }
    } catch {
      // Keep the in-memory state when sessionStorage is unavailable.
    }
  }

  function persistRealtimeCourseStates() {
    try {
      sessionStorage.setItem(
        REALTIME_COURSE_STATE_KEY,
        JSON.stringify([...realtimeCourseStates.entries()].map(([key, state]) => ({
          ...state,
          key
        })))
      );
    } catch {
      // Keep working with the in-memory state.
    }
  }

  function pruneRealtimeCourseStates() {
    loadRealtimeCourseStates();
    const now = Date.now();
    let changed = false;

    for (const [key, state] of realtimeCourseStates) {
      if (!Number.isFinite(Number(state?.expiresAt)) || Number(state.expiresAt) <= now) {
        realtimeCourseStates.delete(key);
        changed = true;
      }
    }

    if (changed) persistRealtimeCourseStates();
  }

  function getRealtimeCourseStateKey(stopId, route, time) {
    const stopKey = normalizeStopKey(stopId);
    const routeId = String(route?.route_id || "").trim();
    const tripId = String(
      time?.trip_instance_id
      || route?.trip_instance_id
      || time?.trip_id
      || route?.trip_id
      || ""
    ).trim();
    const startDate = String(
      time?.trip_start_date
      || route?.trip_start_date
      || route?.start_date
      || ""
    ).trim();
    const startTime = String(
      time?.trip_start_time
      || route?.trip_start_time
      || route?.start_time
      || ""
    ).trim();

    if (!stopKey || !routeId || (!tripId && !startTime)) return "";

    return [stopKey, routeId, tripId, startDate, startTime].join("|");
  }

  function findRealtimeCourseState(stopId, route, time) {
    pruneRealtimeCourseStates();

    const key = getRealtimeCourseStateKey(stopId, route, time);
    if (!key) return null;

    const direct = realtimeCourseStates.get(key);
    if (direct) return { key, state: direct };

    const stopKey = normalizeStopKey(stopId);
    const routeId = String(route?.route_id || "").trim();
    const tripId = String(
      time?.trip_instance_id
      || route?.trip_instance_id
      || time?.trip_id
      || route?.trip_id
      || ""
    ).trim();
    const startDate = String(
      time?.trip_start_date
      || route?.trip_start_date
      || route?.start_date
      || ""
    ).trim();
    const startTime = String(
      time?.trip_start_time
      || route?.trip_start_time
      || route?.start_time
      || ""
    ).trim();

    if (!stopKey || !routeId || !tripId) return null;

    let best = null;
    for (const [candidateKey, state] of realtimeCourseStates) {
      if (normalizeStopKey(state?.stop_id) !== stopKey) continue;
      if (String(state?.route_id || "").trim() !== routeId) continue;
      if (String(state?.trip_id || "").trim() !== tripId) continue;

      const candidateDate = String(state?.trip_start_date || "").trim();
      if (startDate && candidateDate && candidateDate !== startDate) continue;

      const candidateTime = String(state?.trip_start_time || "").trim();
      if (startTime && candidateTime === startTime) {
        return { key: candidateKey, state };
      }

      if (!best) best = { key: candidateKey, state };
    }

    return best;
  }

  function rememberRealtimeCourseAssignment(
    stop,
    realtimeRoute,
    realtimeTime,
    staticRoute,
    staticTime,
    matchStrength = 0
  ) {
    const key = getRealtimeCourseStateKey(
      stop?.stop_id || stop?.stop_code,
      realtimeRoute,
      realtimeTime
    );
    const scheduledTimestamp = Number(staticTime?.timestamp);
    const actualTimestamp = Number(realtimeTime?.timestamp);
    const staticCourseKey = getStaticCourseKey(staticRoute, staticTime);
    if (
      !key
      || !Number.isFinite(scheduledTimestamp)
      || !Number.isFinite(actualTimestamp)
      || !staticCourseKey
    ) return;

    const stopId = String(stop?.stop_id || stop?.stop_code || "").trim();
    const routeId = String(realtimeRoute?.route_id || "").trim();
    const destination = String(
      realtimeRoute?.destination || staticRoute?.destination || ""
    ).trim();
    const consumedKey = getConsumedRealtimeArrivalKey(
      stopId,
      routeId,
      destination,
      scheduledTimestamp
    );

    const existing = findRealtimeCourseState(stopId, realtimeRoute, realtimeTime);
    const stateKey = existing?.key || key;
    const previous = existing?.state || null;
    const previousStrength = Number(previous?.match_strength || 0);
    const currentStrength = Number(matchStrength || 0);

    const consumed = previous?.consumed === true
      || actualTimestamp <= Date.now() / 1000;
    const consumedCourseKeys = [
      ...new Set([
        ...(Array.isArray(previous?.consumed_static_course_keys)
          ? previous.consumed_static_course_keys
          : []),
        ...(previous?.consumed === true && previous?.static_course_key
          ? [String(previous.static_course_key).trim()]
          : []),
        ...(consumed ? [staticCourseKey] : [])
      ].filter(Boolean))
    ];

    const nextState = {
      ...(previous || {}),
      stop_id: stopId,
      route_id: routeId,
      trip_id: String(
        realtimeTime?.trip_instance_id
        || realtimeRoute?.trip_instance_id
        || realtimeTime?.trip_id
        || realtimeRoute?.trip_id
        || ""
      ).trim(),
      trip_start_date: String(
        realtimeTime?.trip_start_date
        || realtimeRoute?.trip_start_date
        || realtimeRoute?.start_date
        || ""
      ).trim(),
      trip_start_time: String(
        realtimeTime?.trip_start_time
        || realtimeRoute?.trip_start_time
        || realtimeRoute?.start_time
        || ""
      ).trim(),
      consumed_key: previous?.consumed_key || consumedKey,
      consumed_static_course_keys: consumedCourseKeys,
      last_actual_timestamp: actualTimestamp,
      consumed,
      expiresAt: Date.now() + REALTIME_COURSE_STATE_TTL_MS
    };

    if (
      !previous?.static_course_key
      || currentStrength > previousStrength
      || (
        currentStrength === previousStrength
        && String(previous.static_course_key).trim() === staticCourseKey
      )
    ) {
      nextState.static_course_key = staticCourseKey;
      nextState.match_strength = currentStrength;
      nextState.consumed_key = consumedKey || nextState.consumed_key;
    }

    realtimeCourseStates.set(stateKey, nextState);
    persistRealtimeCourseStates();
  }

  function promotePassedRealtimeCourseStates(nowSeconds = Date.now() / 1000) {
    pruneRealtimeCourseStates();
    let stateChanged = false;

    for (const state of realtimeCourseStates.values()) {
      if (state?.consumed) continue;

      const lastActualTimestamp = Number(state?.last_actual_timestamp);
      if (!Number.isFinite(lastActualTimestamp) || lastActualTimestamp > nowSeconds) continue;

      const consumedKey = String(state?.consumed_key || "").trim();
      if (consumedKey) {
        consumedRealtimeArrivals.set(
          consumedKey,
          Date.now() + CONSUMED_REALTIME_ARRIVAL_TTL_MS
        );
      }

      state.consumed = true;
      state.expiresAt = Date.now() + REALTIME_COURSE_STATE_TTL_MS;
      stateChanged = true;
    }

    if (stateChanged) {
      persistRealtimeCourseStates();
      persistConsumedRealtimeArrivals();
    }
  }

  function isRealtimeCourseConsumed(stop, route, time) {
    const match = findRealtimeCourseState(
      stop?.stop_id || stop?.stop_code,
      route,
      time
    );
    return match?.state?.consumed === true;
  }

  function isStaticCourseConsumed(stopId, staticRoute, staticTime) {
    pruneRealtimeCourseStates();

    const wantedStopId = normalizeStopKey(stopId);
    const courseKey = getStaticCourseKey(staticRoute, staticTime);
    if (!wantedStopId || !courseKey) return false;

    for (const state of realtimeCourseStates.values()) {
      if (state?.consumed !== true) continue;

      const stateStopId = normalizeStopKey(state?.stop_id);
      if (stateStopId !== wantedStopId) continue;

      if (String(state?.static_course_key || "").trim() === courseKey) {
        return true;
      }

      if (
        Array.isArray(state?.consumed_static_course_keys)
        && state.consumed_static_course_keys.some(
          key => String(key || "").trim() === courseKey
        )
      ) {
        return true;
      }
    }

    return false;
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

function parseRealtimeTripStartTimestamp(route) {
  const value = String(route?.trip_start_time || route?.start_time || '').trim();
  const seconds = parseGtfsTime(value);
  return seconds == null ? null : seconds;
}

const REALTIME_MATCH_STRENGTH = Object.freeze({
  TRIP_ID: 100,
  ALTERNATIVE_IDENTITY: 90,
  SCHEDULED_STOP_TIME: 80,
  START_TIME: 60
});

function getRealtimeTripScheduleRelationship(realtimeRoute, realtimeTime) {
  const raw = realtimeTime?.trip_schedule_relationship
    ?? realtimeRoute?.schedule_relationship;
  return Number.isFinite(Number(raw)) ? Number(raw) : 0;
}

function getRealtimeTripId(realtimeRoute, realtimeTime) {
  return String(
    realtimeTime?.trip_id
    || realtimeRoute?.trip_id
    || ""
  ).trim();
}

function getRealtimeTripStartDate(realtimeRoute, realtimeTime) {
  return String(
    realtimeTime?.trip_start_date
    || realtimeRoute?.trip_start_date
    || realtimeRoute?.start_date
    || ""
  ).trim();
}

function getRealtimeTripStartTime(realtimeRoute, realtimeTime) {
  return String(
    realtimeTime?.trip_start_time
    || realtimeTime?.start_time
    || realtimeRoute?.trip_start_time
    || realtimeRoute?.start_time
    || ""
  ).trim();
}

function getRealtimeTripDirectionId(realtimeRoute) {
  const value = realtimeRoute?.direction_id ?? realtimeRoute?.directionId;
  return String(value ?? "").trim();
}

function normalizeGtfsDateKey(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return "";
}

function getRealtimeScheduledTimestamp(time) {
  const relationship = Number(time?.trip_schedule_relationship);
  const scheduledRaw = time?.scheduled_time;
  const scheduledTimestamp = (
    scheduledRaw !== null
    && scheduledRaw !== undefined
    && String(scheduledRaw).trim() !== ""
  )
    ? Number(scheduledRaw)
    : NaN;

  // GTFS-RT scheduled_time is defined for NEW/REPLACEMENT/DUPLICATED
  // StopTimeEvents. For normal scheduled trips the authoritative schedule
  // anchor is time - delay because delay is relative to static GTFS.
  if (
    (
      relationship === 1
      || relationship === 5
      || relationship === 6
      || relationship === 8
    )
    && Number.isFinite(scheduledTimestamp)
    && scheduledTimestamp > 0
  ) {
    return scheduledTimestamp;
  }

  const actualTimestamp = Number(time?.timestamp);
  const delay = Number(time?.delay);
  if (Number.isFinite(actualTimestamp) && Number.isFinite(delay)) {
    return actualTimestamp - delay;
  }

  return null;
}

function materializeRealtimeTimestamp(realtimeTime, staticTime) {
  if (Number.isFinite(Number(realtimeTime?.timestamp))) {
    return Number(realtimeTime.timestamp);
  }

  const scheduledTimestamp = Number(staticTime?.timestamp);
  const delay = Number(realtimeTime?.delay);
  if (
    Number.isFinite(scheduledTimestamp)
    && Number.isFinite(delay)
  ) {
    const actualTimestamp = scheduledTimestamp + delay;
    realtimeTime.timestamp = actualTimestamp;
    return actualTimestamp;
  }

  return null;
}

function getStaticCourseKey(staticRoute, staticTime) {
  const routeId = String(staticRoute?.route_id || "").trim();
  const directionKey = String(staticRoute?.direction_key || "").trim();
  const serviceDate = normalizeGtfsDateKey(staticTime?.service_date);
  const originalTripId = String(staticTime?.original_trip_id || "").trim();
  const timestamp = Number(staticTime?.timestamp);

  if (!routeId || !Number.isFinite(timestamp)) return "";

  // GTFS trip_id is a static-trip identity. The service date distinguishes
  // repeated instances of that trip across service days.
  if (originalTripId) {
    return [routeId, serviceDate, originalTripId].join("|");
  }

  return [
    routeId,
    serviceDate,
    directionKey || normalizeDirectionText(staticRoute?.destination || ""),
    String(staticTime?.start_time || "").trim(),
    Math.floor(timestamp)
  ].join("|");
}

function findRealtimeStaticMatch(
  realtimeRoute,
  realtimeTime,
  staticEntries,
  matchedStaticCourseKeys
) {
  const candidates = (staticEntries || []).filter(entry => {
    const courseKey = getStaticCourseKey(entry?.staticRoute, entry?.time);
    return courseKey && !matchedStaticCourseKeys.has(courseKey);
  });

  const relationship = getRealtimeTripScheduleRelationship(realtimeRoute, realtimeTime);
  if (relationship === 2 || relationship === 6 || relationship === 8) {
    // UNSCHEDULED, DUPLICATED and NEW have no ordinary static course to
    // consume. DUPLICATED references a static template but does not modify it.
    return null;
  }

  const realtimeTripId = getRealtimeTripId(realtimeRoute, realtimeTime);
  const realtimeStartDate = normalizeGtfsDateKey(
    getRealtimeTripStartDate(realtimeRoute, realtimeTime)
  );
  const realtimeStartTime = getRealtimeTripStartTime(realtimeRoute, realtimeTime);
  const realtimeStartSeconds = parseGtfsTime(realtimeStartTime);
  const realtimeDirectionId = getRealtimeTripDirectionId(realtimeRoute);

  if (realtimeTripId) {
    let matches = candidates.filter(entry =>
      String(entry?.time?.original_trip_id || "").trim() === realtimeTripId
    );

    if (realtimeStartDate) {
      const dated = matches.filter(entry =>
        normalizeGtfsDateKey(entry?.time?.service_date) === realtimeStartDate
      );
      if (!dated.length) return null;
      matches = dated;
    }

    if (matches.length === 1) {
      return {
        entry: matches[0],
        strength: REALTIME_MATCH_STRENGTH.TRIP_ID,
        method: "trip_id"
      };
    }

    if (matches.length > 1) {
      // The same static trip_id can have multiple service-date instances in
      // the board window (especially around midnight). GTFS-RT start_date is
      // authoritative when present; otherwise choose the nearest static stop
      // time to the realtime scheduled anchor (time - delay), and finally to
      // the current instant. Do not reject a valid non-frequency trip merely
      // because another date instance is also visible in the window.
      const anchor = getRealtimeScheduledTimestamp(realtimeTime);
      const actual = Number(realtimeTime?.timestamp);
      const target = Number.isFinite(anchor)
        ? anchor
        : (Number.isFinite(actual) ? actual : Date.now() / 1000);

      matches.sort((left, right) =>
        Math.abs(Number(left.time?.timestamp) - target)
        - Math.abs(Number(right.time?.timestamp) - target)
      );

      if (Number.isFinite(Number(matches[0]?.time?.timestamp))) {
        return {
          entry: matches[0],
          strength: REALTIME_MATCH_STRENGTH.TRIP_ID,
          method: "trip_id_nearest_service_date"
        };
      }
    }

    // For REPLACEMENT the descriptor trip_id is explicitly the static trip
    // being replaced. Without an exact/dated course it is not safe to guess
    // a different static trip.
    if (relationship === 5) return null;
  }

  // GTFS allows trip_id to be omitted only when route_id, direction_id,
  // start_time and start_date identify one static trip. Our static entries
  // carry direction_id so we can implement that alternative identity directly.
  if (
    realtimeStartTime
    && realtimeStartSeconds != null
    && realtimeStartDate
    && realtimeDirectionId
  ) {
    const matches = candidates.filter(entry =>
      parseGtfsTime(entry?.time?.start_time) === realtimeStartSeconds
      && normalizeGtfsDateKey(entry?.time?.service_date) === realtimeStartDate
      && String(
        entry?.time?.direction_id
        || entry?.staticRoute?.direction_id
        || ""
      ).trim() === realtimeDirectionId
    );

    if (matches.length === 1) {
      return {
        entry: matches[0],
        strength: REALTIME_MATCH_STRENGTH.ALTERNATIVE_IDENTITY,
        method: "alternative_identity"
      };
    }
  }

  // For a scheduled trip, time - delay is the stop's scheduled POSIX time.
  // It is a safe last-resort anchor when the producer omitted trip_id. Require
  // uniqueness; never pick the first row among simultaneous directions.
  const realtimeScheduledTimestamp = getRealtimeScheduledTimestamp(realtimeTime);
  if (Number.isFinite(realtimeScheduledTimestamp)) {
    let matches = candidates.filter(entry =>
      Number(entry?.time?.timestamp) === realtimeScheduledTimestamp
    );

    if (realtimeDirectionId) {
      const directional = matches.filter(entry =>
        String(
          entry?.time?.direction_id
          || entry?.staticRoute?.direction_id
          || ""
        ).trim() === realtimeDirectionId
      );
      if (directional.length) matches = directional;
    }

    if (matches.length === 1) {
      return {
        entry: matches[0],
        strength: REALTIME_MATCH_STRENGTH.SCHEDULED_STOP_TIME,
        method: "scheduled_stop_time"
      };
    }
  }

  // Compatibility fallback for an otherwise valid feed with incomplete
  // direction metadata. Still require uniqueness after all available identity
  // fields; never guess between two courses with the same start time.
  if (realtimeStartSeconds != null) {
    let matches = candidates.filter(entry =>
      parseGtfsTime(entry?.time?.start_time) === realtimeStartSeconds
    );

    if (realtimeStartDate) {
      const dated = matches.filter(entry =>
        normalizeGtfsDateKey(entry?.time?.service_date) === realtimeStartDate
      );
      if (dated.length) matches = dated;
    }

    if (realtimeDirectionId) {
      const directional = matches.filter(entry =>
        String(
          entry?.time?.direction_id
          || entry?.staticRoute?.direction_id
          || ""
        ).trim() === realtimeDirectionId
      );
      if (directional.length) matches = directional;
    }

    if (matches.length === 1) {
      return {
        entry: matches[0],
        strength: REALTIME_MATCH_STRENGTH.START_TIME,
        method: "start_time"
      };
    }
  }

  return null;
}

// Compatibility seam for existing tests and older callers. It delegates to the
// same matcher but exposes only the original array index.
function findRealtimeStaticMatchIndex(
  realtimeRoute,
  realtimeTime,
  staticTimes,
  matchedStaticIndexes
) {
  const entries = (staticTimes || []).map(time => ({
    staticRoute: { route_id: '__TEST_ROUTE__', direction_key: 'D1' },
    time
  }));
  const matchedKeys = new Set(
    (matchedStaticIndexes || []).size
      ? [...(matchedStaticIndexes || [])]
        .map(index => getStaticCourseKey(
          { route_id: '__TEST_ROUTE__', direction_key: 'D1' },
          staticTimes[index]
        ))
        .filter(Boolean)
      : []
  );
  const match = findRealtimeStaticMatch(
    realtimeRoute,
    realtimeTime,
    entries,
    matchedKeys
  );

  if (!match) return -1;
  return entries.indexOf(match.entry);
}

function findRealtimeStaticMatchEntryAcrossDirections(
  realtimeRoute,
  realtimeTime,
  staticEntries,
  matchedStaticCourseKeys
) {
  return findRealtimeStaticMatch(
    realtimeRoute,
    realtimeTime,
    staticEntries,
    matchedStaticCourseKeys
  )?.entry || null;
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
      const fallbackType = "bus";
      const fallbackSubtype = /^N/i.test(number) ? "night" : "";
      return {
        id,
        number,
        type: fallbackType,
        subtype: fallbackSubtype,
        icon: typeof getTransportIcon === "function"
          ? getTransportIcon(fallbackType, number, fallbackSubtype)
          : "",
        color: typeof getLineColor === "function"
          ? getLineColor(null, fallbackType, fallbackSubtype)
          : "#BE1E2D",
        textColor: "#FFFFFF"
      };
    }

    const type = typeof getLineType === "function" ? getLineType(route) : "bus";
    const subtype = typeof getLineSubtype === "function" ? getLineSubtype(route) : "";
    const icon = typeof getTransportIcon === "function" ? getTransportIcon(type, number, subtype) : "";
    const color = typeof getLineColor === "function" ? getLineColor(route, type, subtype) : "#BE1E2D";
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

    const remainingSeconds = seconds - nowSeconds;
    const remainingMinutes = Math.max(0, Math.floor(remainingSeconds / 60));
    return `${remainingMinutes} мин.`;
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

    // The generated date map is an exact GTFS evaluation of calendar.txt +
    // calendar_dates.txt for the current data window. Prefer it whenever the
    // requested date is covered because it already includes exceptions.
    const byDate = calendar?.serviceIdsByDate;
    if (byDate && Object.prototype.hasOwnProperty.call(byDate, dateKey)) {
      return Array.isArray(byDate[dateKey])
        && byDate[dateKey].some(value => String(value).trim() === id);
    }

    // Fall back to the raw GTFS calendar tables so a stale/older generated
    // date window cannot accidentally turn a future-only service into today's
    // service. This also preserves support for feeds that contain calendar.txt.
    let active = false;
    const weekdayField = getSofiaWeekdayField(date);
    const pattern = (calendar?.servicePatterns || []).find(row =>
      String(row?.service_id || "").trim() === id
    );

    if (pattern) {
      const start = String(pattern.start_date || "").trim();
      const end = String(pattern.end_date || "").trim();
      const compactDate = dateKey.replaceAll("-", "");
      active = compactDate >= start
        && compactDate <= end
        && String(pattern?.[weekdayField] || "") === "1";
    }

    for (const exception of (calendar?.exceptions || [])) {
      if (String(exception?.service_id || "").trim() !== id) continue;
      const exceptionDate = String(exception?.date || "").trim();
      if (exceptionDate !== dateKey.replaceAll("-", "")) continue;
      const type = String(exception?.exception_type || "").trim();
      if (type === "1") active = true;
      if (type === "2") active = false;
    }

    return active;
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

  function shiftSofiaDateKey(date = new Date(), offsetDays = 0) {
    const parts = getSofiaDateParts(date);
    if (![parts.year, parts.month, parts.day].every(Number.isFinite)) return "";

    const shifted = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day) + offsetDays * 86400 * 1000
    );

    return [
      String(shifted.getUTCFullYear()).padStart(4, "0"),
      String(shifted.getUTCMonth() + 1).padStart(2, "0"),
      String(shifted.getUTCDate()).padStart(2, "0")
    ].join("-");
  }

  function gtfsSecondsToServiceDateTimestamp(serviceDate, seconds) {
    const normalizedDate = normalizeGtfsDateKey(serviceDate);
    const numericSeconds = Number(seconds);
    if (
      !normalizedDate
      || !Number.isFinite(numericSeconds)
      || numericSeconds < 0
    ) return null;

    const [year, month, day] = normalizedDate.split("-").map(Number);
    if (![year, month, day].every(Number.isFinite)) return null;

    const baseUtc = Date.UTC(year, month - 1, day);
    const candidate = (
      baseUtc
      + numericSeconds * 1000
      - getSofiaOffsetMs(new Date(baseUtc))
    );

    return candidate / 1000;
  }

  function getBoardServiceDates(now = new Date()) {
    // The previous service date is needed for GTFS times such as 25:30:00
    // after midnight. The next two dates cover ordinary next-day departures
    // and late-running >24h service while preserving the service-date meaning.
    return [-1, 0, 1, 2]
      .map(offset => shiftSofiaDateKey(now, offset))
      .filter(Boolean);
  }

  function getCalendarDayTypeForDate(serviceDate) {
    const normalized = normalizeGtfsDateKey(serviceDate);
    if (!normalized) return "";

    const calendar = transportData?.calendar || {};
    const explicit = calendar?.dateTypes?.[normalized];
    if (explicit === "weekday" || explicit === "weekend") return explicit;

    const date = new Date(`${normalized}T12:00:00Z`);
    const weekday = date.getUTCDay();
    return weekday === 0 || weekday === 6 ? "weekend" : "weekday";
  }

  function isSuppressedStaticSchedule(
    schedule,
    routeId,
    directionKey,
    serviceDate,
    suppressedTrips = []
  ) {
    if (!Array.isArray(suppressedTrips) || !suppressedTrips.length) return false;

    const scheduleOriginalTripId = String(schedule?.original_trip_id || "").trim();
    const scheduleStartTime = parseGtfsTime(schedule?.start_time);
    const normalizedServiceDate = normalizeGtfsDateKey(serviceDate);

    return suppressedTrips.some(suppressed => {
      if (!suppressed) return false;

      const suppressedRouteId = String(suppressed?.route_id || "").trim();
      if (
        suppressedRouteId
        && routeId
        && suppressedRouteId !== routeId
      ) return false;

      const suppressedTripId = String(
        suppressed?.trip_id || suppressed?.source_trip_id || ""
      ).trim();

      if (
        suppressedTripId
        && scheduleOriginalTripId
        && suppressedTripId === scheduleOriginalTripId
      ) {
        const suppressedDate = normalizeGtfsDateKey(suppressed?.start_date);
        return !suppressedDate || !normalizedServiceDate || suppressedDate === normalizedServiceDate;
      }

      const suppressedStartTime = parseGtfsTime(suppressed?.start_time);
      if (suppressedStartTime == null || scheduleStartTime == null) return false;

      const suppressedDate = normalizeGtfsDateKey(suppressed?.start_date);
      if (suppressedDate && normalizedServiceDate && suppressedDate !== normalizedServiceDate) {
        return false;
      }

      const suppressedDirectionId = String(suppressed?.direction_id || "").trim();
      const scheduleDirectionId = String(
        schedule?.direction_id || ""
      ).trim();
      if (
        suppressedDirectionId
        && scheduleDirectionId
        && suppressedDirectionId !== scheduleDirectionId
      ) return false;

      if (
        directionKey
        && scheduleDirectionId === ""
        && suppressedDirectionId === ""
      ) return false;

      return suppressedStartTime === scheduleStartTime;
    });
  }

  function getStaticScheduleTimeValue(schedule, stopIndex) {
    const arrivalTimes = Array.isArray(schedule?.arrival_times)
      ? schedule.arrival_times
      : [];
    const departureTimes = Array.isArray(schedule?.departure_times)
      ? schedule.departure_times
      : [];
    const effectiveTimes = Array.isArray(schedule?.times)
      ? schedule.times
      : [];

    return (
      arrivalTimes[stopIndex]
      || departureTimes[stopIndex]
      || effectiveTimes[stopIndex]
      || ""
    );
  }

  function getStaticTerminalIndex(schedule, pattern) {
    const arrivalTimes = Array.isArray(schedule?.arrival_times)
      ? schedule.arrival_times
      : [];
    const departureTimes = Array.isArray(schedule?.departure_times)
      ? schedule.departure_times
      : [];
    const effectiveTimes = Array.isArray(schedule?.times)
      ? schedule.times
      : [];
    const max = Math.min(
      pattern.length,
      Math.max(arrivalTimes.length, departureTimes.length, effectiveTimes.length)
    );

    for (let i = max - 1; i >= 0; i--) {
      if (
        parseGtfsTime(arrivalTimes[i]) != null
        || parseGtfsTime(departureTimes[i]) != null
        || parseGtfsTime(effectiveTimes[i]) != null
      ) {
        return i;
      }
    }

    return -1;
  }

  function collectStaticSchedulesForDirection(scheduleSet, serviceDate) {
    const dayType = getCalendarDayTypeForDate(serviceDate);
    const result = new Map();

    // Search both buckets because calendar_dates.txt may override the normal
    // weekday/weekend classification. Exact service_id evaluation below is
    // authoritative for whether a concrete trip operates on this date.
    for (const bucket of ["weekday", "weekend"]) {
      for (const schedule of Array.isArray(scheduleSet?.[bucket]) ? scheduleSet[bucket] : []) {
        const serviceId = String(schedule?.service_id || "").trim();

        if (!serviceId && bucket !== dayType) continue;
        if (
          serviceId
          && !isServiceActiveOnDate(serviceId, new Date(`${serviceDate}T12:00:00Z`))
        ) continue;

        const identity = [
          String(schedule?.original_trip_id || schedule?.trip_id || "").trim(),
          String(schedule?.start_time || "").trim()
        ].join("|");

        if (!identity || result.has(identity)) continue;
        result.set(identity, schedule);
      }
    }

    return [...result.values()];
  }

  function getMetroScheduledArrivals(stop) {
    const nowTimestamp = Date.now() / 1000;
    const horizonTimestamp = nowTimestamp + 2 * 60 * 60;
    const selectedStop = String(stop?.stop_id || stop?.stop_code || "").trim();
    if (!selectedStop) return [];

    const result = [];
    const serviceDates = getBoardServiceDates();

    for (const route of (transportData?.routes || [])) {
      if (String(route.route_type) !== "1") continue;

      const routeId = String(route.route_id || "").trim();
      const directionSet = transportData?.directions?.[routeId] || {};
      const scheduleSet = transportData?.schedules?.[routeId] || {};
      const meta = getLineMeta(routeId, route.route_short_name || "");

      for (const [directionKey, direction] of Object.entries(directionSet)) {
        const pattern = Array.isArray(direction?.pattern) ? direction.pattern.map(String) : [];
        const stopIndex = pattern.findIndex(id => stopIdsMatch(id, selectedStop));
        if (stopIndex < 0) continue;
        if (isTerminalDirectionForStop(routeId, selectedStop, direction)) continue;

        const arrivals = [];
        for (const serviceDate of serviceDates) {
          const schedules = collectStaticSchedulesForDirection(scheduleSet, serviceDate);
          for (const schedule of schedules) {
            const rawTime = getStaticScheduleTimeValue(schedule, stopIndex);
            const seconds = parseGtfsTime(rawTime);
            if (seconds == null) continue;

            const timestamp = gtfsSecondsToServiceDateTimestamp(serviceDate, seconds);
            if (!Number.isFinite(timestamp)) continue;
            if (timestamp < nowTimestamp) continue;
            if (timestamp > horizonTimestamp) continue;

            arrivals.push({
              timestamp,
              trip_id: String(schedule?.trip_id ?? "").trim(),
              original_trip_id: String(schedule?.original_trip_id || "").trim(),
              service_id: String(schedule?.service_id || "").trim(),
              service_date: serviceDate,
              start_time: String(schedule?.start_time || "").trim(),
              stop_sequence: Array.isArray(schedule?.stop_sequences)
                ? Number(schedule.stop_sequences[stopIndex])
                : null,
              direction_id: String(
                schedule?.direction_id || direction?.direction_id || ""
              ).trim(),
              delay: null,
              scheduled: true,
              source: "static"
            });
          }
        }

        arrivals.sort((a, b) => a.timestamp - b.timestamp);

        const unique = [];
        const seen = new Set();
        for (const time of arrivals) {
          const key = getStaticCourseKey(
            { route_id: routeId, direction_key: directionKey, destination: direction?.destination },
            time
          );
          if (!key || seen.has(key)) continue;
          seen.add(key);
          unique.push(time);
        }

        if (!unique.length) continue;

        result.push({
          route_id: routeId,
          direction_key: directionKey,
          direction,
          route_ref: meta.number || route.route_short_name || "—",
          destination: direction?.destination || direction?.headsign || "",
          times: unique.slice(0, 4),
          meta,
          scheduled: true,
          source: "static"
        });
      }
    }

    return result;
  }

  function getSurfaceScheduledArrivals(stop, skippedTrips = [], suppressedTrips = []) {
    const nowTimestamp = Date.now() / 1000;
    const horizonTimestamp = nowTimestamp + 2 * 60 * 60;
    const selectedStop = String(stop?.stop_id || stop?.stop_code || "").trim();
    if (!selectedStop) return [];

    const result = [];
    const serviceDates = getBoardServiceDates();

    for (const route of transportData?.routes || []) {
      if (String(route?.route_type) === "1") continue;

      const routeId = String(route?.route_id || "").trim();
      if (!routeId) continue;

      const directions = transportData?.directions?.[routeId] || {};
      const schedules = transportData?.schedules?.[routeId] || {};
      const meta = getLineMeta(routeId, route.route_short_name || "");

      for (const [directionKey, direction] of Object.entries(directions)) {
        const pattern = Array.isArray(direction?.pattern)
          ? direction.pattern.map(String)
          : [];
        const stopIndex = pattern.findIndex(id => stopIdsMatch(id, selectedStop));
        if (stopIndex < 0) continue;

        const rowsByTerminal = new Map();

        for (const serviceDate of serviceDates) {
          const schedulesForDate = collectStaticSchedulesForDirection(
            schedules?.[directionKey],
            serviceDate
          );

          for (const schedule of schedulesForDate) {
            const times = Array.isArray(schedule?.times) ? schedule.times : [];
            const terminalIndex = getStaticTerminalIndex(schedule, pattern);
            if (terminalIndex < stopIndex) continue;

            const rawTime = getStaticScheduleTimeValue(schedule, stopIndex);
            const seconds = parseGtfsTime(rawTime);
            if (seconds == null) continue;

            const terminalStopId = String(
              pattern[terminalIndex] || getDirectionTerminalStopId(direction) || ""
            ).trim();
            if (!terminalStopId || stopIdsMatch(terminalStopId, selectedStop)) continue;

            const timestamp = gtfsSecondsToServiceDateTimestamp(serviceDate, seconds);
            if (!Number.isFinite(timestamp)) continue;
            if (timestamp < nowTimestamp) continue;
            if (timestamp > horizonTimestamp) continue;

            if (isSkippedStaticSchedule(
              schedule,
              routeId,
              directionKey,
              selectedStop,
              stopIndex,
              skippedTrips
            )) continue;

            if (isSuppressedStaticSchedule(
              schedule,
              routeId,
              directionKey,
              serviceDate,
              suppressedTrips
            )) continue;

            const arrivalTimes = Array.isArray(schedule?.arrival_times)
              ? schedule.arrival_times
              : [];
            const departureTimes = Array.isArray(schedule?.departure_times)
              ? schedule.departure_times
              : [];
            const stopSequence = Array.isArray(schedule?.stop_sequences)
              ? Number(schedule.stop_sequences[stopIndex])
              : null;

            const time = {
              timestamp,
              trip_id: String(schedule?.trip_id ?? "").trim(),
              original_trip_id: String(schedule?.original_trip_id || "").trim(),
              service_id: String(schedule?.service_id || "").trim(),
              service_date: serviceDate,
              start_time: String(schedule?.start_time || "").trim(),
              direction_id: String(
                schedule?.direction_id || direction?.direction_id || ""
              ).trim(),
              stop_sequence: Number.isFinite(stopSequence) ? stopSequence : null,
              arrival_time: String(arrivalTimes[stopIndex] || "").trim(),
              departure_time: String(departureTimes[stopIndex] || "").trim(),
              course_times: Array.isArray(schedule?.times)
                ? schedule.times.map(value => String(value || "").trim())
                : [],
              course_arrival_times: arrivalTimes.map(value => String(value || "").trim()),
              course_departure_times: departureTimes.map(value => String(value || "").trim()),
              course_stop_sequences: Array.isArray(schedule?.stop_sequences)
                ? schedule.stop_sequences.map(value =>
                    value === null || value === undefined ? null : Number(value)
                  )
                : [],
              delay: null,
              scheduled: true,
              source: "static"
            };

            const list = rowsByTerminal.get(terminalStopId) || [];
            list.push(time);
            rowsByTerminal.set(terminalStopId, list);
          }
        }

        for (const [terminalStopId, times] of rowsByTerminal) {
          times.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

          const uniqueTimes = [];
          const seen = new Set();
          for (const time of times) {
            const key = getStaticCourseKey(
              { route_id: routeId, direction_key: directionKey, destination: direction?.destination },
              time
            );
            if (seen.has(key)) continue;
            seen.add(key);
            uniqueTimes.push(time);
          }

          if (!uniqueTimes.length) continue;

          const isPartialCourse = !stopIdsMatch(
            terminalStopId,
            getDirectionTerminalStopId(direction)
          );
          const terminalStop = getStopById(terminalStopId);
          const rowDestination = isPartialCourse
            ? (terminalStop?.stop_name || direction?.destination || direction?.headsign || "")
            : (direction?.destination || direction?.headsign || terminalStop?.stop_name || "");

          result.push({
            route_id: routeId,
            direction_key: directionKey,
            direction,
            direction_id: String(
              direction?.direction_id || ""
            ).trim(),
            terminal_stop_id: terminalStopId,
            route_ref: meta.number || route.route_short_name || "—",
            destination: rowDestination,
            times: uniqueTimes,
            meta,
            scheduled: true,
            source: "static"
          });
        }
      }
    }

    return result.sort((a, b) =>
      Number(a.times?.[0]?.timestamp) - Number(b.times?.[0]?.timestamp)
    );
  }

  function getPropagatedRealtimeDelay(activeTrip, staticTime) {
    const targetSequence = Number(staticTime?.stop_sequence);
    if (!Number.isFinite(targetSequence)) return null;

    let effectiveDelay = (
      activeTrip?.trip_delay !== null
      && activeTrip?.trip_delay !== undefined
      && String(activeTrip.trip_delay).trim() !== ""
      && Number.isFinite(Number(activeTrip.trip_delay))
    )
      ? Number(activeTrip.trip_delay)
      : null;

    let targetSkipped = false;

    for (const update of Array.isArray(activeTrip?.delay_updates)
      ? activeTrip.delay_updates
      : []) {
      const sequence = Number(update?.stop_sequence);
      if (!Number.isFinite(sequence) || sequence > targetSequence) continue;

      const relationship = Number(update?.schedule_relationship);
      targetSkipped = sequence === targetSequence
        && relationship === 1;

      if (relationship === 2) {
        // NO_DATA propagates and clears the inherited prediction.
        effectiveDelay = null;
        continue;
      }

      if (Number.isFinite(Number(update?.delay))) {
        effectiveDelay = Number(update.delay);
        continue;
      }

      const predictionTime = Number(update?.timestamp);
      if (!Number.isFinite(predictionTime)) continue;

      // A time-only StopTimeEvent establishes a new delay by comparing its
      // absolute prediction against the exact static time at that same stop.
      const courseSequences = Array.isArray(staticTime?.course_stop_sequences)
        ? staticTime.course_stop_sequences
        : [];
      const anchorIndex = courseSequences.findIndex(value =>
        Number(value) === sequence
      );
      if (anchorIndex < 0) continue;

      const anchorRaw =
        staticTime?.course_arrival_times?.[anchorIndex]
        || staticTime?.course_departure_times?.[anchorIndex]
        || staticTime?.course_times?.[anchorIndex]
        || "";
      const anchorSeconds = parseGtfsTime(anchorRaw);
      const serviceDate = normalizeGtfsDateKey(staticTime?.service_date);
      const anchorTimestamp = gtfsSecondsToServiceDateTimestamp(
        serviceDate,
        anchorSeconds
      );

      if (Number.isFinite(anchorTimestamp)) {
        effectiveDelay = predictionTime - anchorTimestamp;
      }
    }

    if (targetSkipped) return null;
    return Number.isFinite(effectiveDelay) ? effectiveDelay : null;
  }

  function buildSyntheticRealtimeRoutes(activeTrips, scheduledSurfaceRoutes, stop) {
    const result = [];

    for (const activeTrip of Array.isArray(activeTrips) ? activeTrips : []) {
      const relationship = Number(activeTrip?.schedule_relationship);
      if (relationship !== 0) continue;

      const tripId = String(activeTrip?.trip_id || "").trim();
      if (!tripId) continue;

      for (const staticRoute of scheduledSurfaceRoutes || []) {
        if (String(staticRoute?.route_id || "").trim() !== String(activeTrip?.route_id || "").trim()) continue;

        const routeDirectionId = String(
          staticRoute?.direction_id
          || staticRoute?.direction?.direction_id
          || ""
        ).trim();
        const activeDirectionId = String(activeTrip?.direction_id || "").trim();
        if (activeDirectionId && routeDirectionId && activeDirectionId !== routeDirectionId) continue;

        for (const staticTime of staticRoute.times || []) {
          const staticTripId = String(staticTime?.original_trip_id || "").trim();
          if (!staticTripId || staticTripId !== tripId) continue;

          const delay = getPropagatedRealtimeDelay(activeTrip, staticTime);
          if (!Number.isFinite(delay)) continue;

          const timestamp = Number(staticTime.timestamp) + delay;
          if (!Number.isFinite(timestamp)) continue;

          result.push({
            route_id: String(staticRoute.route_id || "").trim(),
            route_ref: String(staticRoute.route_ref || "").trim(),
            direction_key: String(staticRoute.direction_key || "").trim(),
            direction_id: routeDirectionId,
            destination_stop_id: String(staticRoute.terminal_stop_id || "").trim(),
            destination: String(staticRoute.destination || "").trim(),
            trip_id: tripId,
            source_trip_id: String(activeTrip?.source_trip_id || tripId).trim(),
            trip_instance_id: tripId,
            trip_start_date: String(activeTrip?.start_date || "").trim(),
            trip_start_time: String(activeTrip?.start_time || "").trim(),
            schedule_relationship: relationship,
            schedule_relationship_name: String(activeTrip?.schedule_relationship_name || "SCHEDULED"),
            source: "realtime",
            realtime: true,
            synthetic_from_static: true,
            times: [{
              timestamp,
              trip_id: tripId,
              trip_instance_id: tripId,
              trip_start_date: String(activeTrip?.start_date || "").trim(),
              trip_start_time: String(activeTrip?.start_time || "").trim(),
              delay,
              trip_delay: Number.isFinite(Number(activeTrip?.trip_delay))
                ? Number(activeTrip.trip_delay)
                : null,
              trip_schedule_relationship: relationship,
              stop_id: String(stop?.stop_id || "").trim(),
              stop_sequence: Number(staticTime?.stop_sequence),
              stop_schedule_relationship: 0,
              stop_schedule_relationship_name: "SCHEDULED",
              scheduled_time: null,
              scheduled: false,
              source: "realtime"
            }]
          });
        }
      }
    }

    return result;
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
      headers: {
        Accept: 'application/json'
      }
    }, 20000);

    if (!response.ok) {
      const message = data?.error || `Realtime API заявката върна ${response.status}.`;
      throw new Error(message);
    }
    const generatedAt = data?.generated_at || Date.now();
    const skippedTrips = Array.isArray(data?.skipped_trips) ? data.skipped_trips : [];
    const suppressedTrips = Array.isArray(data?.suppressed_trips) ? data.suppressed_trips : [];

    // Promote courses whose last known realtime arrival has already passed
    // before building static fallback rows. This closes the gap where the
    // realtime update disappears between two refreshes.
    promotePassedRealtimeCourseStates();

    const realtimeRoutes = Array.isArray(data?.routes)
      ? data.routes
          .filter(route => route && Array.isArray(route.times))
          .filter(route => {
            const staticTrip = findStaticTrip(route.trip_id);
            const routeId = route.route_id || staticTrip?.route_id || '';

            // NEW/REPLACEMENT trips may not exist in static GTFS. In that case
            // destination_stop_id is the strongest terminal signal we have.
            if (route.destination_stop_id && shouldHideTerminalArrival(
              routeId,
              route.destination_stop_id,
              staticTrip,
              route.destination || '',
              route.direction_id || route.directionId || ''
            )) return false;

            return !shouldHideTerminalArrival(
              routeId,
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
              source: 'realtime',
              realtime: true,
              schedule_relationship: Number(route?.schedule_relationship),
              schedule_relationship_name: String(route?.schedule_relationship_name || 'SCHEDULED'),
              route_id: route.route_id || staticTrip?.route_id || '',
              route_ref: route.route_ref || routeMeta.number || '—',
              direction_key: staticDirection?.key || '',
              destination_stop_id: route.destination_stop_id || '',
              destination: getStopById(route.destination_stop_id)?.stop_name
                || staticDirection?.destination
                || staticDirection?.headsign
                || route.destination
                || staticTrip?.trip_headsign
                || '',
              times: route.times
                .map(time => ({
                  timestamp: Number.isFinite(Number(time?.timestamp))
                    ? Number(time.timestamp)
                    : null,
                  trip_id: String(time?.trip_id || route.trip_id || '').trim(),
                  trip_instance_id: String(
                    time?.trip_instance_id
                    || route?.trip_instance_id
                    || time?.trip_id
                    || route?.trip_id
                    || ''
                  ).trim(),
                  trip_start_date: String(
                    time?.trip_start_date
                    || route?.trip_start_date
                    || route?.start_date
                    || ''
                  ).trim(),
                  trip_start_time: String(
                    time?.trip_start_time
                    || route?.trip_start_time
                    || route?.start_time
                    || ''
                  ).trim(),
                  delay: (
                    time?.delay !== null
                    && time?.delay !== undefined
                    && String(time?.delay).trim() !== ''
                    && Number.isFinite(Number(time?.delay))
                  )
                    ? Number(time.delay)
                    : (
                      route?.trip_delay !== null
                      && route?.trip_delay !== undefined
                      && Number.isFinite(Number(route.trip_delay))
                        ? Number(route.trip_delay)
                        : null
                    ),
                  trip_delay: (
                    time?.trip_delay !== null
                    && time?.trip_delay !== undefined
                    && Number.isFinite(Number(time?.trip_delay))
                  )
                    ? Number(time.trip_delay)
                    : (
                      route?.trip_delay !== null
                      && route?.trip_delay !== undefined
                      && Number.isFinite(Number(route.trip_delay))
                        ? Number(route.trip_delay)
                        : null
                    ),
                  trip_schedule_relationship: Number(
                    time?.trip_schedule_relationship
                    ?? route?.schedule_relationship
                  ),
                  stop_id: String(time?.stop_id || '').trim(),
                  stop_sequence: Number.isFinite(Number(time?.stop_sequence))
                    ? Number(time.stop_sequence)
                    : null,
                  scheduled: false,
                  source: 'realtime',
                  stop_schedule_relationship: Number(time?.stop_schedule_relationship),
                  stop_schedule_relationship_name: String(time?.stop_schedule_relationship_name || 'SCHEDULED'),
                  scheduled_time: (
                    time?.scheduled_time !== null
                    && time?.scheduled_time !== undefined
                    && String(time?.scheduled_time).trim() !== ''
                    && Number.isFinite(Number(time?.scheduled_time))
                  )
                    ? Number(time.scheduled_time)
                    : null
                }))
                .filter(time =>
                  Number.isFinite(Number(time.timestamp))
                  || Number.isFinite(Number(time.delay))
                )
            };
          })
          .filter(route => route.times.length)
      : [];

    // GTFS-RT may keep a passed stop update for a short period. Once that
    // concrete course is consumed, do not render the stale realtime row again.
    for (const route of realtimeRoutes) {
      route.times = route.times.filter(time =>
        !isRealtimeCourseConsumed(stop, route, time)
      );
    }

    const metroRoutes = getMetroScheduledArrivals(stop);
    const scheduledSurfaceRoutes = isMetroStop(stop)
      ? []
      : getSurfaceScheduledArrivals(stop, skippedTrips, suppressedTrips);

    const syntheticRealtimeRoutes = isMetroStop(stop)
      ? []
      : buildSyntheticRealtimeRoutes(
          data?.active_trips || [],
          scheduledSurfaceRoutes,
          stop
        );

    const explicitRealtimeTripIds = new Set(
      realtimeRoutes.flatMap(route =>
        (route.times || []).map(time =>
          String(
            time?.trip_instance_id
            || time?.trip_id
            || route?.trip_instance_id
            || route?.trip_id
            || ''
          ).trim()
        )
      ).filter(Boolean)
    );

    const realtimeRoutesWithSparsePredictions = [
      ...realtimeRoutes,
      ...syntheticRealtimeRoutes.filter(route =>
        !(route.times || []).some(time =>
          explicitRealtimeTripIds.has(
            String(
              time?.trip_instance_id
              || time?.trip_id
              || route?.trip_instance_id
              || route?.trip_id
              || ''
            ).trim()
          )
        )
      )
    ];

    const realtimeRoutesForSelectedStop = realtimeRoutesWithSparsePredictions
      .map(route => ({
        ...route,
        times: (route.times || []).filter(time => {
          if (time.stop_id) {
            return stopIdsMatch(time.stop_id, stop.stop_id);
          }

          const sequence = Number(time.stop_sequence);
          if (!Number.isFinite(sequence)) return false;

          return scheduledSurfaceRoutes.some(staticRoute =>
            String(staticRoute?.route_id || '').trim()
              === String(route?.route_id || '').trim()
            && staticRoute.times?.some(staticTime =>
              Number(staticTime?.stop_sequence) === sequence
            )
          );
        })
      }))
      .filter(route => route.times.length);

    const realtime = {
      status: data?.status || 'empty',
      generatedAt,
      routes: isMetroStop(stop) ? [] : realtimeRoutesForSelectedStop
    };

    const mergedRealtime = new Map();

    for (const route of realtime.routes) {
      const staticTrip = findStaticTrip(route.trip_id);
      const routeId = String(route.route_id || staticTrip?.route_id || '').trim();
      const staticDirection = getStaticDirectionForTrip(staticTrip)
        || resolveDirectionForRealtimeRoute(
          routeId,
          stop.stop_id,
          staticTrip,
          route.destination || '',
          route.direction_id || route.directionId || ''
        );

      const destination = getStopById(route.destination_stop_id)?.stop_name
        || staticDirection?.destination
        || staticDirection?.headsign
        || route.destination
        || staticTrip?.trip_headsign
        || '';

      const directionKey = String(
        staticDirection?.key
        || route.direction_key
        || normalizeDirectionText(destination)
        || ''
      ).trim();

      const key = [
        routeId,
        directionKey,
        String(route.route_ref || '')
      ].join('|');

      if (!mergedRealtime.has(key)) {
        mergedRealtime.set(key, {
          ...route,
          route_id: routeId,
          direction_key: directionKey,
          destination,
          source: 'realtime',
          realtime: true,
          times: []
        });
      }

      const target = mergedRealtime.get(key);
      target.times.push(
        ...(route.times || []).map(time => ({
          ...time,
          trip_id: String(time?.trip_id || route.trip_id || '').trim(),
          trip_instance_id: String(
            time?.trip_instance_id
            || route?.trip_instance_id
            || time?.trip_id
            || route?.trip_id
            || ''
          ).trim(),
          trip_start_date: String(
            time?.trip_start_date
            || route?.trip_start_date
            || route?.start_date
            || ''
          ).trim(),
          trip_start_time: String(
            time?.trip_start_time
            || route?.trip_start_time
            || route?.start_time
            || ''
          ).trim(),
          trip_schedule_relationship: Number(
            time?.trip_schedule_relationship
            ?? route?.schedule_relationship
          ),
          trip_delay: (
            time?.trip_delay !== null
            && time?.trip_delay !== undefined
            && Number.isFinite(Number(time.trip_delay))
          )
            ? Number(time.trip_delay)
            : (
              route?.trip_delay !== null
              && route?.trip_delay !== undefined
              && Number.isFinite(Number(route.trip_delay))
                ? Number(route.trip_delay)
                : null
            )
        }))
      );
    }

    const matchedStaticCourseKeys = new Set();

    const mergedSurfaceRoutes = [...mergedRealtime.values()]
      .map(route => {
        const routeId = String(route?.route_id || '').trim();
        const routeRef = String(route?.route_ref || '').trim();

        const allRouteStaticEntries = scheduledSurfaceRoutes
          .filter(staticRoute => {
            if (String(staticRoute?.route_id || '').trim() !== routeId) return false;
            const staticRef = String(staticRoute?.route_ref || '').trim();
            return !routeRef || !staticRef || staticRef === routeRef;
          })
          .flatMap(staticRoute =>
            (staticRoute.times || []).map(time => ({ staticRoute, time }))
          );

        let displayDirectionKey = String(route?.direction_key || '').trim();
        const matchedDirections = new Map();
        const combinedTimes = [];

        for (const realtimeTime of route.times || []) {
          const match = findRealtimeStaticMatch(
            route,
            realtimeTime,
            allRouteStaticEntries,
            matchedStaticCourseKeys
          );

          if (!match?.entry) {
            if (Number.isFinite(Number(realtimeTime?.timestamp))) {
              combinedTimes.push(realtimeTime);
            }
            continue;
          }

          const entry = match.entry;
          const staticTime = entry.time;
          const courseKey = getStaticCourseKey(entry.staticRoute, staticTime);
          if (!courseKey) continue;

          matchedStaticCourseKeys.add(courseKey);

          realtimeTime.matched_scheduled_timestamp = Number(staticTime.timestamp);
          realtimeTime.matched_static_course_key = courseKey;
          realtimeTime.match_strength = match.strength;

          if (!Number.isFinite(Number(realtimeTime.timestamp))) {
            const materialized = materializeRealtimeTimestamp(realtimeTime, staticTime);
            if (!Number.isFinite(materialized)) continue;
          }

          combinedTimes.push(realtimeTime);

          const matchedDirection = String(entry.staticRoute?.direction_key || '').trim();
          if (matchedDirection) {
            matchedDirections.set(
              matchedDirection,
              (matchedDirections.get(matchedDirection) || 0) + 1
            );
          }

          rememberRealtimeCourseAssignment(
            stop,
            route,
            realtimeTime,
            entry.staticRoute,
            staticTime,
            match.strength
          );
        }

        // Persist the exact static anchors before any static rows are appended
        // to this same realtime group. This makes the merge atomic: a course
        // cannot be rendered once as realtime and again as static in one fetch.
        rememberConsumedRealtimeArrivals(stop, [{
          ...route,
          times: route.times || []
        }]);

        if (matchedDirections.size) {
          displayDirectionKey = [...matchedDirections.entries()]
            .sort((left, right) => right[1] - left[1])[0][0];
        }

        const displayStaticRoutes = scheduledSurfaceRoutes.filter(staticRoute =>
          String(staticRoute?.route_id || '').trim() === routeId
          && (
            !displayDirectionKey
            || String(staticRoute?.direction_key || '').trim() === displayDirectionKey
          )
          && (
            !routeRef
            || !String(staticRoute?.route_ref || '').trim()
            || String(staticRoute?.route_ref || '').trim() === routeRef
          )
        );

        for (const staticRoute of displayStaticRoutes) {
          for (const staticTime of staticRoute.times || []) {
            const courseKey = getStaticCourseKey(staticRoute, staticTime);
            if (!courseKey || matchedStaticCourseKeys.has(courseKey)) continue;

            const staticDestination = String(
              staticRoute?.destination || route?.destination || ''
            ).trim();

            // A course consumed in an earlier snapshot or by the legacy exact
            // timestamp anchor must never be reintroduced into the realtime
            // group while the next arrival is still pending.
            if (
              isStaticCourseConsumed(stop.stop_id, staticRoute, staticTime)
              || isConsumedRealtimeScheduledArrival(
                stop.stop_id,
                routeId,
                staticDestination,
                staticTime.timestamp
              )
            ) {
              continue;
            }

            combinedTimes.push(staticTime);
          }
        }

        let displayRoute = route;
        const displayStaticRoute = displayStaticRoutes.find(staticRoute =>
          String(staticRoute?.direction_key || '').trim() === displayDirectionKey
        );

        if (displayStaticRoute && displayDirectionKey !== String(route?.direction_key || '').trim()) {
          displayRoute = {
            ...route,
            direction_key: displayDirectionKey,
            destination: displayStaticRoute.destination || route.destination,
            terminal_stop_id: displayStaticRoute.terminal_stop_id || route.terminal_stop_id,
            direction_id: displayStaticRoute.direction_id || route.direction_id
          };
        }

        return {
          ...displayRoute,
          times: combinedTimes
            .filter(time => Number.isFinite(Number(time?.timestamp)))
            .sort((left, right) => Number(left.timestamp) - Number(right.timestamp))
        };
      })
      .filter(route => route.times.length);


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

    // The realtime/static merge above persists course anchors before it
    // appends static rows. Static fallback below therefore sees one consistent
    // course state for the whole fetch.
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

    // Only operational realtime trips may suppress static fallback. Explicit
    // CANCELED/DELETED trips are not active service.
    const activeDirections = [];
    const seenActiveDirectionKeys = new Set();
    const activeTripRecords = Array.isArray(data?.active_trips)
      ? data.active_trips
      : (Array.isArray(data?.active_trip_ids)
        ? data.active_trip_ids.map(tripId => ({ trip_id: tripId, schedule_relationship_name: 'SCHEDULED' }))
        : []);

    for (const activeTrip of activeTripRecords) {
      const activeTripId = String(activeTrip?.trip_id || '').trim();
      if (!activeTripId) continue;

      const relationship = String(activeTrip?.schedule_relationship_name || 'SCHEDULED').toUpperCase();
      if (relationship === 'CANCELED' || relationship === 'DELETED') continue;

      const staticTrip = findStaticTrip(activeTripId);
      if (!staticTrip) continue;
      const activeDirection = getStaticDirectionForTrip(staticTrip);
      if (!activeDirection?.key) continue;

      const activeKey = `${String(staticTrip.route_id || '')}|${String(activeDirection.key)}`;
      if (seenActiveDirectionKeys.has(activeKey)) continue;
      seenActiveDirectionKeys.add(activeKey);
      activeDirections.push({
        route_id: String(staticTrip.route_id || ''),
        key: String(activeDirection.key),
        trip_id: activeTripId,
        schedule_relationship: relationship
      });
    }

    const surfaceFallbackRoutes = scheduledSurfaceRoutes
      .map(route => {
        if (realtimeLogicalRoutes.some(realtimeRoute =>
          realtimeOverridesScheduledDirection(realtimeRoute, route, stop.stop_id)
        )) {
          return null;
        }

        if (activeShortDirectionOverridesScheduledDirection(route, activeDirections)) {
          return null;
        }

        // A static course that was explicitly matched to a realtime arrival
        // must never be reintroduced by the later fallback path.
        const remainingTimes = (Array.isArray(route?.times) ? route.times : [])
          .filter(time => {
            const courseKey = getStaticCourseKey(route, time);

            // A matched realtime course remains consumed even after its
            // realtime update disappears from the feed. This prevents the
            // static timetable from resurrecting the same course while the
            // next scheduled course is still ahead.
            return (
              !matchedStaticCourseKeys.has(courseKey)
              && !isStaticCourseConsumed(stop.stop_id, route, time)
              && !isConsumedRealtimeScheduledArrival(
                stop.stop_id,
                route.route_id,
                route.destination,
                time.timestamp
              )
            );
          });

        if (!remainingTimes.length) return null;

        const routeWithRemainingTimes = {
          ...route,
          times: remainingTimes
        };

        // Passenger-facing merge for equivalent named terminals (e.g. 94 /
        // stop 1699 vs 1700).
        const routeId = String(route.route_id || '');
        const destinationKey = normalizeDirectionText(route.destination || '');
        const displayedKey = `${routeId}|${destinationKey}|${String(route.route_ref || '')}`;
        if (realtimeDirectionKeys.has(displayedKey)) return null;

        return routeWithRemainingTimes;
      })
      .filter(Boolean);

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
    const renderToken = ++boardRenderToken;
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
    let primaryArrivalExpired = null;

    panel.querySelectorAll("[data-arrival-timestamp]").forEach(element => {
      const timestamp = Number(element.dataset.arrivalTimestamp);
      if (!Number.isFinite(timestamp)) return;

      const countdown = formatArrivalCountdown(timestamp, nowSeconds);
      if (element.classList.contains("vb-arrival-minutes")) {
        element.textContent = countdown;
        if (timestamp <= nowSeconds) primaryArrivalExpired = timestamp;
        return;
      }

      element.dataset.tooltip = countdown;
      element.setAttribute("aria-label", countdown);
    });

    if (
      primaryArrivalExpired !== null
      && primaryArrivalExpired !== lastExpiredPrimaryArrival
      && !refreshInFlight
    ) {
      lastExpiredPrimaryArrival = primaryArrivalExpired;
      refreshSelectedBoard();
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

      const primaryArrival = boardPanel()?.querySelector(".vb-arrival-minutes")?.dataset.arrivalTimestamp;
      lastExpiredPrimaryArrival = Number.isFinite(Number(primaryArrival))
        ? Number(primaryArrival)
        : null;
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
