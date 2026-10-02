const TRANSPORT_TIME_ZONE = 'Europe/Sofia';

let transportDataPromise = null;

function fetchJson(name) {
  return fetch(`./data/${name}.json`, { cache: 'no-store' }).then(response => {
    if (!response.ok) {
      throw new Error(`Неуспешно зареждане на ${name}.json: ${response.status}`);
    }
    return response.json();
  });
}

function formatGtfsMinutes(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const total = Math.max(0, Math.floor(number));
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${hour}:${String(minute).padStart(2, '0')}:00`;
}

function routeTypeCode(type) {
  switch (String(type || '').toLowerCase()) {
    case 'tram': return '0';
    case 'metro': return '1';
    case 'trolley': return '11';
    case 'trolleybus': return '11';
    case 'bus': return '3';
    default: return '3';
  }
}

function buildLegacyStops(stops) {
  return (stops || []).map(stop => {
    const code = String(stop?.code ?? '').trim();
    const bg = String(stop?.names?.bg ?? '').trim();
    const en = String(stop?.names?.en ?? '').trim();
    const lat = Number(stop?.coords?.[0]);
    const lon = Number(stop?.coords?.[1]);
    const metro = /^M/i.test(code);

    return {
      stop_id: code,
      stop_code: code,
      stop_name: bg,
      name: bg,
      stop_name_en: en,
      stop_lat: Number.isFinite(lat) ? String(lat) : '',
      stop_lon: Number.isFinite(lon) ? String(lon) : '',
      location_type: metro ? '0' : '0',
      coords: [lat, lon],
      names: { bg, en }
    };
  }).filter(stop => stop.stop_id);
}

function makeDirectionKey(code) {
  return `D${String(code)}`;
}

function buildLegacyDirections(routes, canonicalDirections, canonicalTrips, legacyStops) {
  const stopByCode = new Map(legacyStops.map(stop => [String(stop.stop_id), stop]));
  const directionByCode = new Map((canonicalDirections || []).map(direction => [String(direction.code), direction]));
  const tripsByRoute = new Map();

  for (const trip of canonicalTrips || []) {
    const routeId = String(trip?.cgm_id ?? '').trim();
    if (!routeId) continue;
    if (!tripsByRoute.has(routeId)) tripsByRoute.set(routeId, []);
    tripsByRoute.get(routeId).push(trip);
  }

  const result = {};

  for (const route of routes || []) {
    const routeId = String(route?.cgm_id ?? '').trim();
    if (!routeId) continue;

    const routeTrips = tripsByRoute.get(routeId) || [];
    const codes = [...new Set(routeTrips.map(trip => String(trip?.direction ?? '').trim()).filter(Boolean))];
    const directionSet = {};

    for (const code of codes) {
      const source = directionByCode.get(code);
      if (!source) continue;

      const pattern = (source.stops || []).map(value => String(value).trim()).filter(Boolean);
      const stops = pattern.map(codeValue => stopByCode.get(codeValue)).filter(Boolean);
      if (!stops.length) continue;

      const destination = stops[stops.length - 1]?.stop_name || '—';
      const matchingTrips = routeTrips.filter(trip => String(trip.direction ?? '') === code);
      const key = makeDirectionKey(code);

      directionSet[key] = {
        key,
        code,
        headsign: destination,
        destination,
        trip_id: matchingTrips.length ? String(matchingTrips[0].id) : '',
        trip_ids: matchingTrips.map(trip => String(trip.id)),
        direction_id: '',
        shape_id: '',
        service_id: '',
        frequency: null,
        stop_count: stops.length,
        stops,
        pattern
      };
    }

    result[routeId] = directionSet;
  }

  return result;
}

function buildLegacySchedules(canonicalTrips, canonicalStopTimes) {
  const stopTimesByTrip = new Map();
  for (const row of canonicalStopTimes || []) {
    const tripId = String(row?.trip ?? '').trim();
    if (!tripId) continue;
    if (!stopTimesByTrip.has(tripId)) stopTimesByTrip.set(tripId, []);
    stopTimesByTrip.get(tripId).push(row);
  }

  const schedules = {};

  for (const trip of canonicalTrips || []) {
    const routeId = String(trip?.cgm_id ?? '').trim();
    const directionCode = String(trip?.direction ?? '').trim();
    const directionKey = makeDirectionKey(directionCode);
    const dayType = trip?.is_weekend ? 'weekend' : 'weekday';
    if (!routeId || !directionCode) continue;

    if (!schedules[routeId]) schedules[routeId] = {};
    if (!schedules[routeId][directionKey]) {
      schedules[routeId][directionKey] = { weekday: [], weekend: [] };
    }

    const rows = stopTimesByTrip.get(String(trip.id)) || [];
    for (const row of rows) {
      const times = Array.isArray(row?.times) ? row.times.map(formatGtfsMinutes) : [];
      const firstTime = times.find(value => value) || '';

      schedules[routeId][directionKey][dayType].push({
        trip_id: String(trip.id),
        original_trip_id: String(trip.id),
        route_id: routeId,
        direction_id: directionKey,
        service_id: '',
        start_time: firstTime,
        times,
        car: String(row?.car ?? '').trim(),
        stop_sequences: times.map((_, index) => index + 1)
      });
    }
  }

  return schedules;
}

function buildLegacyRoutes(canonicalRoutes, directions) {
  return (canonicalRoutes || []).map(route => {
    const routeId = String(route?.cgm_id ?? '').trim();
    const type = String(route?.type ?? 'bus').trim();
    const directionSet = directions?.[routeId] || {};
    const destinationList = Object.values(directionSet)
      .map(direction => String(direction?.headsign || '').trim())
      .filter(Boolean);

    return {
      route_id: routeId,
      agency_id: 'A',
      route_short_name: String(route?.route_ref ?? '').trim(),
      route_long_name: destinationList.join(' - '),
      route_desc: '',
      route_type: routeTypeCode(type),
      route_url: '',
      route_color: route?.bg_color ? String(route.bg_color).replace(/^#/, '') : '',
      route_text_color: route?.text_color ? String(route.text_color).replace(/^#/, '') : 'FFFFFF',
      route_sort_order: '',
      continuous_pickup: '',
      continuous_drop_off: ''
    };
  });
}

function buildCanonicalAndLegacyModel({ routes, stops, directions, trips, stop_times, calendar, shapes, metadata, realtimeTripMap, lineOverrides }) {
  const legacyStops = buildLegacyStops(stops);
  const legacyDirections = buildLegacyDirections(routes, directions, trips, legacyStops);
  const legacyRoutes = buildLegacyRoutes(routes, legacyDirections);
  const legacyTrips = (trips || []).map(trip => {
    const routeId = String(trip?.cgm_id ?? '').trim();
    const directionKey = makeDirectionKey(trip?.direction);
    const direction = legacyDirections?.[routeId]?.[directionKey];
    return {
      trip_id: String(trip?.id ?? '').trim(),
      route_id: routeId,
      direction_id: directionKey,
      service_id: '',
      trip_headsign: direction?.headsign || '',
      shape_id: '',
      is_weekend: Boolean(trip?.is_weekend)
    };
  });

  const legacySchedules = buildLegacySchedules(trips, stop_times);

  const canonical = {
    routes: routes || [],
    stops: stops || [],
    directions: directions || [],
    trips: trips || [],
    stop_times: stop_times || [],
    calendar: calendar || {},
    shapes: shapes || {},
    metadata: metadata || {},
    realtimeTripMap: realtimeTripMap || {}
  };

  return {
    // Canonical split data remains the source of truth.
    canonical,

    // Legacy-shaped view model used only by the restored presentation layer.
    routes: legacyRoutes,
    stops: legacyStops,
    directions: legacyDirections,
    trips: legacyTrips,
    schedules: legacySchedules,
    calendar: calendar || {},
    shapes: shapes || {},
    metadata: metadata || {},
    realtimeTripMap: realtimeTripMap || {},
    lineOverrides: Array.isArray(lineOverrides) ? lineOverrides : []
  };
}

async function loadTransportData() {
  if (transportDataPromise) return transportDataPromise;

  const names = [
    'routes',
    'stops',
    'directions',
    'trips',
    'stop_times',
    'calendar',
    'shapes',
    'metadata',
    'realtime-trip-map'
  ];

  transportDataPromise = Promise.all([
    ...names.map(fetchJson),
    fetchJsonFromConfig('line-overrides')
  ])
    .then(values => {
      const data = {};
      names.forEach((name, index) => { data[name.replace('-', '_')] = values[index]; });
      const model = buildCanonicalAndLegacyModel({
        routes: data.routes,
        stops: data.stops,
        directions: data.directions,
        trips: data.trips,
        stop_times: data.stop_times,
        calendar: data.calendar,
        shapes: data.shapes,
        metadata: data.metadata,
        realtimeTripMap: data.realtime_trip_map,
        lineOverrides: values[names.length]
      });

      window.transportData = model;
      window.transportCanonicalData = model.canonical;

      console.log('Schedule routes:', model.canonical.routes.length);
      console.log('Schedule stops:', model.canonical.stops.length);
      console.log('Schedule directions:', model.canonical.directions.length);
      console.log('Logical trips:', model.canonical.trips.length);
      console.log('Stop-time rows:', model.canonical.stop_times.length);

      return model;
    })
    .catch(error => {
      transportDataPromise = null;
      throw error;
    });

  return transportDataPromise;
}

function fetchJsonFromConfig(name) {
  return fetch(`./config/${name}.json`, { cache: 'no-store' }).then(response => {
    if (!response.ok) return [];
    return response.json();
  });
}

function getTransportCalendarDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TRANSPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function getTransportCalendarWeekday(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TRANSPORT_TIME_ZONE,
    weekday: 'short'
  }).format(date);
}

function getTransportCalendarDayType(date = new Date()) {
  const key = getTransportCalendarDateKey(date);
  const calendar = window.transportData?.calendar || {};

  const configured = calendar?.config?.dateOverrides?.[key];
  if (configured === 'weekday' || configured === 'weekend') return configured;

  const calculated = calendar?.dateTypes?.[key];
  if (calculated === 'weekday' || calculated === 'weekend') return calculated;

  const weekday = getTransportCalendarWeekday(date);
  return weekday === 'Sat' || weekday === 'Sun' ? 'weekend' : 'weekday';
}

function getTransportType(routeType) {
  switch (String(routeType)) {
    case '0': return 'tram';
    case '1': return 'metro';
    case '3': return 'bus';
    case '11': return 'trolleybus';
    default:
      return ['tram', 'metro', 'bus', 'trolleybus', 'trolley', 'night'].includes(String(routeType))
        ? String(routeType)
        : 'other';
  }
}

function getLineOverride(route) {
  const routeId = String(route?.route_id || '').trim();
  const routeNumber = String(route?.route_short_name || '').trim();
  const overrides = Array.isArray(window.transportData?.lineOverrides)
    ? window.transportData.lineOverrides
    : [];

  return overrides.find(override =>
    String(override?.cgm_id || '').trim() === routeId ||
    (!override?.cgm_id && String(override?.route_ref || '').trim() === routeNumber)
  ) || null;
}

function getLineType(route) {
  const number = String(route?.route_short_name || route?.route_ref || '').trim().toUpperCase();
  const nightBusLines = new Set(['N1', 'N2', 'N3', 'N4']);
  if (nightBusLines.has(number)) return 'night';

  const override = getLineOverride(route);
  if (override?.type) return override.type;
  return getTransportType(route?.route_type ?? route?.type);
}

function getLineDisplayNumber(route, type = getLineType(route)) {
  const override = getLineOverride(route);
  const sourceNumber = String(route?.route_short_name || route?.route_ref || '').trim();
  if (override?.route_ref) return String(override.route_ref).trim();
  return type === 'metro'
    ? sourceNumber.replace(/^[МM]/i, '')
    : sourceNumber.replace(/^E(?=186$)/i, '');
}

function getTransportIcon(type, number) {
  const lineNumber = String(number || '').trim().toUpperCase();
  if (lineNumber === 'X43') return 'Icons/Active icons/torist-bus.svg';
  if (['N1', 'N2', 'N3', 'N4'].includes(lineNumber)) return 'Icons/Active icons/night-bus.svg';

  switch (type) {
    case 'bus': return 'Icons/Active icons/bus.svg';
    case 'night': return 'Icons/Active icons/night-bus.svg';
    case 'trolleybus':
    case 'trolley': return 'Icons/Active icons/trolley.svg';
    case 'tram': return 'Icons/Active icons/tram.svg';
    case 'metro': return 'Icons/Active icons/metro.svg';
    default: return '';
  }
}

function getLineColor(route, type) {
  const override = getLineOverride(route);
  if (override?.color) {
    return String(override.color).startsWith('#') ? String(override.color) : `#${override.color}`;
  }
  if (!override?.type && route?.route_color) return `#${route.route_color}`;

  switch (type) {
    case 'bus': return '#BE1E2D';
    case 'night': return '#BE1E2D';
    case 'tram': return '#F7941D';
    case 'trolleybus':
    case 'trolley': return '#27AAE1';
    case 'metro': return '#1C75BC';
    default: return '#BE1E2D';
  }
}

