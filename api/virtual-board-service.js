const routesData = require('../data/routes.json');
const directionsData = require('../data/directions.json');
const schedulesData = require('../data/schedules.json');
const stopsData = require('../data/stops.json');
const calendarData = require('../data/calendar.json');
const { getRouteMetadata } = require('../route-metadata');

const SOFIA_TIME_ZONE = 'Europe/Sofia';
const MAX_ARRIVALS_PER_LINE = 3;

function normalizeStopKey(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const withoutMetroPrefix = raw.replace(/^M/i, '');
  const digits = withoutMetroPrefix.replace(/\D/g, '');
  return digits ? String(Number(digits)) : withoutMetroPrefix.toLowerCase();
}

function stopIdsMatch(left, right) {
  const a = normalizeStopKey(left);
  return !!a && a === normalizeStopKey(right);
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

function parseGtfsTime(value) {
  const match = String(value ?? '').trim().match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!match) return null;

  const [hour, minute, second] = match.slice(1).map(Number);
  if (minute > 59 || second > 59) return null;
  return hour * 3600 + minute * 60 + second;
}

function getSofiaDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SOFIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day'))
  };
}

function getSofiaDateKey(date) {
  const { year, month, day } = getSofiaDateParts(date);
  if (![year, month, day].every(Number.isFinite)) return '';

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getSofiaOffsetMs(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SOFIA_TIME_ZONE,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const raw = parts.find(part => part.type === 'timeZoneName')?.value || 'GMT+0';
  const match = raw.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return 0;

  const sign = match[1] === '+' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0)) * 60 * 1000;
}

function gtfsSecondsToTodayTimestamp(seconds, date) {
  const { year, month, day } = getSofiaDateParts(date);
  const baseUtc = Date.UTC(year, month - 1, day);
  return (baseUtc + Number(seconds) * 1000 - getSofiaOffsetMs(new Date(baseUtc))) / 1000;
}

function getScheduleDayType(date, calendar = calendarData) {
  const dateKey = getSofiaDateKey(date);
  const configured = calendar?.dateTypes?.[dateKey]
    || calendar?.config?.dateOverrides?.[dateKey];
  if (configured === 'weekday' || configured === 'weekend') return configured;

  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: SOFIA_TIME_ZONE,
    weekday: 'short'
  }).format(date);
  return weekday === 'Sat' || weekday === 'Sun' ? 'weekend' : 'weekday';
}

function isServiceActive(serviceId, date, calendar = calendarData) {
  const id = String(serviceId ?? '').trim();
  if (!id) return true;

  const dateKey = getSofiaDateKey(date);
  const byDate = calendar?.serviceIdsByDate;
  if (byDate && typeof byDate === 'object') {
    const ids = byDate[dateKey];
    return Array.isArray(ids) && ids.some(value => String(value).trim() === id);
  }

  const compactDate = dateKey.replaceAll('-', '');
  const weekdayField = new Intl.DateTimeFormat('en-US', {
    timeZone: SOFIA_TIME_ZONE,
    weekday: 'long'
  }).format(date).toLowerCase();
  const pattern = (calendar?.servicePatterns || []).find(row => String(row?.service_id || '').trim() === id);
  let active = false;

  if (pattern) {
    active = compactDate >= String(pattern.start_date || '')
      && compactDate <= String(pattern.end_date || '')
      && String(pattern[weekdayField] || '') === '1';
  }

  for (const exception of calendar?.exceptions || []) {
    if (
      String(exception?.service_id || '').trim() === id
      && String(exception?.date || '').trim() === compactDate
    ) {
      if (String(exception.exception_type) === '1') active = true;
      if (String(exception.exception_type) === '2') active = false;
    }
  }

  return active;
}

function createRouteMetadata(route) {
  return getRouteMetadata(route);
}

