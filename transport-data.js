let gtfsRoutes = [];
let gtfsStops = [];

const TRANSPORT_TIME_ZONE = 'Europe/Sofia';
async function fetchTransportJson(path) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Неуспешно зареждане на ${path}: ${response.status}`);
    }
    return response.json();
}

function normalizeRouteRecord(route) {
    const routeRef = String(route?.route_ref ?? route?.route_short_name ?? '').trim();
    const typeMap = { trolleybus: 'trolley', subway: 'metro' };
    const rawType = String(route?.type ?? route?.transport_type ?? '').trim().toLowerCase();
    const type = typeMap[rawType] || rawType || getTransportType(route?.route_type);
    const color = normalizeHexColor(route?.bg_color || route?.route_color);
    const textColor = normalizeHexColor(route?.text_color || route?.route_text_color) || '#FFFFFF';

    return {
        route_id: String(route?.cgm_id ?? route?.route_id ?? '').trim(),
        cgm_id: String(route?.cgm_id ?? route?.route_id ?? '').trim(),
        route_ref: routeRef,
        route_short_name: routeRef,
        route_type: type,
        type,
        subtype: String(route?.subtype ?? '').trim() || null,
        route_color: color.replace(/^#/, ''),
        route_text_color: textColor.replace(/^#/, ''),
        bg_color: color,
        text_color: textColor
    };
}

function normalizeHexColor(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    return raw.startsWith('#') ? raw : `#${raw}`;
}

function normalizeStopRecord(stop) {
    const code = String(stop?.code ?? '').trim();
    const coords = Array.isArray(stop?.coords) ? stop.coords : [];
    const lat = Number(coords[0]);
    const lon = Number(coords[1]);
    const names = stop?.names && typeof stop.names === 'object' ? stop.names : {};

    return {
        stop_id: code,
        stop_code: code.startsWith('M') ? code : code.padStart(4, '0'),
        stop_name: String(names.bg ?? '').trim() || 'Спирка',
        name: String(names.bg ?? '').trim() || 'Спирка',
        stop_lat: Number.isFinite(lat) ? String(lat) : '',
        stop_lon: Number.isFinite(lon) ? String(lon) : '',
        location_type: '0'
    };
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

function parseScheduleTime(value) {
    const match = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3] || 0);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
    return hours * 60 + minutes + seconds / 60;
}