function convertGtfsRoutes(routes, trips, directionsData) {
  const activeRouteIds = new Set((trips || []).map(trip => String(trip?.route_id || '').trim()).filter(Boolean));

  return (routes || [])
    .filter(route => activeRouteIds.has(String(route?.route_id || '').trim()))
    .map(route => {
      const routeId = String(route.route_id || '').trim();
      const type = getLineType(route);
      const directionSource = directionsData?.[routeId] || {};
      const directions = Object.entries(directionSource)
        .map(([key, direction]) => ({ key, ...direction }))
        .filter(direction => direction && direction.headsign);
      const directionA = directions[0] || null;
      const directionB = directions[1] || null;
      const fallback = getDirections(route.route_long_name);
      const displayNumber = getLineDisplayNumber(route, type);

      return {
        id: routeId,
        number: displayNumber,
        type,
        color: getLineColor(route, type),
        textColor: route.route_text_color ? `#${route.route_text_color.replace(/^#/, '')}` : '#FFFFFF',
        icon: getTransportIcon(type, displayNumber),
        directions,
        directionA: directionA || { key: 'A', headsign: fallback.A, stops: [] },
        directionB: directionB || { key: 'B', headsign: fallback.B, stops: [] },
        stopsA: directionA?.stops || [],
        stopsB: directionB?.stops || [],
        activeDirection: directionA?.key || directions[0]?.key || 'D1'
      };
    });
}

