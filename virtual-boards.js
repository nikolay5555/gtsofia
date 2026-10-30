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

  // Static timetable indexes. They are built once after transport data loads,
  // so every board refresh only looks at directions that actually serve the
  // selected stop instead of scanning every route/direction in the dataset.
  let surfaceDirectionsByStop = new Map();
  let metroDirectionsByStop = new Map();
  let realtimeRouteIdsByStop = new Map();

  // Caches for calculations that are identical for the lifetime of the
  // currently loaded transport dataset.
  const serviceActiveCache = new Map();
  let serviceActiveCacheDateKey = "";

  const scheduleTimeSecondsCache = new WeakMap();
  const scheduleTerminalIndexCache = new WeakMap();

  // Show the next three departures, as in the reference virtual-board UI.
  const MAX_VISIBLE_BOARD_ARRIVALS = 3;

  const boardPanel = () =>
    document.getElementById("virtualBoardBody");

  const FAVORITE_STOPS_KEY =
    "gtsofia.favoriteStops";

  function getFavoriteStops() {
    try {
      const value = JSON.parse(
        localStorage.getItem(
          FAVORITE_STOPS_KEY
        ) || "[]"
      );

      return Array.isArray(value)
        ? value
        : [];
    } catch {
      return [];
    }
  }

  function isFavoriteStop(stopId) {
    return getFavoriteStops().some(
      item =>
        String(item.stop_id)
        === String(stopId)
    );
  }

  function setFavoriteStop(stop) {
    const favorites =
      getFavoriteStops();

    const index =
      favorites.findIndex(
        item =>
          String(item.stop_id)
          === String(stop.stop_id)
      );

    if (index >= 0) {
      favorites.splice(index, 1);
    } else {
      favorites.push({
        stop_id: String(stop.stop_id),
        stop_code: String(
          stop.stop_code
          || stop.stop_id
          || ""
        ),
        stop_name: String(
          stop.stop_name
          || stop.name
          || "Спирка"
        )
      });
    }

    localStorage.setItem(
      FAVORITE_STOPS_KEY,
      JSON.stringify(favorites)
    );

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
    const parts =
      new Intl.DateTimeFormat(
        "en-GB",
        {
          timeZone: SOFIA_TIME_ZONE,
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23"
        }
      ).formatToParts(new Date());

    const get = type =>
      parts.find(
        part => part.type === type
      )?.value || "";

    return {
      weekday: get("weekday"),
      hour: Number(get("hour")),
      minute: Number(get("minute")),
      second: Number(get("second"))
    };
  }

  function getCurrentScheduleDayType() {
    if (
      typeof getTransportCalendarDayType
      === "function"
    ) {
      return getTransportCalendarDayType();
    }

    const day =
      new Intl.DateTimeFormat(
        "en-US",
        {
          timeZone: SOFIA_TIME_ZONE,
          weekday: "short"
        }
      ).format(new Date());

    return day === "Sat"
      || day === "Sun"
      ? "weekend"
      : "weekday";
  }

  function getNowGtfsSeconds() {
    const parts =
      getSofiaParts();

    return (
      parts.hour * 3600
      + parts.minute * 60
      + parts.second
    );
  }

  function formatClockTime(
    totalSeconds
  ) {
    const seconds =
      Math.max(
        0,
        Number(totalSeconds) || 0
      );

    const hour =
      Math.floor(
        seconds / 3600
      ) % 24;

    const minute =
      Math.floor(
        (seconds % 3600) / 60
      );

    return (
      `${String(hour).padStart(2, "0")}:`
      + `${String(minute).padStart(2, "0")}`
    );
  }

  function parseGtfsTime(value) {
    if (!value) return null;

    const parts =
      String(value)
        .trim()
        .split(":");

    if (parts.length !== 3) {
      return null;
    }

    const hour =
      Number(parts[0]);

    const minute =
      Number(parts[1]);

    const second =
      Number(parts[2]);

    if (
      ![hour, minute, second]
        .every(Number.isFinite)
    ) {
      return null;
    }

    return (
      hour * 3600
      + minute * 60
      + second
    );
  }

  function getCachedScheduleTime(
    schedule,
    stopIndex
  ) {
    if (
      !schedule
      || typeof schedule !== "object"
    ) {
      return null;
    }

    let cache =
      scheduleTimeSecondsCache.get(
        schedule
      );

    if (!cache) {
      cache = new Map();

      scheduleTimeSecondsCache.set(
        schedule,
        cache
      );
    }

    if (cache.has(stopIndex)) {
      return cache.get(stopIndex);
    }

    const times =
      Array.isArray(schedule?.times)
        ? schedule.times
        : [];

    const value =
      parseGtfsTime(
        times[stopIndex] ?? null
      );

    cache.set(
      stopIndex,
      value
    );

    return value;
  }

  function getCachedScheduleTerminalIndex(
    schedule,
    patternLength
  ) {
    if (
      !schedule
      || typeof schedule !== "object"
    ) {
      return -1;
    }

    let cache =
      scheduleTerminalIndexCache.get(
        schedule
      );

    if (!cache) {
      cache = new Map();

      scheduleTerminalIndexCache.set(
        schedule,
        cache
      );
    }

    if (cache.has(patternLength)) {
      return cache.get(
        patternLength
      );
    }

    const times =
      Array.isArray(schedule?.times)
        ? schedule.times
        : [];

    let terminalIndex = -1;

    for (
      let i = Math.min(
        times.length,
        patternLength
      ) - 1;
      i >= 0;
      i--
    ) {
      if (
        getCachedScheduleTime(
          schedule,
          i
        ) != null
      ) {
        terminalIndex = i;
        break;
      }
    }

    cache.set(
      patternLength,
      terminalIndex
    );

    return terminalIndex;
  }

  function normalizeProxyStopCode(stop) {
    const rawCode = String(
      stop?.stop_code
      ?? stop?.stop_id
      ?? ""
    ).trim();

    if (!rawCode) {
      return {
        candidates: [],
        isMetro: false
      };
    }

    const rawId = String(
      stop?.stop_id ?? ""
    ).trim();

    const isMetro =
      /^M/i.test(rawCode)
      || /^M/i.test(rawId);

    const digits =
      rawCode.replace(/\D/g, "");

    const candidates = [];

    if (digits) {
      candidates.push(
        String(Number(digits))
      );

      candidates.push(
        digits
      );
    }

    candidates.push(
      rawCode
    );

    return {
      candidates: [
        ...new Set(
          candidates.filter(Boolean)
        )
      ],
      isMetro
    };
  }

  function getLineMeta(
    routeId,
    routeRef
  ) {
    const id =
      String(routeId ?? "").trim();

    const ref =
      String(routeRef ?? "").trim();

    if (
      id
      && routeMetaById.has(id)
    ) {
      return routeMetaById.get(id);
    }

    if (
      ref
      && routeMetaByNumber.has(ref)
    ) {
      return routeMetaByNumber.get(ref);
    }

    const route =
      id
        ? routeById.get(id)
        : null;

    const number =
      ref
      || route?.route_short_name
      || "—";

    if (!route) {
      return {
        id,
        number,
        type: "bus",
        subtype:
          /^N/i.test(number)
            ? "night"
            : "",
        icon: "",
        color: "#BE1E2D",
        textColor: "#FFFFFF"
      };
    }

    const type =
      typeof getLineType
      === "function"
        ? getLineType(route)
        : "bus";

    const subtype =
      typeof getLineSubtype
      === "function"
        ? getLineSubtype(
            route,
            type,
            number
          )
        : "";

    const icon =
      typeof getTransportIcon
      === "function"
        ? getTransportIcon(
            type,
            number,
            subtype
          )
        : "";

    const color =
      typeof getLineColor
      === "function"
        ? getLineColor(
            route,
            type
          )
        : "#BE1E2D";

    return {
      id: route.route_id,
      number,
      type,
      subtype,
      icon,
      color,
      textColor:
        route.route_text_color
          ? `#${route.route_text_color}`
          : "#FFFFFF"
    };
  }

  function linePillHtml(line) {
    const number =
      escapeHtml(
        line?.number || "—"
      );

    const typeClass =
      line?.type === "metro"
        ? " metro"
        : "";

    const color =
      escapeHtml(
        line?.color
        || "#BE1E2D"
      );

    const textColor =
      escapeHtml(
        line?.textColor
        || "#FFFFFF"
      );

    return (
      `<span class="schedule-line-pill${typeClass}"`
      + ` style="--line-color:${color};`
      + ` --line-text-color:${textColor};`
      + ` background-color:${color};`
      + ` color:${textColor};">`
      + `${number}</span>`
    );
  }

  function lineIdentityHtml(line) {
    const icon =
      line?.icon
        ? (
          `<span class="schedule-line-icon">`
          + `<img src="${escapeHtml(
              line.icon
            )}" alt="" aria-hidden="true">`
          + `</span>`
        )
        : "";

    return (
      `<span class="schedule-line-identity">`
      + `${icon}${linePillHtml(line)}`
      + `</span>`
    );
  }

  function destinationHtml(
    destination
  ) {
    return (
      `<span class="schedule-summary-arrow direction-arrow"`
      + ` aria-hidden="true">`
      + `<img src="Icons/destinationarrow.svg" alt="">`
      + `</span>`
      + `<strong class="schedule-summary-destination vb-destination">`
      + `${escapeHtml(destination || "—")}`
      + `</strong>`
    );
  }

  function parseGeneratedAt(value) {
    if (
      typeof value === "number"
      && Number.isFinite(value)
    ) {
      return value < 1e12
        ? value * 1000
        : value;
    }

    const parsed =
      Date.parse(
        String(value ?? "")
      );

    return Number.isFinite(parsed)
      ? parsed
      : Date.now();
  }

  function getArrivalMinutes(
    timestamp
  ) {
    const seconds =
      Number(timestamp);

    if (!Number.isFinite(seconds)) {
      return null;
    }

    return Math.max(
      0,
      (
        seconds
        - Date.now() / 1000
      ) / 60
    );
  }

  function formatArrivalCountdown(
    timestamp,
    nowSeconds = Date.now() / 1000
  ) {
    const seconds = Number(timestamp);

    if (!Number.isFinite(seconds)) return "";

    const remainingSeconds =
      seconds - nowSeconds;

    // Arrival has reached the stop.
    if (remainingSeconds <= 0) {
      return "0 мин.";
    }

    // Display whole minutes only, rounded to the nearest minute from the exact
    // remaining seconds (half a minute rounds up): 9:01 -> 9 мин., 9:30 ->
    // 10 мин. A remaining time below 30 seconds rounds to 0 мин.; the actual
    // countdown is recalculated from the timestamp on each refresh.
    const minutes = Math.round(remainingSeconds / 60);

    return `${minutes} мин.`;
  }

  function formatArrivalClock(
    timestamp
  ) {
    const seconds =
      Number(timestamp);

    if (!Number.isFinite(seconds)) {
      return "—";
    }

    return new Intl.DateTimeFormat(
      "bg-BG",
      {
        timeZone: SOFIA_TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }
    ).format(
      new Date(seconds * 1000)
    );
  }

  function countdownHtml(
    arrival,
    showLive
  ) {
    const timestamp =
      Number(arrival?.timestamp);

    const minutes =
      getArrivalMinutes(timestamp);

    if (!Number.isFinite(minutes)) {
      return "";
    }

    const clock =
      formatArrivalClock(
        timestamp
      );

    const live =
      showLive
        ? '<span class="vb-arrival-live" aria-hidden="true"></span>'
        : "";

    const countdown =
      formatArrivalCountdown(
        timestamp
      );

    return (
      `<div class="vb-arrival-main">`
      + `${live}`
      + `<span class="vb-arrival-clock">`
      + `${escapeHtml(clock)}`
      + `</span>`
      + `<span class="vb-arrival-separator" aria-hidden="true">·</span>`
      + `<span class="vb-arrival-minutes"`
      + ` data-arrival-timestamp="${timestamp}">`
      + `${escapeHtml(countdown)}`
      + `</span>`
      + `</div>`
    );
  }

  function normalizeStopKey(value) {
    const raw =
      String(value ?? "").trim();

    if (!raw) return "";

    const withoutMetroPrefix =
      raw.replace(/^M/i, "");

    const numeric =
      withoutMetroPrefix.replace(
        /^0+(?=\d)/,
        ""
      );

    return numeric || "0";
  }

  function stopIdsMatch(
    left,
    right
  ) {
    const leftRaw =
      String(left ?? "").trim();

    const rightRaw =
      String(right ?? "").trim();

    if (
      !leftRaw
      || !rightRaw
    ) {
      return false;
    }

    const leftMetro =
      /^M/i.test(leftRaw);

    const rightMetro =
      /^M/i.test(rightRaw);

    if (
      leftMetro !== rightMetro
    ) {
      return false;
    }

    if (
      leftMetro
      && rightMetro
    ) {
      return (
        leftRaw.toUpperCase()
        === rightRaw.toUpperCase()
      );
    }

    return (
      normalizeStopKey(leftRaw)
      === normalizeStopKey(rightRaw)
    );
  }

  function isMetroStop(stop) {
    return (
      /^M/i.test(
        String(
          stop?.stop_id || ""
        ).trim()
      )
      || /^M/i.test(
        String(
          stop?.stop_code || ""
        ).trim()
      )
    );
  }

  function getSofiaDateParts(
    date = new Date()
  ) {
    const parts =
      new Intl.DateTimeFormat(
        "en-CA",
        {
          timeZone: SOFIA_TIME_ZONE,
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        }
      ).formatToParts(date);

    const get = type =>
      parts.find(
        part =>
          part.type === type
      )?.value || "";

    return {
      year: Number(
        get("year")
      ),
      month: Number(
        get("month")
      ),
      day: Number(
        get("day")
      )
    };
  }

  function getSofiaDateKey(
    date = new Date()
  ) {
    const parts =
      getSofiaDateParts(date);

    if (
      ![
        parts.year,
        parts.month,
        parts.day
      ].every(
        Number.isFinite
      )
    ) {
      return "";
    }

    return (
      `${String(parts.year).padStart(4, "0")}-`
      + `${String(parts.month).padStart(2, "0")}-`
      + `${String(parts.day).padStart(2, "0")}`
    );
  }

  function getSofiaWeekdayField(
    date = new Date()
  ) {
    return new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: SOFIA_TIME_ZONE,
        weekday: "long"
      }
    ).format(date).toLowerCase();
  }

  function resetServiceActiveCacheIfNeeded() {
    const dateKey =
      getSofiaDateKey();

    if (!dateKey) return;

    if (
      serviceActiveCacheDateKey
      !== dateKey
    ) {
      serviceActiveCache.clear();
      serviceActiveCacheDateKey =
        dateKey;
    }
  }

  function isServiceActiveOnDate(
    serviceId,
    date = new Date()
  ) {
    const id =
      String(serviceId ?? "").trim();

    if (!id) return true;

    const calendar =
      transportData?.calendar
      || {};

    const dateKey =
      getSofiaDateKey(date);

    if (!dateKey) return false;

    const byDate =
      calendar?.serviceIdsByDate;

    if (
      byDate
      && typeof byDate === "object"
    ) {
      const serviceIds = byDate[dateKey];
      return (
        Array.isArray(serviceIds)
        && serviceIds.some(
          value =>
            String(value).trim()
            === id
        )
      );
    }

    let active = false;

    const weekdayField =
      getSofiaWeekdayField(
        date
      );

    const pattern =
      (calendar?.servicePatterns || [])
        .find(
          row =>
            String(
              row?.service_id || ""
            ).trim() === id
        );

    if (pattern) {
      const start =
        String(
          pattern.start_date || ""
        ).trim();

      const end =
        String(
          pattern.end_date || ""
        ).trim();

      const compactDate =
        dateKey.replaceAll(
          "-",
          ""
        );

      active =
        compactDate >= start
        && compactDate <= end
        && String(
          pattern?.[weekdayField]
          || ""
        ) === "1";
    }

    for (
      const exception
      of (calendar?.exceptions || [])
    ) {
      if (
        String(
          exception?.service_id || ""
        ).trim() !== id
      ) {
        continue;
      }

      const exceptionDate =
        String(
          exception?.date || ""
        ).trim();

      if (
        exceptionDate
        !== dateKey.replaceAll(
          "-",
          ""
        )
      ) {
        continue;
      }

      const type =
        String(
          exception?.exception_type || ""
        ).trim();

      if (type === "1") {
        active = true;
      }

      if (type === "2") {
        active = false;
      }
    }

    return active;
  }

  function isScheduleRowActiveToday(
    schedule
  ) {
    resetServiceActiveCacheIfNeeded();

    const serviceId =
      String(
        schedule?.service_id
        || findStaticTrip(
          schedule?.original_trip_id
        )?.service_id
        || ""
      ).trim();

    const dateKey =
      getSofiaDateKey();

    if (
      !serviceId
      || !dateKey
    ) {
      return true;
    }

    const cacheKey =
      `${dateKey}|${serviceId}`;

    if (
      serviceActiveCache.has(
        cacheKey
      )
    ) {
      return serviceActiveCache.get(
        cacheKey
      );
    }

    const active =
      isServiceActiveOnDate(
        serviceId
      );

    serviceActiveCache.set(
      cacheKey,
      active
    );

    return active;
  }

  function getSofiaOffsetMs(
    date = new Date()
  ) {
    const parts =
      new Intl.DateTimeFormat(
        "en-US",
        {
          timeZone: SOFIA_TIME_ZONE,
          timeZoneName: "shortOffset",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23"
        }
      ).formatToParts(date);

    const raw =
      parts.find(
        part =>
          part.type === "timeZoneName"
      )?.value || "GMT+0";

    const match =
      raw.match(
        /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/
      );

    if (!match) return 0;

    const sign =
      match[1] === "+"
        ? 1
        : -1;

    return (
      sign * (
        Number(match[2]) * 60
        + Number(match[3] || 0)
      ) * 60 * 1000
    );
  }

  function gtfsSecondsToTodayTimestamp(
    seconds
  ) {
    const date =
      getSofiaDateParts();

    const baseUtc =
      Date.UTC(
        date.year,
        date.month - 1,
        date.day
      );

    const candidate =
      baseUtc
      + Number(seconds) * 1000
      - getSofiaOffsetMs(
        new Date(baseUtc)
      );

    return candidate / 1000;
  }

  function findStaticTrip(
    tripId
  ) {
    return tripById.get(
      String(tripId)
    ) || null;
  }

  function normalizeDirectionText(
    value
  ) {
    return String(value ?? "")
      .trim()
      .toLocaleLowerCase("bg-BG")
      .replace(/\s+/g, " ")
      .replace(/[–—]/g, "-")
      .replace(/[.]/g, "")
      .trim();
  }

  function getStaticDirectionForTrip(
    staticTrip
  ) {
    if (!staticTrip?.route_id) {
      return null;
    }

    const routeId =
      String(
        staticTrip.route_id
      );

    const directions =
      transportData?.directions?.[
        routeId
      ] || {};

    const tripId =
      String(
        staticTrip.trip_id
        || ""
      ).trim();

    if (!tripId) return null;

    for (
      const [key, direction]
      of Object.entries(
        directions
      )
    ) {
      const tripIds =
        Array.isArray(
          direction?.trip_ids
        )
          ? direction.trip_ids.map(
              String
            )
          : [];

      if (
        tripIds.includes(
          tripId
        )
      ) {
        return {
          key,
          ...direction
        };
      }
    }

    for (
      const [key, direction]
      of Object.entries(
        directions
      )
    ) {
      if (
        String(
          direction?.trip_id || ""
        ).trim() === tripId
      ) {
        return {
          key,
          ...direction
        };
      }
    }

    const shapeId =
      String(
        staticTrip.shape_id || ""
      ).trim();

    if (shapeId) {
      const shapeMatches =
        Object.entries(
          directions
        ).filter(
          ([, direction]) =>
            String(
              direction?.shape_id
              || ""
            ).trim()
            === shapeId
        );

      if (
        shapeMatches.length === 1
      ) {
        const [
          key,
          direction
        ] = shapeMatches[0];

        return {
          key,
          ...direction
        };
      }
    }

    const headsign =
      normalizeDirectionText(
        staticTrip.trip_headsign
      );

    if (headsign) {
      for (
        const [key, direction]
        of Object.entries(
          directions
        )
      ) {
        const directionHeadsign =
          normalizeDirectionText(
            direction?.headsign
            || direction?.destination
          );

        if (
          directionHeadsign
          && directionHeadsign
            === headsign
        ) {
          return {
            key,
            ...direction
          };
        }
      }
    }

    return null;
  }

  // Resolve a realtime trip against its exact GTFS timetable row. A route's
  // representative direction may describe the full line even when this
  // particular trip is short-turning (e.g. TB1-TB58 ends at stop 0372).
  function getStaticScheduleInfoForTrip(
    routeId,
    tripId
  ) {
    const wantedRouteId = String(
      routeId ?? ""
    ).trim();
    const wantedTripId = String(
      tripId ?? ""
    ).trim();

    if (!wantedRouteId || !wantedTripId) {
      return null;
    }

    const schedulesByDirection =
      transportData?.schedules?.[wantedRouteId] || {};
    const directionsByKey =
      transportData?.directions?.[wantedRouteId] || {};
    const todayType = getCurrentScheduleDayType();
    const otherType = todayType === "weekday"
      ? "weekend"
      : "weekday";

    // Prefer today's schedule bucket, but allow the other bucket as a fallback
    // for data sets where the same original trip is serialized in both.
    for (const dayType of [todayType, otherType]) {
      for (const [directionKey, scheduleGroups] of Object.entries(
        schedulesByDirection
      )) {
        const rows = Array.isArray(scheduleGroups?.[dayType])
          ? scheduleGroups[dayType]
          : [];

        const schedule = rows.find(row =>
          String(row?.original_trip_id ?? "").trim() === wantedTripId
        );

        if (!schedule) continue;

        const sourceDirection = directionsByKey?.[directionKey];
        const pattern = Array.isArray(sourceDirection?.pattern)
          ? sourceDirection.pattern.map(String)
          : [];

        if (!pattern.length) continue;

        const terminalIndex = getCachedScheduleTerminalIndex(
          schedule,
          pattern.length
        );
        const terminalStopId = String(
          pattern[terminalIndex] ?? ""
        ).trim();

        if (terminalIndex < 0 || !terminalStopId) continue;

        return {
          directionKey,
          direction: {
            key: directionKey,
            ...sourceDirection
          },
          schedule,
          terminalIndex,
          terminalStopId
        };
      }
    }

    return null;
  }

  function getScheduledTripTerminalStopId(
    routeId,
    staticTripOrId
  ) {
    const tripId = typeof staticTripOrId === "object"
      ? String(staticTripOrId?.trip_id ?? "").trim()
      : String(staticTripOrId ?? "").trim();

    if (!tripId) return "";

    return getStaticScheduleInfoForTrip(
      routeId,
      tripId
    )?.terminalStopId || "";
  }

  function getRealtimeTripDestinationStopId(
    realtimeRoute,
    staticScheduleInfo
  ) {
    const reportedDestination = String(
      realtimeRoute?.destination_stop_id ?? ""
    ).trim();

    const relationshipName = String(
      realtimeRoute?.schedule_relationship_name ?? ""
    ).trim().toUpperCase();
    const relationshipValue = realtimeRoute?.schedule_relationship;
    const relationshipNumber = Number(relationshipValue);
    const hasRelationshipValue = relationshipValue !== null
      && relationshipValue !== undefined
      && String(relationshipValue).trim() !== "";
    const isScheduled = relationshipName
      ? relationshipName === "SCHEDULED"
      : (!hasRelationshipValue || relationshipNumber === 0);

    // For SCHEDULED trips, GTFS-RT's final StopTimeUpdate is not a reliable
    // destination. The exact static trip row is authoritative when available.
    if (isScheduled && staticScheduleInfo?.terminalStopId) {
      return String(staticScheduleInfo.terminalStopId).trim();
    }

    return reportedDestination
      || String(staticScheduleInfo?.terminalStopId ?? "").trim()
      || "";
  }

  function resolveRealtimeRouteDestinationDetails(
    realtimeRoute,
    staticTrip,
    routeId,
    stopId
  ) {
    const resolvedRouteId = String(
      routeId
      || realtimeRoute?.route_id
      || staticTrip?.route_id
      || ""
    ).trim();
    const tripId = String(
      realtimeRoute?.trip_id
      || staticTrip?.trip_id
      || ""
    ).trim();

    const staticScheduleInfo = getStaticScheduleInfoForTrip(
      resolvedRouteId,
      tripId
    );
    const staticDirection = staticScheduleInfo?.direction
      || getStaticDirectionForTrip(staticTrip)
      || resolveDirectionForRealtimeRoute(
        resolvedRouteId,
        stopId,
        staticTrip,
        realtimeRoute?.destination || "",
        realtimeRoute?.direction_id || realtimeRoute?.directionId || ""
      );
    const destinationStopId = getRealtimeTripDestinationStopId(
      realtimeRoute,
      staticScheduleInfo
    );
    const displayStopId = destinationStopId
      || getDirectionTerminalStopId(staticDirection);
    const destination = getDestinationDisplayName(
      displayStopId,
      staticDirection,
      realtimeRoute?.destination
      || staticTrip?.trip_headsign
      || staticDirection?.destination
      || staticDirection?.headsign
      || ""
    );

    return {
      staticScheduleInfo,
      staticDirection,
      destinationStopId,
      destination
    };
  }

  function normalizeStopName(
    value
  ) {
    return String(value ?? "")
      .trim()
      .toLocaleLowerCase("bg-BG")
      .replace(
        /["„“”'’]/g,
        ""
      )
      .replace(
        /[–—-]/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();
  }

  function getStopById(
    stopId
  ) {
    const wanted =
      String(stopId ?? "").trim();

    if (!wanted) return null;

    return (
      transportData?.stops || []
    ).find(
      stop =>
        stopIdsMatch(
          stop?.stop_id,
          wanted
        )
        || stopIdsMatch(
          stop?.stop_code,
          wanted
        )
    ) || null;
  }

  function getDestinationDisplayName(
    stopId,
    direction,
    fallback = ""
  ) {
    const wantedStopId =
      String(
        stopId ?? ""
      ).trim()
      || getDirectionTerminalStopId(
        direction
      );

    const stop =
      getStopById(
        wantedStopId
      );

    const directionStops =
      Array.isArray(
        direction?.stops
      )
        ? direction.stops
        : [];

    const directionStop =
      wantedStopId
        ? directionStops.find(
            item =>
              stopIdsMatch(
                item?.stop_id,
                wantedStopId
              )
          )
        : directionStops[
            directionStops.length - 1
          ];

    // Prefer OSM explicitly, even if the cached direction/headsign metadata
    // still contains a GTFS name. Direction stop records are a second source
    // for the same OSM label when the top-level stop lookup is unavailable.
    const osmName =
      String(
        stop?.osm_stop_name
        || directionStop?.osm_name
        || (
          stop?.stop_name_source === "osm"
            ? stop?.stop_name
            : ""
        )
        || ""
      ).trim();

    if (osmName) {
      return osmName;
    }

    // Preserve GTFS as the fallback only when the destination has no OSM name.
    return String(
      direction?.destination
      || direction?.headsign
      || stop?.stop_name
      || fallback
      || ""
    ).trim();
  }

  function getLimitedUniqueArrivalTimes(
    times,
    maxCount = MAX_VISIBLE_BOARD_ARRIVALS
  ) {
    const seenTimestamps = new Set();
    const limit = Math.max(
      0,
      Math.floor(Number(maxCount) || 0)
    );

    return (Array.isArray(times) ? times : [])
      .filter(time =>
        time?.timestamp !== null
        && time?.timestamp !== undefined
        && Number.isFinite(
          Number(time.timestamp)
        )
      )
      .sort((a, b) =>
        Number(a.timestamp)
        - Number(b.timestamp)
      )
      .filter(time => {
        const timestamp =
          Number(time.timestamp);

        if (seenTimestamps.has(timestamp)) {
          return false;
        }

        seenTimestamps.add(timestamp);
        return true;
      })
      .slice(0, limit);
  }


  // Merge realtime and timetable courses into one displayed line/destination
  // row before limiting it to the next three departures.
  // This lets non-duplicated scheduled courses fill slots when realtime only
  // provides one or two predicted arrivals for the same direction.
  function mergeBoardRoutesByDestination(
    routes,
    maxCount = MAX_VISIBLE_BOARD_ARRIVALS
  ) {
    const grouped = new Map();

    for (const route of Array.isArray(routes) ? routes : []) {
      const routeId = String(route?.route_id || '').trim();
      const destinationKey = normalizeDirectionText(
        route?.destination || route?.headsign || ''
      );
      // route_ref is display metadata and may be missing on one source. The
      // stable grouping identity is the GTFS route ID plus the OSM-first
      // destination, not the label copied from either feed.
      const key = `${routeId}|${destinationKey}`;
      const routeTimes = Array.isArray(route?.times) ? route.times : [];

      if (!grouped.has(key)) {
        grouped.set(key, {
          ...route,
          times: [...routeTimes]
        });
        continue;
      }

      const existing = grouped.get(key);
      existing.times.push(...routeTimes);

      const existingRef = String(existing?.route_ref || '').trim();
      const incomingRef = String(route?.route_ref || '').trim();
      if (
        (!existingRef || existingRef === '—')
        && incomingRef
        && incomingRef !== '—'
      ) {
        existing.route_ref = incomingRef;
      }
      if (!existing.meta && route?.meta) {
        existing.meta = route.meta;
      }

      // Keep realtime metadata on the row when both sources share its key;
      // individual arrival entries still retain their own scheduled flag.
      if (route?.realtime && !existing?.realtime) {
        const displayRef =
          existingRef && existingRef !== '—'
            ? existingRef
            : incomingRef;
        grouped.set(key, {
          ...route,
          route_ref: displayRef || route.route_ref,
          meta: route.meta || existing.meta,
          times: existing.times
        });
      }
    }

    return [...grouped.values()]
      .map(route => ({
        ...route,
        times: getLimitedUniqueArrivalTimes(route.times, maxCount)
      }))
      .filter(route => route.times.length)
      .sort((a, b) =>
        Number(a.times?.[0]?.timestamp)
        - Number(b.times?.[0]?.timestamp)
      );
  }

  function getStopDistanceMeters(
    left,
    right
  ) {
    const lat1 =
      Number(left?.stop_lat);

    const lon1 =
      Number(left?.stop_lon);

    const lat2 =
      Number(right?.stop_lat);

    const lon2 =
      Number(right?.stop_lon);

    if (
      ![
        lat1,
        lon1,
        lat2,
        lon2
      ].every(
        Number.isFinite
      )
    ) {
      return Infinity;
    }

    const toRad =
      value =>
        value * Math.PI / 180;

    const dLat =
      toRad(lat2 - lat1);

    const dLon =
      toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) ** 2
      + Math.cos(
          toRad(lat1)
        )
        * Math.cos(
          toRad(lat2)
        )
        * Math.sin(
          dLon / 2
        ) ** 2;

    return (
      6371000
      * 2
      * Math.atan2(
        Math.sqrt(a),
        Math.sqrt(1 - a)
      )
    );
  }

  function isTerminalDirectionForStop(
    routeId,
    stopId,
    direction
  ) {
    const pattern =
      Array.isArray(
        direction?.pattern
      )
        ? direction.pattern.map(
            String
          )
        : [];

    if (pattern.length < 2) {
      return false;
    }

    const selected =
      String(
        stopId ?? ""
      ).trim();

    if (!selected) {
      return false;
    }

    const terminalId =
      pattern[
        pattern.length - 1
      ];

    if (
      stopIdsMatch(
        terminalId,
        selected
      )
    ) {
      return true;
    }

    const selectedStop =
      getStopById(
        selected
      );

    const terminalStop =
      getStopById(
        terminalId
      );

    if (
      !selectedStop
      || !terminalStop
    ) {
      return false;
    }

    const selectedName =
      normalizeStopName(
        selectedStop.stop_name
      );

    const terminalName =
      normalizeStopName(
        terminalStop.stop_name
      );

    if (
      !selectedName
      || selectedName
        !== terminalName
    ) {
      return false;
    }

    return (
      getStopDistanceMeters(
        selectedStop,
        terminalStop
      ) <= 300
    );
  }

  function getDirectionsForRouteAtStop(
    routeId,
    stopId
  ) {
    const directionSet =
      transportData
        ?.directions?.[
          String(routeId)
        ] || {};

    return Object.entries(
      directionSet
    )
      .filter(
        ([, direction]) => {
          const pattern =
            Array.isArray(
              direction?.pattern
            )
              ? direction.pattern
              : [];

          return pattern.some(
            id =>
              stopIdsMatch(
                id,
                stopId
              )
          );
        }
      )
      .map(
        ([key, direction]) => ({
          key,
          ...direction
        })
      );
  }

  function getDirectionTerminalStopId(
    direction
  ) {
    const pattern =
      Array.isArray(
        direction?.pattern
      )
        ? direction.pattern.map(
            String
          )
        : [];

    return pattern.length
      ? String(
          pattern[
            pattern.length - 1
          ]
        ).trim()
      : "";
  }

  function getDirectionIdentity(
    direction,
    fallback = ""
  ) {
    const terminalStopId =
      getDirectionTerminalStopId(
        direction
      );

    return (
      terminalStopId
      || String(
        direction?.key
        || fallback
        || ""
      ).trim()
    );
  }

  function resolveDirectionForRealtimeRoute(
    routeId,
    stopId,
    staticTrip,
    destination = "",
    directionId = ""
  ) {
    const staticDirection =
      getStaticDirectionForTrip(
        staticTrip
      );

    if (staticDirection) {
      return staticDirection;
    }

    const directions =
      getDirectionsForRouteAtStop(
        routeId,
        stopId
      );

    if (!directions.length) {
      return null;
    }

    const wantedDestination =
      normalizeDirectionText(
        destination
      );

    if (wantedDestination) {
      const byDestination =
        directions.find(
          direction =>
            normalizeDirectionText(
              direction?.headsign
              || direction?.destination
            ) === wantedDestination
        );

      if (byDestination) {
        return byDestination;
      }
    }

    const wantedDirectionId =
      String(
        directionId ?? ""
      ).trim();

    if (wantedDirectionId) {
      const byKey =
        directions.find(
          direction =>
            String(
              direction?.direction_id
              ?? direction?.key
              ?? ""
            ).trim()
            === wantedDirectionId
        );

      if (byKey) {
        return byKey;
      }
    }

    return directions.length === 1
      ? directions[0]
      : null;
  }

  function shouldHideTerminalArrival(
    routeId,
    stopId,
    staticTrip,
    destination = "",
    directionId = ""
  ) {
    const selectedStopId = String(
      stopId ?? ""
    ).trim();

    if (!selectedStopId) return false;

    // When the Trip ID maps to a GTFS schedule row, that row is the authority.
    // A last realtime StopTimeUpdate is not necessarily the end of the trip.
    const exactTripTerminal = getScheduledTripTerminalStopId(
      routeId,
      staticTrip
    );

    if (exactTripTerminal) {
      return stopIdsMatch(
        exactTripTerminal,
        selectedStopId
      );
    }

    // If the trip is unknown to the static feed, use an unambiguous direction
    // identifier. Do not compare stop and destination names: realtime may only
    // report an intermediate stop as its last StopTimeUpdate.
    const direction = resolveDirectionForRealtimeRoute(
      routeId,
      selectedStopId,
      staticTrip,
      "",
      directionId
    );

    return !!direction?.pattern?.length
      && isTerminalDirectionForStop(
        routeId,
        selectedStopId,
        direction
      );
  }

  /**
   * Build a compact index of static directions by stop.
   *
   * This is deliberately an index of directions, not individual schedule
   * rows. Storing every stop-time occurrence would consume considerably more
   * memory. We only need to avoid scanning every route/direction on refresh.
   */
  function buildStaticScheduleIndexes() {
    surfaceDirectionsByStop =
      new Map();

    metroDirectionsByStop =
      new Map();

    realtimeRouteIdsByStop =
      new Map();

    const addEntry = (
      index,
      stopKey,
      entry
    ) => {
      if (!stopKey) return;

      if (!index.has(stopKey)) {
        index.set(
          stopKey,
          []
        );
      }

      index.get(stopKey).push(
        entry
      );
    };

    for (
      const route
      of (transportData?.routes || [])
    ) {
      const routeId =
        String(
          route?.route_id || ""
        ).trim();

      if (!routeId) continue;

      const isMetro =
        String(
          route?.route_type
        ) === "1";

      const directionSet =
        transportData
          ?.directions?.[
            routeId
          ] || {};

      const scheduleSet =
        transportData
          ?.schedules?.[
            routeId
          ] || {};

      const meta =
        getLineMeta(
          routeId,
          route.route_short_name
            || ""
        );

      for (
        const [
          directionKey,
          direction
        ]
        of Object.entries(
          directionSet
        )
      ) {
        const pattern =
          Array.isArray(
            direction?.pattern
          )
            ? direction.pattern.map(
                String
              )
            : [];

        if (!pattern.length) {
          continue;
        }

        const directionEntries =
          new Map();

        for (
          let stopIndex = 0;
          stopIndex < pattern.length;
          stopIndex++
        ) {
          const stopKey =
            normalizeStopKey(
              pattern[stopIndex]
            );

          if (!stopKey) continue;

          if (
            directionEntries.has(
              stopKey
            )
          ) {
            continue;
          }

          const entry = {
            routeId,
            route,
            directionKey,
            direction,
            stopIndex,
            meta,
            scheduleSet
          };

          directionEntries.set(
            stopKey,
            entry
          );

          if (isMetro) {
            addEntry(
              metroDirectionsByStop,
              stopKey,
              entry
            );
          } else {
            addEntry(
              surfaceDirectionsByStop,
              stopKey,
              entry
            );
          }

          if (
            !realtimeRouteIdsByStop.has(
              stopKey
            )
          ) {
            realtimeRouteIdsByStop.set(
              stopKey,
              new Set()
            );
          }

          realtimeRouteIdsByStop
            .get(stopKey)
            .add(routeId);
        }
      }
    }
  }

  function getRealtimeRouteIdsForStop(
    stop
  ) {
    const selectedStopId =
      String(
        stop?.stop_id
        || stop?.stop_code
        || ""
      ).trim();

    if (!selectedStopId) {
      return [];
    }

    const key =
      normalizeStopKey(
        selectedStopId
      );

    const routeIds =
      realtimeRouteIdsByStop.get(
        key
      );

    return routeIds
      ? [...routeIds]
      : [];
  }

  function getMetroScheduledArrivals(
    stop
  ) {
    const selectedStop =
      String(
        stop?.stop_id
        || stop?.stop_code
        || ""
      ).trim();

    if (!selectedStop) {
      return [];
    }

    const stopKey =
      normalizeStopKey(
        selectedStop
      );

    const entries =
      metroDirectionsByStop.get(
        stopKey
      ) || [];

    if (!entries.length) {
      return [];
    }

    const nowTimestamp =
      Date.now() / 1000;

    const dayType =
      getCurrentScheduleDayType();

    /*
     * Metro courses may have different terminal stops while belonging
     * to the same static direction. Therefore the grouping key must include
     * the concrete terminal derived from THIS schedule row.
     */
    const byTerminal =
      new Map();

    for (
      const entry
      of entries
    ) {
      const {
        routeId,
        route,
        directionKey,
        direction,
        stopIndex,
        meta,
        scheduleSet
      } = entry;

      const pattern =
        Array.isArray(
          direction?.pattern
        )
          ? direction.pattern.map(
              String
            )
          : [];

      if (!pattern.length) {
        continue;
      }

      /*
       * A direction whose static pattern already ends at the selected stop
       * represents an arrival, not a departure from that stop.
       */
      if (
        isTerminalDirectionForStop(
          routeId,
          selectedStop,
          direction
        )
      ) {
        continue;
      }

      const daySchedules =
        scheduleSet?.[
          directionKey
        ]?.[dayType];

      if (
        !Array.isArray(
          daySchedules
        )
      ) {
        continue;
      }

      for (
        const schedule
        of daySchedules
      ) {
        if (
          !isScheduleRowActiveToday(
            schedule
          )
        ) {
          continue;
        }

        const seconds =
          getCachedScheduleTime(
            schedule,
            stopIndex
          );

        if (seconds == null) {
          continue;
        }

        /*
         * The terminal is determined from the concrete schedule row,
         * not from direction.pattern's last stop.
         */
        const terminalIndex =
          getCachedScheduleTerminalIndex(
            schedule,
            pattern.length
          );

        if (
          terminalIndex < 0
          || terminalIndex < stopIndex
        ) {
          continue;
        }

        const terminalStopId =
          String(
            pattern[
              terminalIndex
            ]
            || ""
          ).trim();

        if (!terminalStopId) {
          continue;
        }

        /*
         * A course whose actual static terminal is the selected stop
         * should not appear as a departure.
         */
        if (
          stopIdsMatch(
            terminalStopId,
            selectedStop
          )
        ) {
          continue;
        }

        // Keep the active service date (including GTFS times beyond 24:00),
        // but do not roll already-passed trips into tomorrow.
        const timestamp =
          gtfsSecondsToTodayTimestamp(seconds);

        if (timestamp < nowTimestamp) {
          continue;
        }

        const groupKey =
          `${routeId}|${directionKey}|${terminalStopId}`;

        if (
          !byTerminal.has(
            groupKey
          )
        ) {
          byTerminal.set(
            groupKey,
            {
              routeId,
              route,
              directionKey,
              direction,
              meta,
              terminalStopId,
              timestamps: []
            }
          );
        }

        byTerminal
          .get(groupKey)
          .timestamps
          .push(timestamp);
      }
    }

    const result = [];

    for (
      const target
      of byTerminal.values()
    ) {
      // A partial trip is a real scheduled service and is shown just like a
      // full-length trip. Its destination is still taken from this schedule
      // row's actual last served stop.
      const unique =
        [...new Set(target.timestamps)]
          .sort((a, b) => a - b)
          .slice(0, MAX_VISIBLE_BOARD_ARRIVALS);

      if (!unique.length) {
        continue;
      }

      const terminalStop =
        getStopById(
          target.terminalStopId
        );

      const destination =
        getDestinationDisplayName(
          target.terminalStopId,
          target.direction,
          target.direction?.destination
          || target.direction?.headsign
          || terminalStop?.stop_name
          || ""
        );

      result.push({
        route_id:
          target.routeId,

        direction_key:
          target.directionKey,

        direction:
          target.direction,

        terminal_stop_id:
          target.terminalStopId,

        route_ref:
          target.meta.number
          || target.route.route_short_name
          || "—",

        destination,

        times:
          unique.map(
            timestamp => ({
              timestamp,
              delay: null,
              scheduled: true,
              source: "static"
            })
          ),

        meta:
          target.meta,

        scheduled: true,
        source: "static"
      });
    }

    return result.sort(
      (a, b) =>
        a.times[0].timestamp
        - b.times[0].timestamp
    );
  }

  function isSkippedStaticSchedule(
    schedule,
    routeId,
    directionKey,
    selectedStopId,
    stopIndex,
    skippedTrips = []
  ) {
    if (
      !Array.isArray(skippedTrips)
      || !skippedTrips.length
    ) {
      return false;
    }

    const scheduleRouteId =
      String(
        routeId || ""
      ).trim();

    const scheduleDirectionKey =
      String(
        directionKey || ""
      ).trim();

    const scheduleOriginalTripId =
      String(
        schedule?.original_trip_id
        || ""
      ).trim();

    const scheduleStartTime =
      parseGtfsTime(
        schedule?.start_time
      );

    const scheduleStopSequences =
      Array.isArray(
        schedule?.stop_sequences
      )
        ? schedule.stop_sequences
        : [];

    const selectedSequence =
      Number.isInteger(stopIndex)
        ? Number(
            scheduleStopSequences[
              stopIndex
            ]
          )
        : NaN;

    return skippedTrips.some(
      skipped => {
        if (!skipped) {
          return false;
        }

        const skippedRouteId =
          String(
            skipped.route_id || ""
          ).trim();

        if (
          skippedRouteId
          && scheduleRouteId
          && skippedRouteId
            !== scheduleRouteId
        ) {
          return false;
        }

        const skippedStopId =
          String(
            skipped.stop_id || ""
          ).trim();

        if (skippedStopId) {
          if (
            !stopIdsMatch(
              skippedStopId,
              selectedStopId
            )
          ) {
            return false;
          }
        } else {
          const skippedSequence =
            Number(
              skipped.stop_sequence
            );

          if (
            !Number.isFinite(
              skippedSequence
            )
            || !Number.isFinite(
              selectedSequence
            )
          ) {
            return false;
          }

          if (
            skippedSequence
            !== selectedSequence
          ) {
            return false;
          }
        }

        const skippedTripId =
          String(
            skipped.trip_id || ""
          ).trim();

        if (
          scheduleOriginalTripId
          && skippedTripId
          && scheduleOriginalTripId
            === skippedTripId
        ) {
          return true;
        }

        if (
          !skippedTripId
          || scheduleStartTime == null
        ) {
          return false;
        }

        const staticTrip =
          findStaticTrip(
            skippedTripId
          );

        if (!staticTrip) {
          return false;
        }

        const skippedDirection =
          getStaticDirectionForTrip(
            staticTrip
          );

        if (
          skippedDirection?.key
          && scheduleDirectionKey
          && String(
            skippedDirection.key
          )
            !== scheduleDirectionKey
        ) {
          return false;
        }

        const skippedStartTime =
          parseGtfsTime(
            skipped.start_time
          );

        if (
          skippedStartTime == null
        ) {
          return false;
        }

        return (
          skippedStartTime
          === scheduleStartTime
        );
      }
    );
  }

  /*
   * Return the scheduled timestamp represented by a realtime stop update.
   *
   * Sofia Traffic normally supplies scheduled_time. When it is absent but
   * delay is available, timestamp - delay gives us the scheduled timestamp
   * represented by that prediction.
   */
  function getRealtimeScheduledTimestamp(
    time
  ) {
    const scheduledValue = time?.scheduled_time;
    const scheduled =
      scheduledValue === null
      || scheduledValue === undefined
      || String(scheduledValue).trim() === ""
        ? NaN
        : Number(scheduledValue);

    if (Number.isFinite(scheduled)) {
      return scheduled;
    }

    const actualValue = time?.timestamp;
    const delayValue = time?.delay;
    const actual =
      actualValue === null
      || actualValue === undefined
      || String(actualValue).trim() === ""
        ? NaN
        : Number(actualValue);
    const delay =
      delayValue === null
      || delayValue === undefined
      || String(delayValue).trim() === ""
        ? NaN
        : Number(delayValue);

    if (
      Number.isFinite(actual)
      && Number.isFinite(delay)
    ) {
      return actual - delay;
    }

    return null;
  }

  /*
   * Decide whether a concrete static timetable row is already represented
   * by one of the raw realtime trips from the current API response.
   *
   * IMPORTANT:
   * This intentionally receives realtime.routes directly, BEFORE the
   * frontend groups realtime rows by route/destination. That preserves the
   * actual trip_id/start_time/direction_id of the individual trip instance.
   *
   * Matching order:
   *
   *   1. Exact static trip identity:
   *        original_trip_id / trip_id == realtime trip_id
   *
   *   2. Same route + same scheduled arrival time, with compatible terminal,
   *      direction or destination information.
   *
   *   3. Same route + same scheduled arrival time when no stronger identity
   *      information is available.
   */
  function staticArrivalIsCoveredByRealtime(
    scheduledRoute,
    realtimeRoutes = []
  ) {
    const routeId =
      String(
        scheduledRoute?.route_id
        || ""
      ).trim();

    if (!routeId) {
      return false;
    }

    const staticTimestamp =
      Number(
        scheduledRoute
          ?.times?.[0]?.timestamp
      );

    if (
      !Number.isFinite(
        staticTimestamp
      )
    ) {
      return false;
    }

    const staticTripIds =
      new Set(
        [
          scheduledRoute?.original_trip_id,
          scheduledRoute?.static_trip_id,
          scheduledRoute?.trip_id
        ]
          .map(
            value =>
              String(
                value ?? ""
              ).trim()
          )
          .filter(Boolean)
      );


    const staticDirectionKey =
      String(
        scheduledRoute?.direction_key
        || ""
      ).trim();

    const staticTerminalId =
      String(
        scheduledRoute?.terminal_stop_id
        || ""
      ).trim();

    const staticDestinationKey =
      normalizeDirectionText(
        scheduledRoute?.destination
        || ""
      );

    for (
      const realtimeRoute
      of realtimeRoutes
    ) {
      const realtimeRouteId =
        String(
          realtimeRoute?.route_id
          || ""
        ).trim();

      if (
        realtimeRouteId
        !== routeId
      ) {
        continue;
      }

      // The API response is stop-specific. A trip record with no valid time
      // for this stop is not evidence that the static arrival is covered.
      const realtimeTimes = (
        Array.isArray(realtimeRoute?.times)
          ? realtimeRoute.times
          : []
      ).filter(time =>
        Number.isFinite(Number(time?.timestamp))
      );

      if (!realtimeTimes.length) {
        continue;
      }

      const realtimeTripId =
        String(
          realtimeRoute?.trip_id
          || ""
        ).trim();

      const realtimeDirectionKey =
        String(
          realtimeRoute?.direction_id
          || realtimeRoute?.directionId
          || ""
        ).trim();

      const realtimeTerminalId =
        String(
          realtimeRoute?.destination_stop_id
          || ""
        ).trim();

      const realtimeDestinationKey =
        normalizeDirectionText(
          realtimeRoute?.destination
          || ""
        );

      const exactTripMatch =
        !!realtimeTripId
        && staticTripIds.has(
          realtimeTripId
        );

      /*
       * An exact GTFS trip_id is already the identity of the concrete course.
       * Do NOT additionally require start_time or stop timestamp to match: the
       * realtime feed can legitimately report a different/normalized start
       * time, and a stop update can omit scheduled_time altogether. Requiring
       * either value here can let the same physical course fall through to the
       * static timetable and produce the duplicate realtime + static rows.
       */
      if (
        exactTripMatch
      ) {
        return true;
      }

      for (
        const time
        of realtimeTimes
      ) {
        const realtimeScheduledTimestamp =
          getRealtimeScheduledTimestamp(
            time
          );

        if (
          !Number.isFinite(
            realtimeScheduledTimestamp
          )
        ) {
          continue;
        }

        /*
         * The stop's scheduled time is the primary cross-source key.
         * Realtime actual time may differ because of delay, so we compare
         * against scheduled_time (or timestamp - delay when scheduled_time
         * is absent).
         */
        if (
          Math.abs(
            staticTimestamp
            - realtimeScheduledTimestamp
          ) > 120
        ) {
          continue;
        }

        const terminalCompatible =
          !!staticTerminalId
          && !!realtimeTerminalId
          && stopIdsMatch(
            staticTerminalId,
            realtimeTerminalId
          );

        const directionCompatible =
          !!staticDirectionKey
          && !!realtimeDirectionKey
          && (
            staticDirectionKey
            === realtimeDirectionKey
          );

        const destinationCompatible =
          !!staticDestinationKey
          && !!realtimeDestinationKey
          && (
            staticDestinationKey
            === realtimeDestinationKey
          );

        /*
         * When we have strong direction/terminal information, require one of
         * those to agree. This prevents two opposite-direction vehicles on
         * the same route and same minute from being confused.
         */
        if (
          staticTerminalId
          && realtimeTerminalId
        ) {
          if (
            terminalCompatible
            || directionCompatible
            || destinationCompatible
          ) {
            return true;
          }

          continue;
        }

        if (
          staticDirectionKey
          && realtimeDirectionKey
        ) {
          if (
            directionCompatible
          ) {
            return true;
          }

          continue;
        }

        if (
          staticDestinationKey
          && realtimeDestinationKey
        ) {
          if (
            destinationCompatible
          ) {
            return true;
          }

          continue;
        }

        /*
         * Last-resort fallback:
         * same route and same scheduled stop timestamp.
         */
        return true;
      }
    }

    return false;
  }

  function getSurfaceScheduledArrivals(
    stop,
    skippedTrips = []
  ) {
    const nowTimestamp =
      Date.now() / 1000;

    const selectedStop =
      String(
        stop?.stop_id
        || stop?.stop_code
        || ""
      ).trim();

    if (!selectedStop) {
      return [];
    }

    const stopKey =
      normalizeStopKey(
        selectedStop
      );

    const entries =
      surfaceDirectionsByStop.get(
        stopKey
      ) || [];

    if (!entries.length) {
      return [];
    }

    const dayType =
      getCurrentScheduleDayType();

    const rowsByTerminal =
      new Map();

    for (
      const entry
      of entries
    ) {
      const {
        routeId,
        route,
        directionKey,
        direction,
        stopIndex,
        meta,
        scheduleSet
      } = entry;

      const pattern =
        Array.isArray(
          direction?.pattern
        )
          ? direction.pattern.map(
              String
            )
          : [];

      if (!pattern.length) {
        continue;
      }

      const daySchedules =
        scheduleSet?.[
          directionKey
        ]?.[dayType];

      if (
        !Array.isArray(
          daySchedules
        )
      ) {
        continue;
      }

      for (
        const schedule
        of daySchedules
      ) {
        if (
          !isScheduleRowActiveToday(
            schedule
          )
        ) {
          continue;
        }

        const seconds =
          getCachedScheduleTime(
            schedule,
            stopIndex
          );

        if (seconds == null) {
          continue;
        }

        const terminalIndex =
          getCachedScheduleTerminalIndex(
            schedule,
            pattern.length
          );

        if (
          terminalIndex
          < stopIndex
        ) {
          continue;
        }

        const terminalStopId =
          String(
            pattern[
              terminalIndex
            ]
            || getDirectionTerminalStopId(
              direction
            )
            || ""
          ).trim();

        if (!terminalStopId) {
          continue;
        }

        if (
          stopIdsMatch(
            terminalStopId,
            selectedStop
          )
        ) {
          continue;
        }

        const timestamp =
          gtfsSecondsToTodayTimestamp(
            seconds
          );

        // Keep future departures from the active service date. The visible
        // list is bounded later to the next three times per line/destination.
        if (timestamp < nowTimestamp) {
          continue;
        }

        if (
          isSkippedStaticSchedule(
            schedule,
            routeId,
            directionKey,
            selectedStop,
            stopIndex,
            skippedTrips
          )
        ) {
          continue;
        }

        const destination =
          normalizeDirectionText(
            getDestinationDisplayName(
              terminalStopId,
              direction,
              direction?.destination
              || direction?.headsign
              || terminalStopId
            )
          );

        const groupKey =
          `${routeId}|${directionKey}|${terminalStopId}`;

        if (
          !rowsByTerminal.has(
            groupKey
          )
        ) {
          rowsByTerminal.set(
            groupKey,
            []
          );
        }

        rowsByTerminal
          .get(groupKey)
          .push({
            route,
            routeId,
            directionKey,
            direction,
            meta,
            terminalStopId,
            timestamp,
            schedule
          });
      }
    }

    return [
      ...rowsByTerminal.values()
    ]
      .flat()
      .map(row => {
        const terminalStop =
          getStopById(
            row.terminalStopId
          );

        const destination =
          getDestinationDisplayName(
            row.terminalStopId,
            row.direction,
            row.direction?.destination
            || row.direction?.headsign
            || terminalStop?.stop_name
            || ""
          );

        const schedule =
          row.schedule
          || {};

        return {
          route_id:
            row.routeId,
          direction_key:
            row.directionKey,
          direction:
            row.direction,
          terminal_stop_id:
            row.terminalStopId,
          route_ref:
            row.meta.number
            || row.route.route_short_name
            || "—",
          destination,

          // Preserve the concrete static trip identity so the final
          // realtime-vs-static dedupe can compare it against realtime.
          static_trip_id:
            String(
              schedule?.trip_id
              || ""
            ).trim(),

          original_trip_id:
            String(
              schedule?.original_trip_id
              || ""
            ).trim(),

          trip_start_time:
            String(
              schedule?.start_time
              || ""
            ).trim(),

          times: [
            {
              timestamp:
                row.timestamp,
              delay: null,
              scheduled: true
            }
          ],
          meta:
            row.meta,
          scheduled: true,
          source: "static"
        };
      })
      .sort(
        (a, b) =>
          a.times[0].timestamp
          - b.times[0].timestamp
      );
  }

  async function fetchJsonWithTimeout(
    url,
    options = {},
    timeoutMs = 45000
  ) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        timeoutMs
      );

    try {
      const response =
        await fetch(
          url,
          {
            ...options,
            signal:
              controller.signal,
            cache: "no-store"
          }
        );

      const data =
        await response.json();

      return {
        response,
        data
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchVirtualBoardViaServer(
    stop
  ) {
    const stopCode =
      String(
        stop?.stop_code
        || stop?.stop_id
        || ""
      ).trim();

    if (!stopCode) {
      throw new Error(
        "Липсва код на спирката."
      );
    }

    // Request only the GTFS routes that serve the selected stop. This keeps
    // the realtime response focused on relevant trips.
    const routeIds =
      getRealtimeRouteIdsForStop(
        stop
      );

    const routeIdsParam =
      routeIds.length
        ? (
          `&route_ids=${
            encodeURIComponent(
              routeIds.join(",")
            )
          }`
        )
        : "";

    const url =
      `api/virtual-board?stop_code=${
        encodeURIComponent(stopCode)
      }${routeIdsParam}`;

    const {
      response,
      data
    } =
      await fetchJsonWithTimeout(
        url,
        {
          headers: {
            Accept:
              "application/json"
          }
        },
        20000
      );

    if (!response.ok) {
      const message =
        data?.error
        || `Realtime API заявката върна ${response.status}.`;

      throw new Error(message);
    }

    const generatedAt =
      data?.generated_at
      || Date.now();

    const skippedTrips =
      Array.isArray(
        data?.skipped_trips
      )
        ? data.skipped_trips
        : [];

    const realtimeRoutes =
      Array.isArray(
        data?.routes
      )
        ? data.routes
            .filter(
              route =>
                route
                && Array.isArray(
                  route.times
                )
            )
            .filter(route => {
              const staticTrip =
                findStaticTrip(
                  route.trip_id
                );

              const routeId =
                route.route_id
                || staticTrip?.route_id
                || "";

              return !shouldHideTerminalArrival(
                routeId,
                stop.stop_id,
                staticTrip,
                route.destination
                  || "",
                route.direction_id
                  || route.directionId
                  || ""
              );
            })
            .map(route => {
              const staticTrip =
                findStaticTrip(
                  route.trip_id
                );

              const routeId =
                route.route_id
                || staticTrip?.route_id
                || "";

              const destinationDetails =
                resolveRealtimeRouteDestinationDetails(
                  route,
                  staticTrip,
                  routeId,
                  stop.stop_id
                );
              const staticDirection =
                destinationDetails.staticDirection;

              const routeMeta =
                getLineMeta(
                  routeId,
                  route.route_ref
                    || ""
                );

              return {
                ...route,
                source: "realtime",
                realtime: true,
                schedule_relationship:
                  Number(
                    route?.schedule_relationship
                  ),
                schedule_relationship_name:
                  String(
                    route?.schedule_relationship_name
                    || "SCHEDULED"
                  ),
                route_id:
                  route.route_id
                  || staticTrip?.route_id
                  || "",
                route_ref:
                  route.route_ref
                  || routeMeta.number
                  || "—",
                direction_key:
                  staticDirection?.key
                  || "",
                destination_stop_id:
                  destinationDetails.destinationStopId,
                destination:
                  destinationDetails.destination,
                times:
                  route.times
                    .map(
                      time => ({
                        timestamp:
                          Number(
                            time?.timestamp
                          ),
                        delay:
                          time?.delay !== null
                          && time?.delay !== undefined
                          && String(time.delay).trim() !== ""
                          && Number.isFinite(Number(time.delay))
                            ? Number(time.delay)
                            : null,
                        scheduled: false,
                        source: "realtime",
                        stop_schedule_relationship:
                          Number(
                            time?.stop_schedule_relationship
                          ),
                        stop_schedule_relationship_name:
                          String(
                            time?.stop_schedule_relationship_name
                            || "SCHEDULED"
                          ),
                        scheduled_time:
                          time?.scheduled_time !== null
                          && time?.scheduled_time !== undefined
                          && String(time.scheduled_time).trim() !== ""
                          && Number.isFinite(Number(time.scheduled_time))
                            ? Number(time.scheduled_time)
                            : null
                      })
                    )
                    .filter(
                      time =>
                        Number.isFinite(
                          time.timestamp
                        )
                    )
              };
            })
            .filter(
              route =>
                route.times.length
            )
        : [];

    const realtime = {
      status:
        data?.status || "empty",
      generatedAt,
      routes:
        isMetroStop(stop)
          ? []
          : realtimeRoutes
    };

    const metroRoutes =
      getMetroScheduledArrivals(
        stop
      );

    const mergedRealtime =
      new Map();

    for (
      const route
      of realtime.routes
    ) {
      const staticTrip =
        findStaticTrip(
          route.trip_id
        );

      const realtimeRouteId =
        String(
          route.route_id
          || staticTrip?.route_id
          || ""
        ).trim();

      const staticDirection =
        getStaticDirectionForTrip(
          staticTrip
        )
        || resolveDirectionForRealtimeRoute(
          realtimeRouteId,
          stop.stop_id,
          staticTrip,
          route.destination
            || "",
          route.direction_id
            || route.directionId
            || ""
        );

      const staticTerminalId =
        getDirectionTerminalStopId(
          staticDirection
        );

      const realtimeTerminalId =
        String(
          route.destination_stop_id
          || ""
        ).trim();

      const isPartialRealtime =
        !!realtimeTerminalId
        && !stopIdsMatch(
          realtimeTerminalId,
          staticTerminalId
        );

      const realtimeTerminal =
        isPartialRealtime
          ? getStopById(
              realtimeTerminalId
            )
          : null;

      const destination =
        getDestinationDisplayName(
          isPartialRealtime
            ? realtimeTerminalId
            : (
                staticTerminalId
                || realtimeTerminalId
              ),
          staticDirection,
          route.destination
          || staticTrip?.trip_headsign
          || staticDirection?.destination
          || staticDirection?.headsign
          || realtimeTerminal?.stop_name
          || ""
        );

      const directionIdentity =
        normalizeDirectionText(
          destination
        );

      const key =
        `${String(
          route.route_id
          || staticTrip?.route_id
          || ""
        )}|${directionIdentity}|${String(
          route.route_ref || ""
        )}`;

      if (
        !mergedRealtime.has(key)
      ) {
        mergedRealtime.set(
          key,
          {
            ...route,
            source: "realtime",
            realtime: true,
            destination,
            times: []
          }
        );
      }

      mergedRealtime
        .get(key)
        .times.push(
          ...(route.times || [])
        );
    }

    const mergedSurfaceRoutes =
      [...mergedRealtime.values()]
        .map(route => ({
          ...route,
          times:
            getLimitedUniqueArrivalTimes(
              route.times
            )
        }))
        .filter(
          route =>
            route.times.length
        );

    const scheduledSurfaceRoutes =
      isMetroStop(stop)
        ? []
        : getSurfaceScheduledArrivals(
            stop,
            skippedTrips
          );

    // Suppress only a static arrival representing the same physical course.
    // Do not suppress all static courses merely because the same direction has
    // at least one realtime vehicle.
    const surfaceFallbackRoutes =
      scheduledSurfaceRoutes.filter(route =>
        !staticArrivalIsCoveredByRealtime(
          route,
          realtime.routes
        )
      );

    // The common row key is line + displayed destination + line reference.
    // Merge first, deduplicate timestamps, then apply the four-time limit.
    const surfaceRoutes =
      mergeBoardRoutesByDestination([
        ...mergedSurfaceRoutes,
        ...surfaceFallbackRoutes
      ]);

    const realtimeRouteIds =
      new Set(
        mergedSurfaceRoutes.map(
          route =>
            String(
              route?.route_id
              || ""
            )
        )
      );

    const routes = [
      ...surfaceRoutes,
      ...metroRoutes.filter(
        route =>
          !realtimeRouteIds.has(
            String(
              route.route_id
              || ""
            )
          )
      )
    ];

    return {
      status:
        routes.length
          ? "ok"
          : "empty",
      generatedAt,
      routes
    };
  }

  async function fetchVirtualBoard(
    stop
  ) {
    return fetchVirtualBoardViaServer(
      stop
    );
  }

  function bindRefreshButton() {
    const button =
      document.getElementById(
        "virtualBoardRefresh"
      );

    if (!button) return;

    button.onclick =
      () =>
        refreshSelectedBoard(true);
  }

  function renderBoardList(
    panel,
    stop,
    data
  ) {
    const list =
      panel?.querySelector(
        ".virtual-board-list"
      );

    if (!list) return;

    if (
      data.status !== "ok"
      || !data.routes.length
    ) {
      list.innerHTML =
        `<div class="virtual-board-no-data">Няма предстоящи заминавания.</div>`;

      return;
    }

    const rows =
      data.routes
        .map(route => ({
          ...route,
          arrivals:
            (route.times || [])
              .map(time => ({
                timestamp:
                  Number(
                    time?.timestamp
                  ),
                delay:
                  Number.isFinite(
                    Number(
                      time?.delay
                    )
                  )
                    ? Number(
                        time.delay
                      )
                    : null,
                scheduled:
                  Boolean(
                    time?.scheduled
                  )
              }))
              .filter(
                time =>
                  Number.isFinite(
                    time.timestamp
                  )
              )
              .filter(
                time =>
                  getArrivalMinutes(
                    time.timestamp
                  ) >= 0
              )
              .sort(
                (a, b) =>
                  a.timestamp
                  - b.timestamp
              )
              .slice(0, MAX_VISIBLE_BOARD_ARRIVALS)
        }))
        .filter(
          route =>
            route.arrivals.length
        )
        .sort(
          (a, b) =>
            a.arrivals[0].timestamp
            - b.arrivals[0].timestamp
        );

    if (!rows.length) {
      list.innerHTML =
        `<div class="virtual-board-no-data">Няма предстоящи заминавания.</div>`;

      return;
    }

    list.innerHTML =
      rows.map(
        row => {
          const meta =
            getLineMeta(
              row.route_id
              || row.routeId,
              row.route_ref
            );

          const arrivals =
            row.arrivals;

          const nextTimes =
            arrivals
              .slice(1, MAX_VISIBLE_BOARD_ARRIVALS)
              .map(
                time => {
                  const tooltip =
                    formatArrivalCountdown(
                      time.timestamp
                    );

                  const clock =
                    formatArrivalClock(
                      time.timestamp
                    );

                  return (
                    `<span class="vb-next-time"`
                    + ` tabindex="0"`
                    + ` data-arrival-timestamp="${time.timestamp}"`
                    + ` data-tooltip="${escapeHtml(
                        tooltip
                      )}"`
                    + ` aria-label="${escapeHtml(
                        tooltip
                      )}">`
                    + `${escapeHtml(clock)}`
                    + `</span>`
                  );
                }
              )
              .join("");

          return `
            <article class="vb-row">
              <div class="schedule-summary-route-row vb-route-row">
                ${lineIdentityHtml(meta)}
                ${destinationHtml(
                  row.destination
                  || row.headsign
                  || ""
                )}
              </div>
              <div class="vb-time-block">
                ${countdownHtml(
                  arrivals[0],
                  !arrivals[0]?.scheduled
                )}
                ${
                  arrivals.length > 1
                    ? (
                      `<div class="vb-next-times">`
                      + `${nextTimes}`
                      + `</div>`
                    )
                    : ""
                }
              </div>
            </article>
          `;
        }
      ).join("");
  }

  async function renderStopBoard(
    stop,
    boardData = null
  ) {
    const renderToken =
      ++boardRenderToken;

    selectedStopId =
      String(
        stop.stop_id
      );

    const panel =
      boardPanel();

    if (!panel) return;

    panel.innerHTML = `
      <div class="virtual-board-header">
        <div>
          <div class="virtual-board-kicker">Спирка ${escapeHtml(
            stop.stop_code
            || stop.stop_id
            || ""
          )}</div>
          <h2>${escapeHtml(
            stop.stop_name
            || stop.name
            || "Спирка"
          )}</h2>
        </div>
        <div class="virtual-board-header-actions">
          <button type="button" class="virtual-board-refresh is-loading" id="virtualBoardRefresh" disabled aria-label="Обнови таблото" title="Обнови таблото"><span aria-hidden="true">↻</span></button>
          <button type="button" class="virtual-board-favorite${
            isFavoriteStop(
              stop.stop_id
            )
              ? " is-favorite"
              : ""
          }" id="virtualBoardFavorite" aria-label="${
            isFavoriteStop(stop.stop_id)
              ? "Премахни от любими"
              : "Добави в любими"
          }" title="${
            isFavoriteStop(stop.stop_id)
              ? "Премахни от любими"
              : "Добави в любими"
          }"><span aria-hidden="true">${
            isFavoriteStop(
              stop.stop_id
            )
              ? "★"
              : "☆"
          }</span></button>
          <button type="button" class="virtual-board-close" id="virtualBoardClose" aria-label="Затвори таблото">×</button>
        </div>
      </div>
      <div class="virtual-board-list"><div class="virtual-board-loading">Зареждане…</div></div>
    `;

    document
      .getElementById(
        "virtualBoardClose"
      )
      ?.addEventListener(
        "click",
        () => {
          ++boardRenderToken;

          selectedStopId =
            null;

          lastExpiredPrimaryArrival =
            null;

          if (selectedStopMarker) {
            selectedStopMarker.setStyle(
              {
                fillColor:
                  "#111827",
                color:
                  "#ffffff",
                fillOpacity:
                  1
              }
            );

            selectedStopMarker =
              null;
          }

          renderEmptyBoard();
        }
      );

    document
      .getElementById(
        "virtualBoardFavorite"
      )
      ?.addEventListener(
        "click",
        event => {
          const button =
            event.currentTarget;

          const favorite =
            setFavoriteStop(
              stop
            );

          button.classList.toggle(
            "is-favorite",
            favorite
          );

          button.querySelector(
            "span"
          ).textContent =
            favorite
              ? "★"
              : "☆";

          button.setAttribute(
            "aria-label",
            favorite
              ? "Премахни от любими"
              : "Добави в любими"
          );

          button.setAttribute(
            "title",
            favorite
              ? "Премахни от любими"
              : "Добави в любими"
          );
        }
      );

    try {
      const data =
        boardData
        || await fetchVirtualBoard(
          stop
        );

      if (
        renderToken
          !== boardRenderToken
        || selectedStopId
          !== String(
            stop.stop_id
          )
      ) {
        return;
      }

      renderBoardList(
        panel,
        stop,
        data
      );
    } catch (error) {
      if (
        renderToken
          !== boardRenderToken
        || selectedStopId
          !== String(
            stop.stop_id
          )
      ) {
        return;
      }

      console.error(
        "Realtime virtual board error:",
        error
      );

      panel.querySelector(
        ".virtual-board-list"
      ).innerHTML =
        `<div class="virtual-board-error">Realtime данните не могат да бъдат заредени.</div>`;
    } finally {
      if (
        renderToken
          !== boardRenderToken
        || selectedStopId
          !== String(
            stop.stop_id
          )
      ) {
        return;
      }

      const refreshButton =
        document.getElementById(
          "virtualBoardRefresh"
        );

      if (refreshButton) {
        refreshButton.disabled =
          false;

        refreshButton.classList.remove(
          "is-loading"
        );

        bindRefreshButton();
      }
    }
  }

  function renderEmptyBoard() {
    const panel =
      boardPanel();

    if (!panel) return;

    const favorites =
      getFavoriteStops();

    const favoritesHtml =
      favorites.length
        ? `
        <div class="virtual-board-favorites">
          <div class="virtual-board-favorites-heading">
            <h3>Любими спирки</h3>
          </div>
          <div class="virtual-board-favorites-list">
            ${favorites.map(
              stop => `
              <button type="button" class="virtual-board-favorite-stop" data-stop-id="${escapeHtml(
                stop.stop_id
              )}">
                <span class="virtual-board-favorite-stop-star" aria-hidden="true">★</span>
                <span class="virtual-board-favorite-stop-info">
                  <strong>${escapeHtml(
                    stop.stop_name
                    || "Спирка"
                  )}</strong>
                  <span>[${escapeHtml(
                    stop.stop_code
                    || stop.stop_id
                    || ""
                  )}]</span>
                </span>
                <span class="virtual-board-favorite-stop-arrow" aria-hidden="true">→</span>
              </button>
            `
            ).join("")}
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

    panel
      .querySelectorAll(
        ".virtual-board-favorite-stop"
      )
      .forEach(
        button => {
          button.addEventListener(
            "click",
            () => {
              const stop =
                findStopById(
                  button.dataset.stopId
                );

              if (stop) {
                selectStopOnMap(
                  stop
                );
              }
            }
          );
        }
      );
  }

  function findStopById(
    stopId
  ) {
    return (
      transportData?.stops || []
    ).find(
      stop =>
        String(
          stop.stop_id
        )
        === String(stopId)
    ) || null;
  }

  function selectStopOnMap(
    stop
  ) {
    if (
      !stop
      || !map
    ) {
      return;
    }

    if (selectedStopMarker) {
      selectedStopMarker.setStyle(
        {
          fillColor:
            "#111827",
          color:
            "#ffffff",
          fillOpacity:
            1
        }
      );
    }

    const lat =
      Number(
        stop.stop_lat
      );

    const lon =
      Number(
        stop.stop_lon
      );

    if (
      !Number.isFinite(lat)
      || !Number.isFinite(lon)
    ) {
      return;
    }

    const marker =
      stopMarkersById.get(
        String(
          stop.stop_id
        )
      );

    if (marker) {
      marker.setStyle(
        {
          fillColor:
            "#BE1E2D",
          color:
            "#ffffff",
          fillOpacity:
            1
        }
      );

      selectedStopMarker =
        marker;
    } else {
      selectedStopMarker =
        null;
    }

    renderStopBoard(
      stop
    );

    map.setView(
      [lat, lon],
      Math.max(
        map.getZoom(),
        15
      ),
      {
        animate: true
      }
    );
  }

  function setupStopSearch(
    stops
  ) {
    const input =
      document.getElementById(
        "stopSearch"
      );

    const results =
      document.getElementById(
        "stopSearchResults"
      );

    if (
      !input
      || !results
    ) {
      return;
    }

    const normalized =
      value =>
        String(value || "")
          .toLocaleLowerCase(
            "bg-BG"
          )
          .normalize("NFD")
          .replace(
            /[\u0300-\u036f]/g,
            ""
          );

    const searchStops =
      query => {
        const needle =
          normalized(
            query
          ).trim();

        if (!needle) {
          return [];
        }

        const seen =
          new Set();

        return stops
          .filter(
            stop => {
              const name =
                normalized(
                  stop.name
                  || stop.stop_name
                );

              const code =
                normalized(
                  stop.stop_code
                  || stop.stop_id
                );

              return (
                name.includes(
                  needle
                )
                || code.includes(
                  needle
                )
              );
            }
          )
          .filter(
            stop => {
              const key =
                String(
                  stop.stop_code
                  || stop.stop_id
                  || ""
                ).trim();

              if (
                !key
                || seen.has(key)
              ) {
                return false;
              }

              seen.add(key);

              return true;
            }
          )
          .slice(0, 8);
      };

    const renderResults =
      matches => {
        results.innerHTML =
          matches.length
            ? matches
                .map(
                  stop => `
                  <button type="button" class="virtual-stop-search-result" data-stop-id="${escapeHtml(
                    stop.stop_id
                  )}">
                    <strong>${escapeHtml(
                      stop.name
                      || stop.stop_name
                      || "Спирка"
                    )}</strong>
                    <span>${escapeHtml(
                      stop.stop_code
                      || stop.stop_id
                      || ""
                    )}</span>
                  </button>
                `
                )
                .join("")
            : `<div class="virtual-stop-search-empty">Няма намерени спирки.</div>`;

        results.hidden =
          false;

        results
          .querySelectorAll(
            "[data-stop-id]"
          )
          .forEach(
            button => {
              button.addEventListener(
                "click",
                () => {
                  const stop =
                    findStopById(
                      button.dataset.stopId
                    );

                  if (stop) {
                    input.value =
                      stop.name
                      || stop.stop_name
                      || "";

                    results.hidden =
                      true;

                    selectStopOnMap(
                      stop
                    );
                  }
                }
              );
            }
          );
      };

    input.addEventListener(
      "input",
      () => {
        const query =
          input.value.trim();

        if (!query) {
          results.hidden =
            true;

          results.innerHTML =
            "";

          return;
        }

        renderResults(
          searchStops(
            query
          )
        );
      }
    );

    input.addEventListener(
      "focus",
      () => {
        if (
          input.value.trim()
        ) {
          renderResults(
            searchStops(
              input.value
            )
          );
        }
      }
    );

    document.addEventListener(
      "click",
      event => {
        if (
          !event.target.closest(
            ".virtual-stop-search"
          )
        ) {
          results.hidden =
            true;
        }
      }
    );
  }

  function setupGeolocation() {
    const button =
      document.getElementById(
        "locateUserButton"
      );

    if (!button) return;

    let userMarker =
      null;

    const locate = () => {
      if (
        !navigator.geolocation
      ) {
        window.alert(
          "Този браузър не поддържа определяне на локация."
        );

        return;
      }

      button.disabled =
        true;

      button.classList.add(
        "is-loading"
      );

      navigator.geolocation.getCurrentPosition(
        position => {
          const lat =
            position.coords.latitude;

          const lon =
            position.coords.longitude;

          if (!userMarker) {
            userMarker =
              L.circleMarker(
                [lat, lon],
                {
                  radius: 8,
                  weight: 3,
                  color: "#ffffff",
                  fillColor: "#2563eb",
                  fillOpacity: 1
                }
              ).addTo(map);

            userMarker.bindTooltip(
              "Вашата локация",
              {
                direction: "top",
                offset: [0, -8]
              }
            );
          } else {
            userMarker.setLatLng(
              [lat, lon]
            );
          }

          map.setView(
            [lat, lon],
            Math.max(
              map.getZoom(),
              15
            ),
            {
              animate: true
            }
          );

          button.disabled =
            false;

          button.classList.remove(
            "is-loading"
          );
        },
        error => {
          console.warn(
            "Грешка при определяне на локацията:",
            error
          );

          button.disabled =
            false;

          button.classList.remove(
            "is-loading"
          );

          window.alert(
            "Не успяхме да определим вашата локация. Проверете разрешението за достъп до местоположението."
          );
        },
        {
          enableHighAccuracy:
            true,
          timeout:
            10000,
          maximumAge:
            30000
        }
      );
    };

    button.addEventListener(
      "click",
      locate
    );
  }

  function addStopMarkers(
    stops
  ) {
    stopMarkers.clearLayers();
    stopMarkersById.clear();
    selectedStopMarker = null;

    const renderer =
      L.svg();

    for (
      const stop
      of stops
    ) {
      const lat =
        Number(
          stop.stop_lat
        );

      const lon =
        Number(
          stop.stop_lon
        );

      if (
        !Number.isFinite(lat)
        || !Number.isFinite(lon)
      ) {
        continue;
      }

      const clickTarget =
        L.circleMarker(
          [lat, lon],
          {
            radius: 16,
            weight: 0,
            stroke: false,
            fillColor:
              "#111827",
            fillOpacity:
              0.01,
            renderer,
            pane:
              "markerPane"
          }
        );

      const marker =
        L.circleMarker(
          [lat, lon],
          {
            radius: 7,
            weight: 2,
            color:
              "#ffffff",
            fillColor:
              "#111827",
            fillOpacity:
              1,
            renderer,
            pane:
              "markerPane"
          }
        );

      const stopTooltip =
        escapeHtml(
          stop.name
          || stop.stop_name
          || "Спирка"
        );

      marker.bindTooltip(
        stopTooltip,
        {
          direction:
            "top",
          offset:
            [0, -5]
        }
      );

      clickTarget.bindTooltip(
        stopTooltip,
        {
          direction:
            "top",
          offset:
            [0, -12]
        }
      );

      const select =
        () =>
          selectStopOnMap(
            stop
          );

      clickTarget.on(
        "click",
        select
      );

      marker.on(
        "click",
        select
      );

      clickTarget.addTo(
        stopMarkers
      );

      marker.addTo(
        stopMarkers
      );

      stopMarkersById.set(
        String(
          stop.stop_id
        ),
        marker
      );
    }
  }

  function getActiveStops(
    stops
  ) {
    const activeStopIds =
      new Set();

    for (
      const directionSet
      of Object.values(
        transportData?.directions
        || {}
      )
    ) {
      for (
        const direction
        of Object.values(
          directionSet || {}
        )
      ) {
        for (
          const stop
          of direction?.stops
          || []
        ) {
          const stopId =
            String(
              stop?.stop_id
              ?? ""
            ).trim();

          if (stopId) {
            activeStopIds.add(
              stopId
            );
          }
        }
      }
    }

    return stops.filter(
      stop => {
        const stopId =
          String(
            stop?.stop_id
            ?? ""
          ).trim();

        if (
          !activeStopIds.has(
            stopId
          )
        ) {
          return false;
        }

        const locationType =
          String(
            stop?.location_type
            ?? "0"
          ).trim();

        return (
          locationType === "0"
        );
      }
    );
  }

  function initMap(
    stops
  ) {
    if (
      typeof L === "undefined"
    ) {
      const mapElement =
        document.getElementById(
          "virtualMap"
        );

      if (mapElement) {
        mapElement.innerHTML =
          '<div class="virtual-map-error">Картата не може да бъде заредена.</div>';
      }

      return;
    }

    map =
      L.map(
        "virtualMap",
        {
          center:
            SOFIA_CENTER,
          zoom:
            12,
          minZoom:
            10,
          preferCanvas:
            true,
          zoomControl:
            true
        }
      );

    L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom:
          19,
        attribution:
          '&copy; OpenStreetMap contributors'
      }
    ).addTo(map);

    stopMarkers =
      L.layerGroup()
        .addTo(map);

    addStopMarkers(
      stops
    );

    setTimeout(
      () =>
        map.invalidateSize(),
      100
    );
  }

  function updateBoardCountdowns() {
    const panel =
      boardPanel();

    if (
      !panel
      || !selectedStopId
    ) {
      return;
    }

    const nowSeconds =
      Date.now() / 1000;

    let primaryArrivalExpired =
      null;

    panel
      .querySelectorAll(
        "[data-arrival-timestamp]"
      )
      .forEach(
        element => {
          const timestamp =
            Number(
              element.dataset
                .arrivalTimestamp
            );

          if (
            !Number.isFinite(
              timestamp
            )
          ) {
            return;
          }

          const countdown =
            formatArrivalCountdown(
              timestamp,
              nowSeconds
            );

          if (
            element.classList.contains(
              "vb-arrival-minutes"
            )
          ) {
            element.textContent =
              countdown;

            if (
              timestamp
              <= nowSeconds
            ) {
              primaryArrivalExpired =
                timestamp;
            }

            return;
          }

          element.dataset.tooltip =
            countdown;

          element.setAttribute(
            "aria-label",
            countdown
          );
        }
      );

    if (
      primaryArrivalExpired
        !== null
      && primaryArrivalExpired
        !== lastExpiredPrimaryArrival
      && !refreshInFlight
    ) {
      lastExpiredPrimaryArrival =
        primaryArrivalExpired;

      refreshSelectedBoard(true);
    }
  }

  function startTimers() {
    clearInterval(
      refreshTimer
    );

    clearInterval(
      countdownTimer
    );

    countdownTimer =
      setInterval(
        updateBoardCountdowns,
        1000
      );

    refreshTimer =
      setInterval(
        () => {
          if (
            selectedStopId
          ) {
            refreshSelectedBoard(true);
          }
        },
        REFRESH_MS
      );

    updateBoardCountdowns();
  }

  async function refreshSelectedBoard(
    force = false
  ) {
    if (
      !selectedStopId
      || refreshInFlight
    ) {
      return;
    }

    const requestedStopId =
      String(
        selectedStopId
      );

    const requestToken =
      boardRenderToken;

    const stop =
      findStopById(
        requestedStopId
      );

    if (!stop) {
      return;
    }

    const refreshButton =
      document.getElementById(
        "virtualBoardRefresh"
      );

    refreshButton?.classList.add(
      "is-loading"
    );

    if (refreshButton) {
      refreshButton.disabled =
        true;
    }

    refreshInFlight =
      true;

    try {
      const data =
        await fetchVirtualBoard(
          stop
        );

      if (
        requestToken
          !== boardRenderToken
        || selectedStopId
          !== requestedStopId
      ) {
        return;
      }

      const displayedPrimaryArrival =
        Number(
          boardPanel()
            ?.querySelector(
              ".vb-arrival-minutes"
            )
            ?.dataset
              .arrivalTimestamp
        );

      if (
        !force
        && Number.isFinite(
          displayedPrimaryArrival
        )
        && displayedPrimaryArrival
          <= Date.now() / 1000
      ) {
        lastExpiredPrimaryArrival =
          displayedPrimaryArrival;

        updateBoardCountdowns();

        return;
      }

      // IMPORTANT:
      // Do not rebuild the complete virtual-board panel here.
      // The header, buttons and event listeners are already present.
      // Only replace the arrival list. This removes a substantial amount of
      // synchronous DOM work from every 15-second refresh.
      renderBoardList(
        boardPanel(),
        stop,
        data
      );
    } catch (error) {
      if (
        requestToken
          !== boardRenderToken
        || selectedStopId
          !== requestedStopId
      ) {
        return;
      }

      console.error(
        "Неуспешно зареждане на GTFS-Realtime виртуално табло:",
        error
      );

      const list =
        boardPanel()
          ?.querySelector(
            ".virtual-board-list"
          );

      if (list) {
        list.innerHTML =
          `<div class="virtual-board-error">Realtime данните не могат да бъдат заредени.</div>`;
      }
    } finally {
      refreshInFlight =
        false;

      if (
        requestToken
          === boardRenderToken
        && selectedStopId
          === requestedStopId
      ) {
        const button =
          document.getElementById(
            "virtualBoardRefresh"
          );

        if (button) {
          button.disabled =
            false;

          button.classList.remove(
            "is-loading"
          );

          bindRefreshButton();
        }
      }

      const primaryArrival =
        boardPanel()
          ?.querySelector(
            ".vb-arrival-minutes"
          )
          ?.dataset
            .arrivalTimestamp;

      lastExpiredPrimaryArrival =
        Number.isFinite(
          Number(primaryArrival)
        )
          ? Number(primaryArrival)
          : null;
    }
  }

  async function initializeVirtualBoards() {
    try {
      transportData =
        await loadTransportData();

      routeById =
        new Map(
          (transportData.routes || [])
            .map(
              route => [
                String(
                  route.route_id
                ),
                route
              ]
            )
        );

      tripById =
        new Map(
          (transportData.trips || [])
            .map(
              trip => [
                String(
                  trip.trip_id
                ),
                trip
              ]
            )
        );

      tripStopsById =
        new Map();

      for (
        const directionSet
        of Object.values(
          transportData.directions
          || {}
        )
      ) {
        for (
          const direction
          of Object.values(
            directionSet || {}
          )
        ) {
          const tripId =
            String(
              direction?.trip_id
              || ""
            ).trim();

          if (!tripId) {
            continue;
          }

          const stopIds =
            Array.isArray(
              direction?.stops
            )
              ? direction.stops
                  .map(
                    stop =>
                      String(
                        stop?.stop_id
                        || ""
                      ).trim()
                  )
                  .filter(Boolean)
              : [];

          if (stopIds.length) {
            tripStopsById.set(
              tripId,
              stopIds
            );
          }
        }
      }

      const lines =
        convertGtfsRoutes(
          transportData.routes
            || [],
          transportData.trips
            || [],
          transportData.directions
            || {}
        );

      routeMetaById =
        new Map(
          lines.map(
            line => [
              String(line.id),
              line
            ]
          )
        );

      routeMetaByNumber =
        new Map(
          lines.map(
            line => [
              String(
                line.number
              ).trim(),
              line
            ]
          )
        );

      // Build the static timetable indexes once.
      // This moves the expensive dataset-wide traversal out of the 15-second
      // refresh path.
      buildStaticScheduleIndexes();

      const allStops =
        transportData.stops || [];

      const stops =
        getActiveStops(
          allStops
        );

      initMap(
        stops
      );

      setupStopSearch(
        stops
      );

      setupGeolocation();

      renderEmptyBoard();

      const requestedStopId =
        new URLSearchParams(
          window.location.search
        ).get("stop");

      if (requestedStopId) {
        const requestedStop =
          findStopById(
            requestedStopId
          );

        if (requestedStop) {
          selectStopOnMap(
            requestedStop
          );
        }
      }

      startTimers();
    } catch (error) {
      console.error(
        "Неуспешно зареждане на GTFS за виртуалните табла:",
        error
      );

      const panel =
        boardPanel();

      if (panel) {
        panel.innerHTML = `
          <div class="virtual-board-error">
            <strong>Виртуалното табло не може да бъде заредено.</strong>
            <span>${escapeHtml(
              error.message
              || "Неизвестна грешка."
            )}</span>
          </div>
        `;
      }
    }
  }

  document.addEventListener(
    "DOMContentLoaded",
    initializeVirtualBoards
  );

  // Small test seam; production pages do not use this object.
  globalThis.__gtsofiaVirtualBoardTestInternals = {
    isServiceActiveOnDate,
    isScheduleRowActiveToday,
    getSofiaDateKey,
    formatArrivalCountdown,
    getDestinationDisplayName,
    MAX_VISIBLE_BOARD_ARRIVALS,
    staticArrivalIsCoveredByRealtime,
    getRealtimeScheduledTimestamp,
    getStaticScheduleInfoForTrip,
    getScheduledTripTerminalStopId,
    shouldHideTerminalArrival,
    getRealtimeTripDestinationStopId,
    resolveRealtimeRouteDestinationDetails,
    getMetroScheduledArrivals,
    getSurfaceScheduledArrivals,
    isSkippedStaticSchedule,
    mergeBoardRoutesByDestination,
    getLimitedUniqueArrivalTimes,
    setTestState({ transportData: nextTransportData, trips = [], buildIndexes = false } = {}) {
      transportData = nextTransportData || null;
      routeById = new Map((transportData?.routes || []).map(route => [String(route.route_id), route]));
      const allTrips = trips.length ? trips : (transportData?.trips || []);
      tripById = new Map(allTrips.map(trip => [String(trip.trip_id), trip]));
      tripStopsById = new Map();
      if (buildIndexes) buildStaticScheduleIndexes();
    }
  };
})();