function formatScheduleMinutes(minutes) {
    if (!Number.isFinite(minutes)) return null;
    const total = Math.max(0, Math.trunc(minutes));
    const hour = Math.floor(total / 60);
    const minute = total % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

function buildDirectionsIndex(directionRows, trips, stops) {
    const byCode = new Map(
        (Array.isArray(directionRows) ? directionRows : [])
            .map(direction => [String(direction.code), direction])
    );
    const stopById = new Map(stops.map(stop => [String(stop.stop_id), stop]));
    const grouped = new Map();

    for (const trip of trips) {
        const routeId = String(trip.cgm_id ?? trip.route_id ?? '').trim();
        const code = String(trip.direction ?? trip.direction_id ?? '').trim();
        if (!routeId || !code) continue;
        if (!grouped.has(routeId)) grouped.set(routeId, []);
        const list = grouped.get(routeId);
        if (!list.some(item => item.code === code)) list.push({ code, tripRecords: [] });
        list.find(item => item.code === code).tripRecords.push(trip);
    }

    const result = {};
    for (const [routeId, routeDirections] of grouped.entries()) {
        const directions = {};
        routeDirections.forEach((group, index) => {
            const raw = byCode.get(group.code);
            const pattern = Array.isArray(raw?.stops)
                ? raw.stops.map(value => String(value).trim()).filter(Boolean)
                : [];
            const stopsForDirection = pattern
                .map(stopId => stopById.get(stopId))
                .filter(Boolean)
                .map(stop => ({
                    stop_id: stop.stop_id,
                    name: stop.stop_name
                }));
            const destination = String(
                raw?.destination
                || raw?.headsign
                || stopsForDirection.at(-1)?.name
                || ''
            ).trim();
            const sourceTripIds = [...new Set(
                group.tripRecords
                    .flatMap(trip => Array.isArray(trip.source_trip_ids) ? trip.source_trip_ids : [])
                    .map(value => String(value).trim())
                    .filter(Boolean)
            )];

            directions[`D${index + 1}`] = {
                key: `D${index + 1}`,
                code: group.code,
                headsign: destination,
                destination,
                trip_id: sourceTripIds[0] || '',
                direction_id: '',
                shape_id: String(raw?.shape_id || group.tripRecords.find(trip => trip.shape_id)?.shape_id || '').trim(),
                service_id: '',
                frequency: group.tripRecords.length,
                stop_count: stopsForDirection.length,
                stops: stopsForDirection,
                pattern,
                trip_ids: sourceTripIds
            };
        });
        result[routeId] = directions;
    }
    return result;
}

function buildSchedulesIndex(trips, stopTimes, directions) {
    const tripById = new Map(trips.map(trip => [String(trip.id), trip]));
    const schedules = {};

    for (const row of stopTimes) {
        const trip = tripById.get(String(row?.trip));
        if (!trip) continue;
        const routeId = String(trip.cgm_id).trim();
        const routeDirections = directions?.[routeId] || {};
        const directionEntry = Object.entries(routeDirections)
            .find(([, direction]) => String(direction.code) === String(trip.direction));
        if (!directionEntry) continue;
        const directionKey = directionEntry[0];
        const values = Array.isArray(row?.times) ? row.times : [];
        const nonNull = values.filter(value => value !== null && Number.isFinite(Number(value)));
        if (!nonNull.length) continue;

        const scheduleRow = {
            trip_id: Number(trip.id),
            original_trip_id: String(row?.original_trip_id || ''),
            service_id: String(row?.service_id || ''),
            stop_sequences: Array.isArray(row?.stop_sequences)
                ? row.stop_sequences.map(value => value === null ? null : Number(value))
                : [],
            start_time: formatScheduleMinutes(Number(nonNull[0])),
            times: values.map(value => value === null ? null : formatScheduleMinutes(Number(value))),
            car: String(row?.car || '')
        };

        if (!schedules[routeId]) schedules[routeId] = {};
        if (!schedules[routeId][directionKey]) schedules[routeId][directionKey] = { weekday: [], weekend: [] };
        schedules[routeId][directionKey][trip.is_weekend ? 'weekend' : 'weekday'].push(scheduleRow);
    }

    for (const routeDirections of Object.values(schedules)) {
        for (const bucket of Object.values(routeDirections)) {
            bucket.weekday.sort((a, b) => (parseScheduleTime(a.start_time) ?? Infinity) - (parseScheduleTime(b.start_time) ?? Infinity));
            bucket.weekend.sort((a, b) => (parseScheduleTime(a.start_time) ?? Infinity) - (parseScheduleTime(b.start_time) ?? Infinity));
        }
    }

    return schedules;
}

function buildSourceTrips(trips, stopTimes) {
    const firstServiceBySource = new Map();
    for (const row of stopTimes) {
        const sourceId = String(row?.original_trip_id || '').trim();
        if (!sourceId || firstServiceBySource.has(sourceId)) continue;
        firstServiceBySource.set(sourceId, String(row?.service_id || '').trim());
    }

    const sourceTrips = [];
    for (const trip of trips) {
        const ids = Array.isArray(trip.source_trip_ids) ? trip.source_trip_ids : [];
        for (const sourceId of ids) {
            sourceTrips.push({
                trip_id: String(sourceId),
                route_id: String(trip.cgm_id),
                service_id: firstServiceBySource.get(String(sourceId)) || '',
                trip_headsign: String(trip.headsign || ''),
                direction_id: String(trip.direction),
                shape_id: String(trip.shape_id || '')
            });
        }
    }
    return sourceTrips;
}

async function loadTransportData() {
    const [meta, calendar, routesRaw, stopsRaw, directionsRaw, tripsRaw, stopTimesRaw, lineOverrides] =
        await Promise.all([
            fetchTransportJson('./data/meta.json'),
            fetchTransportJson('./data/calendar.json'),
            fetchTransportJson('./data/routes.json'),
            fetchTransportJson('./data/stops.json'),
            fetchTransportJson('./data/directions.json'),
            fetchTransportJson('./data/trips.json'),
            fetchTransportJson('./data/stop_times.json'),
            fetchTransportJson('./config/line-overrides.json')
        ]);

    const routes = (Array.isArray(routesRaw) ? routesRaw : []).map(normalizeRouteRecord).filter(route => route.route_id);
    const stops = (Array.isArray(stopsRaw) ? stopsRaw : []).map(normalizeStopRecord).filter(stop => stop.stop_id);
    const trips = (Array.isArray(tripsRaw) ? tripsRaw : []).map(trip => ({
        id: Number(trip.id),
        trip_id: String(trip.id),
        cgm_id: String(trip.cgm_id),
        route_id: String(trip.cgm_id),
        direction: Number(trip.direction),
        direction_id: String(trip.direction),
        is_weekend: Boolean(trip.is_weekend),
        day_types: [trip.is_weekend ? 'weekend' : 'weekday'],
        source_trip_ids: Array.isArray(trip.source_trip_ids) ? trip.source_trip_ids.map(String) : [],
        trip_headsign: String(trip.headsign || ''),
        shape_id: String(trip.shape_id || '')
    })).filter(trip => Number.isFinite(trip.id) && trip.cgm_id);

    const directions = buildDirectionsIndex(directionsRaw, trips, stops);
    const stopTimes = Array.isArray(stopTimesRaw) ? stopTimesRaw : [];
    const schedules = buildSchedulesIndex(trips, stopTimes, directions);
    const sourceTrips = buildSourceTrips(trips, stopTimes);

    const data = {
        meta,
        calendar: calendar && typeof calendar === 'object' ? calendar : {},
        lineOverrides: Array.isArray(lineOverrides) ? lineOverrides : [],
        routes,
        stops,
        directions,
        trips,
        sourceTrips,
        stop_times: stopTimes,
        schedules,
        shapes: {}
    };

    gtfsRoutes = routes;
    gtfsStops = stops;
    window.transportData = data;

    console.log('Transport data loaded:', {
        routes: routes.length,
        stops: stops.length,
        directions: Object.values(directions).reduce((sum, value) => sum + Object.keys(value).length, 0),
        trips: trips.length,
        stopTimes: stopTimes.length
    });

    return data;
}

function getTransportCalendarDateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TRANSPORT_TIME_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit'
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
    const calendar = window.transportData?.calendar;
    const cachedType = calendar?.dateTypes?.[key];
    if (cachedType === 'weekday' || cachedType === 'weekend') return cachedType;

    const configuredType = calendar?.config?.dateOverrides?.[key];
    if (configuredType === 'weekday' || configuredType === 'weekend') return configuredType;

    const weekday = getTransportCalendarWeekday(date);
    return weekday === 'Sat' || weekday === 'Sun' ? 'weekend' : 'weekday';
}