function getDirections(routeLongName) {
  const parts = String(routeLongName || '').split(' - ').map(part => part.trim()).filter(Boolean);
  return { A: parts[1] || parts[0] || '', B: parts[0] || parts[1] || '' };
}

function getRoute(cgmId, routes = window.transportData?.routes || []) {
  return (routes || []).find(route => String(route?.route_id) === String(cgmId)) || null;
}

function getStop(stopId, stops = window.transportData?.stops || []) {
  const target = String(stopId ?? '').trim();
  if (!target) return null;
  return (stops || []).find(stop => String(stop?.stop_id ?? '').trim() === target || String(stop?.stop_code ?? '').trim() === target) || null;
}

function isMetroStop(stopCode) {
  return /^M/i.test(String(typeof stopCode === 'object' ? stopCode?.stop_id : stopCode ?? '').trim());
}

function formatStopCode(stopCode) {
  const value = String(stopCode ?? '').trim();
  return value || '????';
}

function getStopName(stopCode, lang = 'bg', noIndexes = false) {
  const stop = typeof stopCode === 'object' ? stopCode : getStop(stopCode);
  if (!stop) return '(неизвестна спирка)';

  let name = stop?.names?.[lang] || stop?.stop_name || stop?.name || '(неизвестна спирка)';
  if (isMetroStop(stop)) {
    name = name.replace('МЕТРОСТАНЦИЯ', '').replace('METRO STATION', '').replace('METROSTANTSIA', '').replaceAll('  ', ' ').trim();
    return name;
  }

  if (noIndexes) return name;
  if (stop.local_ref && stop.metro_ref) return `${name} ${stop.local_ref} / ${stop.metro_ref}`;
  if (stop.local_ref) return `${name} ${stop.local_ref}`;
  if (stop.metro_ref) return `${name} ${stop.metro_ref}`;
  return name;
}

function getStopString(stopCode, noIndexes = false) {
  const stop = typeof stopCode === 'object' ? stopCode : getStop(stopCode);
  if (!stop) return `[${formatStopCode(stopCode)}] (неизвестна спирка)`;
  return `[${formatStopCode(stop.stop_code || stop.stop_id)}] ${getStopName(stop, 'bg', noIndexes)}`;
}

window.loadTransportData = loadTransportData;
window.getTransportCalendarDateKey = getTransportCalendarDateKey;
window.getTransportCalendarDayType = getTransportCalendarDayType;
window.getTransportType = getTransportType;
window.getLineOverride = getLineOverride;
window.getLineType = getLineType;
window.getLineDisplayNumber = getLineDisplayNumber;
window.getTransportIcon = getTransportIcon;
window.getLineColor = getLineColor;
window.convertGtfsRoutes = convertGtfsRoutes;
window.getRoute = getRoute;
window.getStop = getStop;
window.isMetroStop = isMetroStop;
window.formatStopCode = formatStopCode;
window.getStopName = getStopName;
window.getStopString = getStopString;