function createDataContext(data = {}) {
  const routes = data.routes || routesData;
  const directions = data.directions || directionsData;
  const schedules = data.schedules || schedulesData;
  const stops = data.stops || stopsData;
  const calendar = data.calendar || calendarData;

  const routeById = new Map(routes.map(route => [String(route.route_id), route]));
  const stopById = new Map();
  const stopByCode = new Map();

  for (const stop of stops) {
    const id = String(stop?.stop_id || '').trim();
    const code = String(stop?.stop_code || '').trim();
    if (id) stopById.set(id, stop);
    if (code && !stopByCode.has(code)) stopByCode.set(code, stop);
  }

  function getStop(stopId) {
    const raw = String(stopId ?? '').trim();
    return stopById.get(raw)
      || stopByCode.get(raw)
      || stops.find(stop => stopIdsMatch(stop?.stop_id, raw) || stopIdsMatch(stop?.stop_code, raw))
      || null;
  }

  function getDestinationName(stopId, direction, fallback = '') {
    const stop = getStop(stopId);
    const directionStops = Array.isArray(direction?.stops) ? direction.stops : [];
    const directionStop = stopId
      ? directionStops.find(item => stopIdsMatch(item?.stop_id, stopId))
      : directionStops[directionStops.length - 1];

    const osmName = String(
      stop?.osm_stop_name
      || directionStop?.osm_name
      || (stop?.stop_name_source === 'osm' ? stop?.stop_name : '')
      || ''
    ).trim();
    if (osmName) return osmName;

    return String(
      direction?.destination
      || direction?.headsign
      || stop?.stop_name
      || fallback
      || ''
    ).trim();
  }

  function findDirection(routeId, stopId, destination = '', directionId = '') {
    const routeDirections = directions?.[String(routeId)] || {};
    const candidates = Object.entries(routeDirections)
      .filter(([, direction]) => Array.isArray(direction?.pattern)
        && direction.pattern.some(id => stopIdsMatch(id, stopId)))
      .map(([key, direction]) => ({ key, ...direction }));

    if (!candidates.length) return null;
    const wantedDestination = normalizeDirectionText(destination);
    if (wantedDestination) {
      const match = candidates.find(direction => normalizeDirectionText(direction.headsign || direction.destination) === wantedDestination);
      if (match) return match;
    }

    const wantedDirectionId = String(directionId ?? '').trim();
    if (wantedDirectionId) {
      const match = candidates.find(direction => String(direction.direction_id ?? direction.key ?? '').trim() === wantedDirectionId);
      if (match) return match;
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  function findStaticScheduleInfo(routeId, originalTripId, dayType) {
    const routeSchedules = schedules?.[String(routeId)] || {};
    const routeDirections = directions?.[String(routeId)] || {};
    const dayOrder = [dayType, dayType === 'weekday' ? 'weekend' : 'weekday'];

    for (const currentDayType of dayOrder) {
      for (const [directionKey, daySchedules] of Object.entries(routeSchedules)) {
        const rows = Array.isArray(daySchedules?.[currentDayType]) ? daySchedules[currentDayType] : [];
        const schedule = rows.find(row => String(row?.original_trip_id ?? '').trim() === String(originalTripId ?? '').trim());
        if (!schedule) continue;

        const direction = routeDirections[directionKey];
        const pattern = Array.isArray(direction?.pattern) ? direction.pattern.map(String) : [];
        if (!pattern.length) continue;

        const times = Array.isArray(schedule.times) ? schedule.times : [];
        let terminalIndex = -1;
        for (let index = Math.min(times.length, pattern.length) - 1; index >= 0; index--) {
          if (parseGtfsTime(times[index]) != null) {
            terminalIndex = index;
            break;
          }
        }
        const terminalStopId = terminalIndex >= 0 ? String(pattern[terminalIndex] || '').trim() : '';
        if (!terminalStopId) continue;

        return { directionKey, direction: { key: directionKey, ...direction }, schedule, terminalIndex, terminalStopId };
      }
    }

    return null;
  }

  function isSkipped(schedule, routeId, stopId, stopIndex, skippedTrips) {
    const originalTripId = String(schedule?.original_trip_id || '').trim();
    const stopSequence = Number(schedule?.stop_sequences?.[stopIndex]);

    return skippedTrips.some(skipped => {
      if (!skipped) return false;
      if (String(skipped.route_id || '').trim() !== String(routeId).trim()) return false;

      const skippedStopId = String(skipped.stop_id || '').trim();
      if (skippedStopId) {
        if (!stopIdsMatch(skippedStopId, stopId)) return false;
      } else {
        const skippedSequence = Number(skipped.stop_sequence);
        if (!Number.isFinite(skippedSequence) || !Number.isFinite(stopSequence) || skippedSequence !== stopSequence) return false;
      }

      return !!originalTripId && String(skipped.trip_id || '').trim() === originalTripId;
    });
  }

  function getStaticArrivals(stopId, isMetro, skippedTrips, now) {
    const dateKey = getSofiaDateKey(now);
    const dayType = getScheduleDayType(now, calendar);
    const nowTimestamp = now.getTime() / 1000;
    const result = [];

    for (const route of routes) {
      const routeId = String(route?.route_id || '').trim();
      if (!routeId) continue;

      const routeIsMetro = String(route.route_type) === '1';
      if (routeIsMetro !== isMetro) continue;

      const routeDirections = directions?.[routeId] || {};
      const routeSchedules = schedules?.[routeId] || {};
      const meta = createRouteMetadata(route);

      for (const [directionKey, direction] of Object.entries(routeDirections)) {
        const pattern = Array.isArray(direction?.pattern) ? direction.pattern.map(String) : [];
        if (!pattern.length) continue;

        const stopIndex = pattern.findIndex(id => stopIdsMatch(id, stopId));
        if (stopIndex < 0) continue;

        const dayRows = routeSchedules?.[directionKey]?.[dayType];
        if (!Array.isArray(dayRows)) continue;

        for (const schedule of dayRows) {
          const serviceId = String(schedule?.service_id || direction?.service_id || '').trim();
          if (serviceId && !isServiceActive(serviceId, now, calendar)) continue;

          const seconds = parseGtfsTime(schedule?.times?.[stopIndex]);
          if (seconds == null) continue;

          const times = Array.isArray(schedule?.times) ? schedule.times : [];
          let terminalIndex = -1;
          for (let index = Math.min(times.length, pattern.length) - 1; index >= 0; index--) {
            if (parseGtfsTime(times[index]) != null) {
              terminalIndex = index;
              break;
            }
          }
          if (terminalIndex < stopIndex) continue;

          const terminalStopId = String(pattern[terminalIndex] || '').trim();
          if (!terminalStopId || isSkipped(schedule, routeId, stopId, stopIndex, skippedTrips)) continue;

          const timestamp = gtfsSecondsToTodayTimestamp(seconds, now);
          if (timestamp < nowTimestamp) continue;

          result.push({
            route_id: routeId,
            direction_key: directionKey,
            terminal_stop_id: terminalStopId,
            destination: getDestinationName(
              terminalStopId,
              direction,
              direction?.destination || direction?.headsign || terminalStopId
            ),
            route_ref: meta?.number || route.route_short_name || '—',
            meta,
            original_trip_id: String(schedule?.original_trip_id || '').trim(),
            static_trip_id: String(schedule?.trip_id ?? '').trim(),
            trip_start_time: String(schedule?.start_time || '').trim(),
            times: [{ timestamp, delay: null, scheduled: true, source: 'static' }],
            scheduled: true,
            source: 'static'
          });
        }
      }
    }

    return result;
  }

  function realtimeScheduledTimestamp(time) {
    const scheduled = Number(time?.scheduled_time);
    if (time?.scheduled_time !== null && time?.scheduled_time !== undefined && String(time.scheduled_time).trim() !== '' && Number.isFinite(scheduled)) {
      return scheduled;
    }

    const actual = Number(time?.timestamp);
    const delay = Number(time?.delay);
    return Number.isFinite(actual) && Number.isFinite(delay) ? actual - delay : null;
  }

  function staticArrivalIsCovered(staticArrival, realtimeRoutes) {
    const routeId = String(staticArrival?.route_id || '').trim();
    const staticTimestamp = Number(staticArrival?.times?.[0]?.timestamp);
    if (!routeId || !Number.isFinite(staticTimestamp)) return false;

    const staticTripIds = new Set([
      staticArrival?.original_trip_id,
      staticArrival?.static_trip_id,
      staticArrival?.trip_id
    ].map(value => String(value ?? '').trim()).filter(Boolean));
    const staticTerminalId = String(staticArrival?.terminal_stop_id || '').trim();

    for (const realtime of realtimeRoutes) {
      if (String(realtime?.route_id || '').trim() !== routeId) continue;
      const times = Array.isArray(realtime?.times) ? realtime.times.filter(time => Number.isFinite(Number(time?.timestamp))) : [];
      if (!times.length) continue;

      const realtimeTripId = String(realtime?.trip_id || '').trim();
      if (realtimeTripId) {
        // A supplied Trip ID is authoritative. Never hide a different static
        // course based only on a nearby time or matching destination.
        if (staticTripIds.has(realtimeTripId)) return true;
        continue;
      }

      const realtimeTerminalId = String(realtime?.destination_stop_id || '').trim();

      for (const time of times) {
        const scheduled = realtimeScheduledTimestamp(time);
        if (!Number.isFinite(scheduled) || Math.abs(staticTimestamp - scheduled) > 1) continue;

        // Without a Trip ID, suppress a static course only when both its
        // scheduled stop time and terminal stop ID match exactly. A fuzzy
        // two-minute match or matching text/direction can hide another trip.
        if (
          staticTerminalId
          && realtimeTerminalId
          && stopIdsMatch(staticTerminalId, realtimeTerminalId)
        ) {
          return true;
        }
      }
    }

    return false;
  }

  function mergeRoutes(routes) {
    const grouped = new Map();

    for (const route of routes) {
      const routeId = String(route?.route_id || '').trim();
      const terminalStopId = String(route?.terminal_stop_id || route?.destination_stop_id || '').trim();
      const destinationKey = terminalStopId
        ? `stop:${normalizeStopKey(terminalStopId)}`
        : `name:${normalizeDirectionText(route?.destination || route?.headsign || '')}`;
      const key = `${routeId}|${destinationKey}`;
      const times = Array.isArray(route?.times) ? route.times : [];
      if (!grouped.has(key)) {
        grouped.set(key, { ...route, times: [...times] });
        continue;
      }

      const existing = grouped.get(key);
      existing.times.push(...times);
      if ((!existing.route_ref || existing.route_ref === '—') && route?.route_ref && route.route_ref !== '—') {
        existing.route_ref = route.route_ref;
      }
      if (!existing.meta && route?.meta) existing.meta = route.meta;
      if (route?.realtime && !existing.realtime) {
        grouped.set(key, { ...route, route_ref: existing.route_ref || route.route_ref, meta: route.meta || existing.meta, times: existing.times });
      }
    }

    return [...grouped.values()]
      .map(route => {
        const seen = new Set();
        const times = (route.times || [])
          .filter(time => time?.timestamp !== null && time?.timestamp !== undefined && Number.isFinite(Number(time.timestamp)))
          .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
          .filter(time => {
            const timestamp = Number(time.timestamp);
            if (seen.has(timestamp)) return false;
            seen.add(timestamp);
            return true;
          })
          .slice(0, MAX_ARRIVALS_PER_LINE);
        return { ...route, times };
      })
      .filter(route => route.times.length)
      .sort((a, b) => Number(a.times[0].timestamp) - Number(b.times[0].timestamp));
  }

  function buildBoard(realtimeBoard, stopCode, now = new Date()) {
    const rawCode = String(stopCode ?? '').trim();
    const selectedStop = stopById.get(rawCode) || stopByCode.get(rawCode) || getStop(rawCode);
    const selectedStopId = String(selectedStop?.stop_id || rawCode).trim();
    if (!selectedStopId) return { status: 'empty', stop_code: rawCode, generated_at: realtimeBoard?.generated_at || null, routes: [] };

    const isMetro = /^M/i.test(selectedStopId) || /^M/i.test(String(selectedStop?.stop_code || ''));
    const rawRealtimeRoutes = isMetro ? [] : (Array.isArray(realtimeBoard?.routes) ? realtimeBoard.routes : []);
    const realtimeRoutes = [];
    const dayType = getScheduleDayType(now, calendar);

    for (const route of rawRealtimeRoutes) {
      const routeId = String(route?.route_id || '').trim();
      if (!routeId || !Array.isArray(route?.times) || !route.times.length) continue;
      const staticInfo = findStaticScheduleInfo(routeId, route.trip_id, dayType);
      const direction = staticInfo?.direction || findDirection(
        routeId,
        selectedStopId,
        route?.destination || '',
        route?.direction_id || route?.directionId || ''
      );
      const relationshipName = String(route?.schedule_relationship_name || '').trim().toUpperCase();
      const relationship = Number(route?.schedule_relationship);
      const isScheduled = relationshipName
        ? relationshipName === 'SCHEDULED'
        : (!Number.isFinite(relationship) || relationship === 0);
      const terminalStopId = (isScheduled && staticInfo?.terminalStopId)
        ? staticInfo.terminalStopId
        : (String(route?.destination_stop_id || '').trim()
          || staticInfo?.terminalStopId
          || String(direction?.pattern?.[direction.pattern.length - 1] || '').trim());
      const meta = createRouteMetadata(routeById.get(routeId)) || {
        id: routeId,
        number: String(route?.route_ref || '—'),
        type: 'bus',
        subtype: '',
        icon: '',
        color: '#BE1E2D',
        textColor: '#FFFFFF'
      };
      const destination = getDestinationName(
        terminalStopId,
        direction,
        route?.destination || direction?.destination || direction?.headsign || ''
      );

      realtimeRoutes.push({
        ...route,
        route_id: routeId,
        route_ref: meta.number,
        meta,
        direction_key: staticInfo?.directionKey || direction?.key || '',
        terminal_stop_id: terminalStopId,
        destination_stop_id: terminalStopId,
        destination,
        realtime: true,
        scheduled: false,
        source: 'realtime',
        times: route.times.map(time => ({
          timestamp: Number(time?.timestamp),
          delay: time?.delay !== null && time?.delay !== undefined && Number.isFinite(Number(time.delay)) ? Number(time.delay) : null,
          scheduled: false,
          source: 'realtime',
          scheduled_time: Number.isFinite(Number(time?.scheduled_time)) ? Number(time.scheduled_time) : null,
          stop_schedule_relationship: Number(time?.stop_schedule_relationship),
          stop_schedule_relationship_name: String(time?.stop_schedule_relationship_name || 'SCHEDULED')
        })).filter(time => Number.isFinite(time.timestamp))
      });
    }

    const staticArrivals = getStaticArrivals(selectedStopId, isMetro, realtimeBoard?.skipped_trips || [], now)
      .filter(route => !staticArrivalIsCovered(route, realtimeRoutes));

    const routes = mergeRoutes([...realtimeRoutes, ...staticArrivals]);
    return {
      status: routes.length ? 'ok' : 'empty',
      stop_code: rawCode,
      generated_at: realtimeBoard?.generated_at || Math.floor(now.getTime() / 1000),
      routes
    };
  }

  return { buildBoard };
}

const defaultService = createDataContext();

function buildVirtualBoard(realtimeBoard, stopCode, now = new Date()) {
  return defaultService.buildBoard(realtimeBoard, stopCode, now);
}

module.exports = {
  buildVirtualBoard,
  createDataContext
};