function getTransportType(routeType) {
    switch (String(routeType).toLowerCase()) {
        case '0': case 'tram': return 'tram';
        case '1': case 'metro': case 'subway': return 'metro';
        case '3': case 'bus': return 'bus';
        case '11': case 'trolley': case 'trolleybus': return 'trolley';
        default: return 'other';
    }
}

function getLineOverride(route) {
    const routeId = String(route?.route_id || route?.cgm_id || '').trim();
    const routeNumber = String(route?.route_short_name || route?.route_ref || '').trim();
    const overrides = Array.isArray(window.transportData?.lineOverrides)
        ? window.transportData.lineOverrides
        : [];
    return overrides.find(override =>
        String(override?.cgm_id || '').trim() === routeId ||
        (!override?.cgm_id && String(override?.route_ref || '').trim() === routeNumber)
    ) || null;
}

function canonicalLineRef(value) {
    let ref = String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
    if (!ref) return '';
    if (/^[MМ]\d+$/.test(ref)) return ref.replace(/^[MМ]/, '');
    if (/^E\d+$/.test(ref)) return ref.slice(1);
    if (/^[YУ]\d+$/.test(ref)) return `У${ref.slice(1)}`;
    if (/^N\d+$/.test(ref)) return ref;
    const temporary = ref.match(/^(\d+)(?:T|TM|Т|ТМ|TB|ТВ)$/);
    if (temporary) return `${temporary[1]}ТМ`;
    return ref;
}

