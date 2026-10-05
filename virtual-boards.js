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

  // Realtime stop updates disappear shortly after the vehicle passes the
  // selected stop. Keep the scheduled time they represented so the static
  // fallback does not immediately resurrect the same course.
  const CONSUMED_REALTIME_ARRIVALS_KEY =
    "gtsofia.virtualBoard.consumedRealtimeArrivals.v1";
  const CONSUMED_REALTIME_ARRIVAL_TTL_MS =
    20 * 60 * 1000;

  const consumedRealtimeArrivals = new Map();
  let consumedRealtimeArrivalsLoaded = false;

  const boardPanel = () =>
    document.getElementById("virtualBoardBody");

  const FAVORITE_STOPS_KEY =
    "gtsofia.favoriteStops";

  function loadConsumedRealtimeArrivals() {
    if (consumedRealtimeArrivalsLoaded) return;
    consumedRealtimeArrivalsLoaded = true;

    try {
      const raw = sessionStorage.getItem(
        CONSUMED_REALTIME_ARRIVALS_KEY
      );

      const stored = JSON.parse(raw || "[]");

      if (!Array.isArray(stored)) return;

      const now = Date.now();

      for (const item of stored) {
        const key = String(
          item?.key || ""
        ).trim();

        const expiresAt = Number(
          item?.expiresAt
        );

        if (
          key
          && Number.isFinite(expiresAt)
          && expiresAt > now
        ) {
          consumedRealtimeArrivals.set(
            key,
            expiresAt
          );
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

    for (
      const [key, expiresAt]
      of consumedRealtimeArrivals
    ) {
      if (
        !Number.isFinite(expiresAt)
        || expiresAt <= now
      ) {
        consumedRealtimeArrivals.delete(key);
        changed = true;
      }
    }

    if (changed) {
      persistConsumedRealtimeArrivals();
    }
  }

  function persistConsumedRealtimeArrivals() {
    try {
      sessionStorage.setItem(
        CONSUMED_REALTIME_ARRIVALS_KEY,
        JSON.stringify(
          [...consumedRealtimeArrivals.entries()]
            .map(([key, expiresAt]) => ({
              key,
              expiresAt
            }))
        )
      );
    } catch {
      // Keep working with the in-memory cache when sessionStorage is blocked.
    }
  }

  function getConsumedRealtimeArrivalKey(
    stopId,
    routeId,
    destination,
    scheduledTimestamp
  ) {
    const timestamp =
      Number(scheduledTimestamp);

    if (!Number.isFinite(timestamp)) {
      return "";
    }

    return [
      normalizeStopKey(stopId),
      String(routeId || "").trim(),
      normalizeDirectionText(destination),
      Math.floor(timestamp / 60)
    ].join("|");
  }

  function rememberConsumedRealtimeArrivals(
    stop,
    realtimeRoutes
  ) {
    pruneConsumedRealtimeArrivals();

    const nowSeconds =
      Date.now() / 1000;

    const stopId = String(
      stop?.stop_id
      || stop?.stop_code
      || ""
    ).trim();

    if (!stopId) return;

    let changed = false;

    for (const route of realtimeRoutes || []) {
      const routeId = String(
        route?.route_id || ""
      ).trim();

      if (!routeId) continue;

      const destination = String(
        route?.destination || ""
      ).trim();

      for (const time of route?.times || []) {
        const actualTimestamp =
          Number(time?.timestamp);

        const scheduledTimestamp =
          Number(time?.scheduled_time);

        if (
          !Number.isFinite(actualTimestamp)
          || !Number.isFinite(scheduledTimestamp)
        ) {
          continue;
        }

        if (actualTimestamp > nowSeconds) {
          continue;
        }

        const key =
          getConsumedRealtimeArrivalKey(
            stopId,
            routeId,
            destination,
            scheduledTimestamp
          );

        if (
          !key
          || consumedRealtimeArrivals.has(key)
        ) {
          continue;
        }

        consumedRealtimeArrivals.set(
          key,
          Date.now()
          + CONSUMED_REALTIME_ARRIVAL_TTL_MS
        );

        changed = true;
      }
    }

    if (changed) {
      persistConsumedRealtimeArrivals();
    }
  }

  function isConsumedRealtimeScheduledArrival(
    stopId,
    routeId,
    destination,
    scheduledTimestamp
  ) {
    pruneConsumedRealtimeArrivals();

    const key =
      getConsumedRealtimeArrivalKey(
        stopId,
        routeId,
        destination,
        scheduledTimestamp
      );

    return !!key
      && consumedRealtimeArrivals.has(key);
  }

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

    // During the final minute, show the remaining seconds instead of
    // throwing away the precision provided by the realtime timestamp.
    if (remainingSeconds < 60) {
      const secondsLeft =
        Math.min(
          59,
          Math.max(
            1,
            Math.ceil(remainingSeconds)
          )
        );

      return `${secondsLeft} сек.`;
    }

    // Two minutes and above: keep the familiar minute-based display.
    return `${Math.max(
      1,
      Math.round(
        remainingSeconds / 60
      )
    )} мин.`;
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
      && Object.prototype.hasOwnProperty.call(
        byDate,
        dateKey
      )
    ) {
      return (
        Array.isArray(
          byDate[dateKey]
        )
        && byDate[dateKey].some(
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
    const direction =
      resolveDirectionForRealtimeRoute(
        routeId,
        stopId,
        staticTrip,
        destination,
        directionId
      );

    if (
      direction?.pattern?.length
      && isTerminalDirectionForStop(
        routeId,
        stopId,
        direction
      )
    ) {
      return true;
    }

    const selectedStop =
      getStopById(stopId);

    const selectedName =
      normalizeStopName(
        selectedStop?.stop_name
      );

    const destinationName =
      normalizeDirectionText(
        destination
      );

    return (
      !!selectedName
      && !!destinationName
      && selectedName
        === destinationName
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

    const byDirection =
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

      const directionKeyFull =
        `${routeId}|${directionKey}`;

      if (
        !byDirection.has(
          directionKeyFull
        )
      ) {
        byDirection.set(
          directionKeyFull,
          {
            routeId,
            route,
            directionKey,
            direction,
            meta,
            timestamps: []
          }
        );
      }

      const target =
        byDirection.get(
          directionKeyFull
        );

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

        let timestamp =
          gtfsSecondsToTodayTimestamp(
            seconds
          );

        if (
          timestamp
          < nowTimestamp
        ) {
          timestamp += 86400;
        }

        target.timestamps.push(
          timestamp
        );
      }
    }

    const result = [];

    for (
      const target
      of byDirection.values()
    ) {
      const unique =
        [...new Set(
          target.timestamps
        )]
          .sort(
            (a, b) => a - b
          )
          .slice(0, 3);

      if (!unique.length) {
        continue;
      }

      result.push({
        route_id:
          target.routeId,
        route_ref:
          target.meta.number
          || target.route.route_short_name
          || "—",
        destination:
          target.direction
            ?.destination
          || target.direction
            ?.headsign
          || "",
        times:
          unique.map(
            timestamp => ({
              timestamp,
              delay: null,
              scheduled: true,
              source: "static"
            })
          ),
        meta: target.meta
      });
    }

    return result;
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
    const scheduled =
      Number(
        time?.scheduled_time
      );

    if (
      Number.isFinite(
        scheduled
      )
    ) {
      return scheduled;
    }

    const actual =
      Number(
        time?.timestamp
      );

    const delay =
      Number(
        time?.delay
      );

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
        of realtimeRoute?.times || []
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

    const horizonTimestamp =
      nowTimestamp
      + 2 * 60 * 60;

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

    // Prune once for the whole refresh rather than from inside every
    // individual schedule-row check.
    pruneConsumedRealtimeArrivals();

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

        let timestamp =
          gtfsSecondsToTodayTimestamp(
            seconds
          );

        if (
          timestamp < nowTimestamp
        ) {
          timestamp += 86400;
        }

        if (
          timestamp < nowTimestamp
          || timestamp
            > horizonTimestamp
        ) {
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
            direction?.destination
            || direction?.headsign
            || terminalStopId
          );

        const consumedKey =
          getConsumedRealtimeArrivalKey(
            selectedStop,
            routeId,
            destination,
            timestamp
          );

        if (
          consumedKey
          && consumedRealtimeArrivals.has(
            consumedKey
          )
        ) {
          continue;
        }

        const groupKey =
          `${routeId}|${directionKey}|${terminalStopId}`;

        const existing =
          rowsByTerminal.get(
            groupKey
          );

        if (
          !existing
          || timestamp < existing.timestamp
        ) {
          rowsByTerminal.set(
            groupKey,
            {
              route,
              routeId,
              directionKey,
              direction,
              meta,
              terminalStopId,
              timestamp,
              schedule
            }
          );
        }
      }
    }

    return [
      ...rowsByTerminal.values()
    ]
      .map(row => {
        const isPartialCourse =
          !stopIdsMatch(
            row.terminalStopId,
            getDirectionTerminalStopId(
              row.direction
            )
          );

        const terminalStop =
          getStopById(
            row.terminalStopId
          );

        const destination =
          isPartialCourse
            ? (
                terminalStop?.stop_name
                || row.direction?.destination
                || row.direction?.headsign
                || ""
              )
            : (
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

    // The API already supports route_ids. Supplying only lines that actually
    // serve the selected stop keeps the active_trips portion of the response
    // much smaller and greatly reduces browser-side work.
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

              if (
                route.destination_stop_id
                && shouldHideTerminalArrival(
                  routeId,
                  route.destination_stop_id,
                  staticTrip,
                  route.destination
                    || "",
                  route.direction_id
                    || route.directionId
                    || ""
                )
              ) {
                return false;
              }

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

              const staticDirection =
                getStaticDirectionForTrip(
                  staticTrip
                )
                || resolveDirectionForRealtimeRoute(
                  routeId,
                  stop.stop_id,
                  staticTrip,
                  route.destination
                    || "",
                  route.direction_id
                    || route.directionId
                    || ""
                );

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
                  route.destination_stop_id
                  || "",
                destination:
                  route.destination
                  || staticTrip?.trip_headsign
                  || staticDirection?.destination
                  || staticDirection?.headsign
                  || "",
                times:
                  route.times
                    .map(
                      time => ({
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
                          Number.isFinite(
                            Number(
                              time?.scheduled_time
                            )
                          )
                            ? Number(
                                time?.scheduled_time
                              )
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
        isPartialRealtime
          ? (
              realtimeTerminal?.stop_name
              || route.destination
              || staticTrip?.trip_headsign
              || staticDirection?.destination
              || staticDirection?.headsign
              || ""
            )
          : (
              staticDirection?.destination
              || staticDirection?.headsign
              || route.destination
              || staticTrip?.trip_headsign
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
            route.times
              .sort(
                (a, b) =>
                  Number(a.timestamp)
                  - Number(b.timestamp)
              )
              .filter(
                (
                  time,
                  index,
                  list
                ) =>
                  index === 0
                  || Number(
                      time.timestamp
                    )
                    !== Number(
                      list[
                        index - 1
                      ].timestamp
                    )
              )
              .slice(0, 3)
        }))
        .filter(
          route =>
            route.times.length
        );

    rememberConsumedRealtimeArrivals(
      stop,
      mergedSurfaceRoutes
    );

    const scheduledSurfaceRoutes =
      isMetroStop(stop)
        ? []
        : getSurfaceScheduledArrivals(
            stop,
            skippedTrips
          );

    function directionPatternsShareLongPrefix(
      shortDirection,
      longDirection,
      selectedStopId
    ) {
      const shortPattern =
        Array.isArray(
          shortDirection?.pattern
        )
          ? shortDirection.pattern.map(
              String
            )
          : [];

      const longPattern =
        Array.isArray(
          longDirection?.pattern
        )
          ? longDirection.pattern.map(
              String
            )
          : [];

      if (
        !shortPattern.length
        || shortPattern.length
          >= longPattern.length
      ) {
        return false;
      }

      let commonPrefix = 0;

      while (
        commonPrefix
          < shortPattern.length
        && commonPrefix
          < longPattern.length
        && stopIdsMatch(
          shortPattern[
            commonPrefix
          ],
          longPattern[
            commonPrefix
          ]
        )
      ) {
        commonPrefix++;
      }

      const shortRatio =
        commonPrefix
        / shortPattern.length;

      const longRatio =
        commonPrefix
        / longPattern.length;

      if (
        commonPrefix < 5
        || shortRatio < 0.8
        || longRatio < 0.7
      ) {
        return false;
      }

      const shortStopIndex =
        shortPattern.findIndex(
          id =>
            stopIdsMatch(
              id,
              selectedStopId
            )
        );

      const longStopIndex =
        longPattern.findIndex(
          id =>
            stopIdsMatch(
              id,
              selectedStopId
            )
        );

      if (
        shortStopIndex < 0
        || longStopIndex < 0
      ) {
        return false;
      }

      return (
        commonPrefix
        > Math.max(
          shortStopIndex,
          longStopIndex
        )
      );
    }

    function realtimeOverridesScheduledDirection(
      realtimeRoute,
      scheduledRoute,
      selectedStopId
    ) {
      const routeId =
        String(
          scheduledRoute?.route_id
          || ""
        );

      if (
        !routeId
        || routeId
          !== String(
            realtimeRoute?.route_id
            || ""
          )
      ) {
        return false;
      }

      const realtimeDirectionKey =
        String(
          realtimeRoute
            ?.direction_key
          || ""
        ).trim();

      const scheduledDirectionKey =
        String(
          scheduledRoute
            ?.direction_key
          || ""
        ).trim();

      if (
        realtimeDirectionKey
        && scheduledDirectionKey
        && realtimeDirectionKey
          === scheduledDirectionKey
      ) {
        return true;
      }

      if (
        !realtimeDirectionKey
        || !scheduledDirectionKey
      ) {
        return false;
      }

      const directionSet =
        transportData
          ?.directions?.[
            routeId
          ] || {};

      const shortDirection =
        directionSet[
          realtimeDirectionKey
        ];

      const longDirection =
        directionSet[
          scheduledDirectionKey
        ];

      if (
        !shortDirection
        || !longDirection
      ) {
        return false;
      }

      if (
        !directionPatternsShareLongPrefix(
          shortDirection,
          longDirection,
          selectedStopId
        )
      ) {
        return false;
      }

      const realtimeTerminalId =
        String(
          realtimeRoute
            ?.destination_stop_id
          || ""
        ).trim();

      const realtimeDestinationKey =
        normalizeDirectionText(
          realtimeRoute
            ?.destination
          || ""
        );

      const shortDestinationKey =
        normalizeDirectionText(
          shortDirection?.destination
          || shortDirection?.headsign
          || ""
        );

      return (
        (
          !!realtimeTerminalId
          && isTerminalDirectionForStop(
            routeId,
            realtimeTerminalId,
            shortDirection
          )
        )
        || (
          !!shortDestinationKey
          && realtimeDestinationKey
            === shortDestinationKey
        )
      );
    }

    function activeShortDirectionOverridesScheduledDirection(
      scheduledRoute,
      activeDirections
    ) {
      const routeId =
        String(
          scheduledRoute?.route_id
          || ""
        ).trim();

      const scheduledDirectionKey =
        String(
          scheduledRoute?.direction_key
          || ""
        ).trim();

      if (
        !routeId
        || !scheduledDirectionKey
      ) {
        return false;
      }

      const directionSet =
        transportData
          ?.directions?.[
            routeId
          ] || {};

      const longDirection =
        directionSet[
          scheduledDirectionKey
        ];

      if (!longDirection) {
        return false;
      }

      for (
        const activeDirection
        of activeDirections
      ) {
        if (
          String(
            activeDirection?.route_id
            || ""
          ).trim()
          !== routeId
        ) {
          continue;
        }

        const shortDirectionKey =
          String(
            activeDirection?.key
            || ""
          ).trim();

        if (
          !shortDirectionKey
          || shortDirectionKey
            === scheduledDirectionKey
        ) {
          continue;
        }

        const shortDirection =
          directionSet[
            shortDirectionKey
          ];

        if (!shortDirection) {
          continue;
        }

        const shortPattern =
          Array.isArray(
            shortDirection?.pattern
          )
            ? shortDirection.pattern.map(
                String
              )
            : [];

        const longPattern =
          Array.isArray(
            longDirection?.pattern
          )
            ? longDirection.pattern.map(
                String
              )
            : [];

        if (
          !shortPattern.length
          || shortPattern.length
            >= longPattern.length
        ) {
          continue;
        }

        let commonPrefix = 0;

        while (
          commonPrefix
            < shortPattern.length
          && commonPrefix
            < longPattern.length
          && stopIdsMatch(
            shortPattern[
              commonPrefix
            ],
            longPattern[
              commonPrefix
            ]
          )
        ) {
          commonPrefix++;
        }

        let commonSuffix = 0;

        while (
          commonSuffix
            < shortPattern.length
          && commonSuffix
            < longPattern.length
          && stopIdsMatch(
            shortPattern[
              shortPattern.length
              - 1
              - commonSuffix
            ],
            longPattern[
              longPattern.length
              - 1
              - commonSuffix
            ]
          )
        ) {
          commonSuffix++;
        }

        const prefixShortRatio =
          commonPrefix
          / shortPattern.length;

        const prefixLongRatio =
          commonPrefix
          / longPattern.length;

        const suffixShortRatio =
          commonSuffix
          / shortPattern.length;

        const suffixLongRatio =
          commonSuffix
          / longPattern.length;

        const prefixMatch =
          commonPrefix >= 5
          && prefixShortRatio >= 0.8
          && prefixLongRatio >= 0.7
          && commonPrefix
            < shortPattern.length;

        const suffixMatch =
          commonSuffix >= 5
          && suffixShortRatio >= 0.8
          && suffixLongRatio >= 0.7
          && commonSuffix
            < shortPattern.length;

        if (
          !prefixMatch
          && !suffixMatch
        ) {
          continue;
        }

        return true;
      }

      return false;
    }

    const realtimeLogicalRoutes =
      mergedSurfaceRoutes.filter(
        route =>
          String(
            route.direction_key
            || ""
          ).trim()
      );

    const activeDirections = [];
    const seenActiveDirectionKeys =
      new Set();

    const activeTripRecords =
      Array.isArray(
        data?.active_trips
      )
        ? data.active_trips
        : (
          Array.isArray(
            data?.active_trip_ids
          )
            ? data.active_trip_ids.map(
                tripId => ({
                  trip_id: tripId,
                  schedule_relationship_name:
                    "SCHEDULED"
                })
              )
            : []
        );

    for (
      const activeTrip
      of activeTripRecords
    ) {
      const activeTripId =
        String(
          activeTrip?.trip_id
          || ""
        ).trim();

      if (!activeTripId) {
        continue;
      }

      const relationship =
        String(
          activeTrip
            ?.schedule_relationship_name
          || "SCHEDULED"
        ).toUpperCase();

      if (
        relationship === "CANCELED"
        || relationship === "DELETED"
      ) {
        continue;
      }

      const staticTrip =
        findStaticTrip(
          activeTripId
        );

      const activeRouteId =
        String(
          activeTrip?.route_id
          || staticTrip?.route_id
          || ""
        ).trim();

      if (!activeRouteId) {
        continue;
      }

      const destinationStop =
        getStopById(
          activeTrip
            ?.destination_stop_id
        );

      const activeDirection =
        getStaticDirectionForTrip(
          staticTrip
        )
        || resolveDirectionForRealtimeRoute(
          activeRouteId,
          stop.stop_id,
          null,
          destinationStop
            ?.stop_name
            || "",
          activeTrip
            ?.direction_id
            || ""
        );

      if (!activeDirection?.key) {
        continue;
      }

      const activeKey =
        `${activeRouteId}|${
          String(
            activeDirection.key
          )
        }`;

      if (
        seenActiveDirectionKeys.has(
          activeKey
        )
      ) {
        continue;
      }

      seenActiveDirectionKeys.add(
        activeKey
      );

      activeDirections.push({
        route_id:
          activeRouteId,
        key:
          String(
            activeDirection.key
          ),
        trip_id:
          activeTripId,
        schedule_relationship:
          relationship
      });
    }

    const surfaceFallbackRoutes =
      scheduledSurfaceRoutes.filter(
        route => {
          /*
           * IMPORTANT:
           * Compare the static course against the RAW realtime routes before
           * the realtime routes are grouped by destination.
           *
           * This is the final guard against the exact problem we are fixing:
           * one physical trip appearing once as realtime and again as static.
           */
          if (
            staticArrivalIsCoveredByRealtime(
              route,
              realtime.routes
            )
          ) {
            return false;
          }

          if (
            realtimeLogicalRoutes.some(
              realtimeRoute =>
                realtimeOverridesScheduledDirection(
                  realtimeRoute,
                  route,
                  stop.stop_id
                )
            )
          ) {
            return false;
          }

          if (
            activeShortDirectionOverridesScheduledDirection(
              route,
              activeDirections
            )
          ) {
            return false;
          }

          return shouldUseStaticFallbackForDirection(
            route,
            {
              realtimeRoutes:
                mergedSurfaceRoutes,
              activeDirections
            }
          );
        }
      );

    const fallbackByKey =
      new Map();

    for (
      const route
      of surfaceFallbackRoutes
    ) {
      /*
       * Keep the guard here as well. This is deliberately redundant with the
       * filter above so a later change to the fallback grouping cannot
       * accidentally reintroduce a realtime/static duplicate.
       */
      if (
        staticArrivalIsCoveredByRealtime(
          route,
          realtime.routes
        )
      ) {
        continue;
      }

      const destinationKey =
        normalizeDirectionText(
          route.destination
          || ""
        );

      const key =
        `${String(
          route.route_id
          || ""
        )}|${destinationKey}|${
          String(
            route.route_ref
            || ""
          )
        }`;

      const existing =
        fallbackByKey.get(key);

      if (
        !existing
        || Number(
          route.times?.[0]?.timestamp
        )
        < Number(
          existing.times?.[0]?.timestamp
        )
      ) {
        fallbackByKey.set(
          key,
          route
        );
      }
    }

    const surfaceRoutes =
      [
        ...mergedSurfaceRoutes,
        ...fallbackByKey.values()
      ]
        .sort(
          (a, b) =>
            Number(
              a.times?.[0]?.timestamp
            )
            - Number(
              b.times?.[0]?.timestamp
            )
        );

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
              .slice(0, 3)
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
              .slice(1, 3)
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
  function shouldUseStaticFallbackForDirection(
    scheduledRoute,
    {
      realtimeRoutes = [],
      activeDirections = []
    } = {}
  ) {
    const routeId =
      String(
        scheduledRoute?.route_id
        || ""
      ).trim();

    const directionKey =
      String(
        scheduledRoute
          ?.direction_key
        || ""
      ).trim();

    if (!routeId) {
      return true;
    }

    if (directionKey) {
      const realtimeMatch =
        realtimeRoutes.some(
          route =>
            String(
              route?.route_id
              || ""
            ).trim()
            === routeId
            && String(
              route?.direction_key
              || ""
            ).trim()
            === directionKey
        );

      if (realtimeMatch) {
        return false;
      }

      const activeMatch =
        activeDirections.some(
          direction =>
            String(
              direction?.route_id
              || ""
            ).trim()
            === routeId
            && String(
              direction?.key
              || ""
            ).trim()
            === directionKey
        );

      return !activeMatch;
    }

    const destinationKey =
      normalizeDirectionText(
        scheduledRoute?.destination
        || ""
      );

    if (!destinationKey) {
      return true;
    }

    return !realtimeRoutes.some(
      route =>
        String(
          route?.route_id
          || ""
        ).trim()
        === routeId
        && normalizeDirectionText(
          route?.destination
          || ""
        )
          === destinationKey
    );
  }

  globalThis.__gtsofiaVirtualBoardTestInternals = {
    isServiceActiveOnDate,
    isScheduleRowActiveToday,
    getSofiaDateKey,
    shouldUseStaticFallbackForDirection,
    staticArrivalIsCoveredByRealtime,
    getRealtimeScheduledTimestamp
  };
})();
