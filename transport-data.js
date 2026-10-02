const TRANSPORT_TIME_ZONE = 'Europe/Sofia';

let transportDataPromise = null;

const DATA_FILES = [
  'routes',
  'stops',
  'directions',
  'trips',
  'stop_times',
  'calendar',
  'shapes',
  'metadata'
];

function fetchJson(name) {
  return fetch(`./data/${name}.json`, { cache: 'no-store' }).then(response => {
    if (!response.ok) {
      throw new Error(`Неуспешно зареждане на ${name}.json: ${response.status}`);
    }
    return response.json();
  });
}

async function loadTransportData() {
  if (transportDataPromise) return transportDataPromise;

  transportDataPromise = Promise.all(DATA_FILES.map(fetchJson))
    .then(values => {
      const data = {};
      DATA_FILES.forEach((name, index) => {
        data[name] = values[index];
      });

      window.transportData = data;

      console.log('Schedule routes:', data.routes.length);
      console.log('Schedule stops:', data.stops.length);
      console.log('Schedule directions:', data.directions.length);
      console.log('Logical trips:', data.trips.length);
      console.log('Stop-time rows:', data.stop_times.length);

      return data;
    })
    .catch(error => {
      transportDataPromise = null;
      throw error;
    });

  return transportDataPromise;
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
  if (['tram', 'metro', 'bus', 'trolley'].includes(routeType)) return routeType;

  switch (String(routeType)) {
    case '0': return 'tram';
    case '1': return 'metro';
    case '3': return 'bus';
    case '11': return 'trolley';
    default: return 'bus';
  }
}

function getLineSubtype(route) {
  const ref = String(route?.route_ref || '').trim().toUpperCase();
  if (ref.startsWith('N')) return 'night';
  if (ref.startsWith('У')) return 'school';
  if (
    (ref.endsWith('ТБ') || ref.endsWith('ТМ') || ref.startsWith('M')) &&
    getTransportType(route?.type) === 'bus'
  ) {
    return 'temporary';
  }
  return null;
}

function getLineType(route) {
  return getTransportType(route?.type);
}

function getLineDisplayNumber(route) {
  const ref = String(route?.route_ref || '').trim();
  const type = getLineType(route);

  // The one deliberate UI exception: keep metro displayed as 1/2/3/4,
  // while the canonical data keeps M1/M2/M3/M4 exactly like Dimitar's model.
  return type === 'metro' ? ref.replace(/^M/i, '') : ref;
}

function getLineColor(route) {
  const type = getLineType(route);
  if (type === 'metro' && route?.bg_color) return `#${String(route.bg_color).replace(/^#/, '')}`;
  switch (type) {
    case 'tram': return '#F7941D';
    case 'trolley': return '#27AAE1';
    case 'metro': return '#1C75BC';
    case 'bus': return '#BE1E2D';
    default: return '#BE1E2D';
  }
}

function getLineTextColor(route) {
  if (getLineType(route) === 'metro' && route?.text_color) {
    return `#${String(route.text_color).replace(/^#/, '')}`;
  }
  return '#FFFFFF';
}

function getTransportIcon(type, number = '') {
  const lineNumber = String(number).trim().toUpperCase();
  if (lineNumber === 'X43') return 'Icons/Active icons/torist-bus.svg';
  if (lineNumber.startsWith('N')) return 'Icons/Active icons/night-bus.svg';

  switch (getTransportType(type)) {
    case 'bus': return 'Icons/Active icons/bus.svg';
    case 'trolley': return 'Icons/Active icons/trolley.svg';
    case 'tram': return 'Icons/Active icons/tram.svg';
    case 'metro': return 'Icons/Active icons/metro.svg';
    default: return '';
  }
}

function getRoute(cgmId, routes = window.transportData?.routes || []) {
  if (typeof cgmId === 'number') return routes[cgmId] || null;
  return routes.find(route => String(route?.cgm_id) === String(cgmId)) || null;
}

function getStop(stopCode, stops = window.transportData?.stops || []) {
  const target = String(stopCode ?? '').trim();
  if (!target) return null;
  return stops.find(stop => String(stop?.code ?? '').trim() === target) || null;
}

function isMetroStop(stopCode) {
  return /^M/i.test(String(stopCode ?? '').trim());
}

function formatStopCode(stopCode) {
  const value = String(stopCode ?? '').trim();
  return value || '????';
}

function getStopName(stopCode, lang = 'bg', noIndexes = false) {
  const stop = typeof stopCode === 'object' ? stopCode : getStop(stopCode);
  if (!stop) return '(неизвестна спирка)';

  let name = stop?.names?.[lang] || stop?.names?.bg || '(неизвестна спирка)';
  if (isMetroStop(stop.code)) {
    name = name
      .replace('МЕТРОСТАНЦИЯ', '')
      .replace('METRO STATION', '')
      .replace('METROSTANTSIA', '')
      .replaceAll('  ', ' ')
      .trim();
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
  return `[${formatStopCode(stop.code)}] ${getStopName(stop, 'bg', noIndexes)}`;
}

function getDirection(code) {
  return (window.transportData?.directions || []).find(direction => Number(direction.code) === Number(code)) || null;
}

function getRouteDirections(route, isWeekend = false) {
  if (!route) return [];
  const tripIds = (window.transportData?.trips || [])
    .filter(trip => String(trip.cgm_id) === String(route.cgm_id) && Boolean(trip.is_weekend) === Boolean(isWeekend))
    .map(trip => Number(trip.direction));

  const codes = [...new Set(tripIds)];
  return codes
    .map(getDirection)
    .filter(Boolean);
}

function routeDestination(direction) {
  const stops = direction?.stops || [];
  if (!stops.length) return '—';
  return getStopName(stops.at(-1), 'bg', true);
}

window.loadTransportData = loadTransportData;
window.getTransportCalendarDateKey = getTransportCalendarDateKey;
window.getTransportCalendarDayType = getTransportCalendarDayType;
window.getTransportType = getTransportType;
window.getLineSubtype = getLineSubtype;
window.getLineType = getLineType;
window.getLineDisplayNumber = getLineDisplayNumber;
window.getLineColor = getLineColor;
window.getLineTextColor = getLineTextColor;
window.getTransportIcon = getTransportIcon;
window.getRoute = getRoute;
window.getStop = getStop;
window.isMetroStop = isMetroStop;
window.formatStopCode = formatStopCode;
window.getStopName = getStopName;
window.getStopString = getStopString;
window.getDirection = getDirection;
window.getRouteDirections = getRouteDirections;
window.routeDestination = routeDestination;