function getLineType(route) {
    const override = getLineOverride(route);
    if (override?.type) {
        const value = String(override.type).trim().toLowerCase();
        return value === 'trolleybus'
            ? 'trolley'
            : value === 'subway'
                ? 'metro'
                : value;
    }

    const canonical = String(route?.type || route?.transport_type || '').trim().toLowerCase();
    if (canonical === 'trolleybus') return 'trolley';
    if (canonical === 'subway') return 'metro';
    if (['bus', 'tram', 'trolley', 'metro'].includes(canonical)) return canonical;
    return getTransportType(route?.route_type);
}

function getLineSubtype(route) {
    const explicit = String(route?.subtype || route?.route_subtype || '').trim().toLowerCase();
    if (explicit) return explicit;
    const number = canonicalLineRef(route?.route_ref || route?.route_short_name);
    if (/^N\d+$/i.test(number)) return 'night';
    if (/^У\d+$/i.test(number)) return 'school';
    if (/\d+ТМ$/i.test(number)) return 'temporary';
    return null;
}

function getLineDisplayNumber(route) {
    const override = getLineOverride(route);
    if (override?.route_ref) return canonicalLineRef(override.route_ref);
    return canonicalLineRef(route?.route_ref || route?.route_short_name);
}

function getTransportIcon(type, number, subtype = null) {
    const lineNumber = String(number || '').trim().toUpperCase();
    if (lineNumber === 'X43') return 'Icons/Active icons/torist-bus.svg';
    if (subtype === 'night') return 'Icons/Active icons/night-bus.svg';

    switch (type) {
        case 'bus': return 'Icons/Active icons/bus.svg';
        case 'trolley': return 'Icons/Active icons/trolley.svg';
        case 'tram': return 'Icons/Active icons/tram.svg';
        case 'metro': return 'Icons/Active icons/metro.svg';
        default: return '';
    }
}

function getLineColor(route, type) {
    const override = getLineOverride(route);
    if (override?.color) return normalizeHexColor(override.color);
    if (route?.bg_color) return normalizeHexColor(route.bg_color);
    if (!override?.type && route?.route_color) return normalizeHexColor(route.route_color);

    switch (type) {
        case 'tram': return '#F7941D';
        case 'trolley': return '#27AAE1';
        case 'metro': return '#1C75BC';
        case 'bus': return '#BE1E2D';
        default: return '#BE1E2D';
    }
}

function convertGtfsRoutes(routes, trips, directionsData) {
    const activeRouteIds = new Set(
        trips.map(trip => String(trip.cgm_id || trip.route_id || '').trim()).filter(Boolean)
    );

    return routes
        .filter(route => activeRouteIds.has(String(route.route_id || route.cgm_id || '').trim()))
        .map(route => {
            const routeId = String(route.route_id || route.cgm_id || '').trim();
            const type = getLineType(route);
            const subtype = getLineSubtype(route);
            const directionSource = directionsData?.[routeId] || {};
            const directions = Object.entries(directionSource)
                .map(([key, direction]) => ({ key, ...direction }))
                .filter(direction => direction?.headsign);
            const fallback = { A: '', B: '' };
            const displayNumber = getLineDisplayNumber(route);

            return {
                id: routeId,
                number: displayNumber,
                type,
                subtype,
                color: getLineColor(route, type),
                textColor: normalizeHexColor(route.route_text_color) || '#FFFFFF',
                icon: getTransportIcon(type, displayNumber, subtype),
                directions,
                directionA: directions[0] || { key: 'A', headsign: fallback.A, stops: [] },
                directionB: directions[1] || { key: 'B', headsign: fallback.B, stops: [] },
                stopsA: directions[0]?.stops || [],
                stopsB: directions[1]?.stops || [],
                activeDirection: directions[0]?.key || 'D1'
            };
        });
}

window.getTransportCalendarDateKey = getTransportCalendarDateKey;
window.getTransportCalendarDayType = getTransportCalendarDayType;
window.getLineOverride = getLineOverride;
window.getLineType = getLineType;
window.getLineSubtype = getLineSubtype;
window.getLineDisplayNumber = getLineDisplayNumber;
window.getLineColor = getLineColor;
window.getTransportIcon = getTransportIcon;
window.convertGtfsRoutes = convertGtfsRoutes;
window.loadTransportData = loadTransportData;
