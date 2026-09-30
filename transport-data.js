

let gtfsRoutes = [];
let gtfsStops = [];

const TRANSPORT_DATA_FILES = [
    ['routes', './data/routes.json'],
    ['stops', './data/stops.json'],
    ['directionsFlat', './data/directions.json'],
    ['trips', './data/trips.json'],
    ['stopTimes', './data/stop_times.json'],
    ['tripAliases', './data/trip_aliases.json'],
    ['calendar', './data/calendar.json'],
    ['lineOverrides', './config/line-overrides.json'],
];

function normalizeLoadedRoute(route) {
    const id = String(route?.cgm_id ?? route?.route_id ?? '').trim();
    const type = String(route?.type || '').trim();
    return {
        ...route,
        cgm_id: id,
        route_id: id,
        route_short_name: String(route?.route_ref || '').trim(),
        route_ref: String(route?.route_ref || '').trim(),
        route_type: type === 'tram' ? '0'
            : type === 'metro' ? '1'
            : type === 'trolley' ? '11'
            : '3',
        route_color: String(route?.bg_color || '').replace(/^#/, ''),
        route_text_color: String(route?.text_color || 'FFFFFF').replace(/^#/, '')
    };
}

function normalizeLoadedStop(stop) {
    const code = String(stop?.code || '').trim();
    const names = stop?.names || {};
    const name = String(names.bg || names.en || '').trim();
    const lat = Number(stop?.coords?.[0]);
    const lon = Number(stop?.coords?.[1]);

    return {
        ...stop,
        code,
        stop_id: code,
        stop_code: code,
        stop_name: name,
        name,
        stop_name_en: String(names.en || '').trim(),
        stop_lat: Number.isFinite(lat) ? lat : '',
        stop_lon: Number.isFinite(lon) ? lon : ''
    };
}

async function loadTransportData(options = {}) {
    const includeShapes = Boolean(options?.includeShapes);
    const files = includeShapes
        ? [...TRANSPORT_DATA_FILES, ['shapes', './data/shapes.json']]
        : TRANSPORT_DATA_FILES;

    const loaded = await Promise.all(
        files.map(async ([key, path]) => {
            const response = await fetch(path);
            if (!response.ok) {
                throw new Error(`Неуспешно зареждане на ${path}: ${response.status}`);
            }
            return [key, await response.json()];
        })
    );

    const raw = Object.fromEntries(loaded);
    const routes = (raw.routes || []).map(normalizeLoadedRoute);
    const stops = (raw.stops || []).map(normalizeLoadedStop);
    const stopsById = new Map(
        stops.map(stop => [String(stop.stop_id), stop])
    );
    const stopTimes = raw.stopTimes || [];
    const stopTimesByTrip = new Map();
    for (const row of stopTimes) {
        const tripId = String(row?.trip ?? '').trim();
        if (!tripId) continue;
        const rows = stopTimesByTrip.get(tripId) || [];
        rows.push(row);
        stopTimesByTrip.set(tripId, rows);
    }

    gtfsRoutes = routes;
    gtfsStops = stops;

    // directions.json is intentionally flat on disk. Rehydrate D1/D2/...
    // only in memory so the existing UI keeps a convenient per-route index.
    const directions = {};
    for (const direction of raw.directionsFlat || []) {
        const routeId = String(direction?.cgm_id ?? direction?.route_id ?? '').trim();
        if (!routeId) continue;
        if (!directions[routeId]) directions[routeId] = {};
        const key = `D${Object.keys(directions[routeId]).length + 1}`;
        const pattern = Array.isArray(direction?.stops)
            ? direction.stops.map(String).filter(Boolean)
            : [];

        directions[routeId][key] = {
            ...direction,
            key,
            code: String(direction.code),
            route_id: routeId,
            stops: pattern.map(stop_id => ({
                stop_id,
                name: stopsById.get(String(stop_id))?.stop_name || ''
            })),
            pattern
        };
    }

    window.transportData = {
        routes,
        stops,
        directions,
        directionsFlat: raw.directionsFlat || [],
        trips: raw.trips || [],
        stopTimes,
        stop_times: stopTimes,
        stopTimesByTrip,
        tripAliases: raw.tripAliases || {},
        calendar: raw.calendar || {},
        lineOverrides: raw.lineOverrides || [],
        shapes: raw.shapes || {}
    };

    console.log('GTFS routes:', routes.length);
    console.log('GTFS stops:', stops.length);
    console.log('GTFS directions:', Array.isArray(raw.directionsFlat) ? raw.directionsFlat.length : 0);
    console.log('GTFS logical trips:', Array.isArray(raw.trips) ? raw.trips.length : 0);
    console.log('GTFS stop-time rows:', Array.isArray(raw.stopTimes) ? raw.stopTimes.length : 0);
    if (includeShapes) console.log('GTFS shapes:', Object.keys(raw.shapes || {}).length);

    return window.transportData;
}


const TRANSPORT_TIME_ZONE = 'Europe/Sofia';
function getTransportCalendarDateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TRANSPORT_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);

    const get = type =>
        parts.find(part => part.type === type)?.value || '';

    return `${get('year')}-${get('month')}-${get('day')}`;
}

function getTransportCalendarWeekday(date = new Date()) {
    const value = new Intl.DateTimeFormat('en-US', {
        timeZone: TRANSPORT_TIME_ZONE,
        weekday: 'short'
    }).format(date);

    return value;
}

function getTransportCalendarDayType(date = new Date()) {
    const key = getTransportCalendarDateKey(date);
    const calendar = window.transportData?.calendar;

    const cachedType =
        calendar?.dateTypes?.[key];

    if (
        cachedType === 'weekday' ||
        cachedType === 'weekend'
    ) {
        return cachedType;
    }

    const configuredType =
        calendar?.config?.dateOverrides?.[key];

    if (
        configuredType === 'weekday' ||
        configuredType === 'weekend'
    ) {
        return configuredType;
    }

    const weekday = getTransportCalendarWeekday(date);

    return weekday === 'Sat' || weekday === 'Sun'
        ? 'weekend'
        : 'weekday';
}

window.getTransportCalendarDateKey =
    getTransportCalendarDateKey;
window.getTransportCalendarDayType =
    getTransportCalendarDayType;


function getTransportType(routeType) {
    switch (String(routeType)) {
        case '0':
            return 'tram';

        case '1':
            return 'metro';

        case '3':
            return 'bus';

        case '11':
            return 'trolleybus';

        default:
            return 'other';
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
        (
            !override?.cgm_id &&
            String(override?.route_ref || '').trim() === routeNumber
        )
    ) || null;
}


function getLineType(route) {
    const number =
        String(
            route.route_short_name || route.route_ref || ''
        )
            .trim()
            .toUpperCase();

    const nightBusLines =
        new Set([
            'N1',
            'N2',
            'N3',
            'N4'
        ]);

    if (
        nightBusLines.has(
            number
        )
    ) {
        return 'night';
    }

    const override = getLineOverride(route);

    if (override?.type) return override.type;

    if (route?.subtype === 'night') return 'night';
    if (route?.type === 'trolley') return 'trolleybus';
    if (['bus', 'tram', 'metro'].includes(String(route?.type || ''))) return route.type;

    return getTransportType(route.route_type);
}


function getLineDisplayNumber(route, type) {
    const override = getLineOverride(route);
    const sourceNumber = String(
        route.route_short_name || route.route_ref || ''
    ).trim();

    if (override?.route_ref) {
        return String(override.route_ref).trim();
    }

    return type === 'metro'
        ? sourceNumber.replace(/^[МM]/i, '')
        : sourceNumber.replace(/^E(?=186$)/i, '');
}

function getTransportIcon(
    type,
    number
) {
    const lineNumber =
        String(number || '')
            .trim()
            .toUpperCase();

    if (
        lineNumber === 'X43'
    ) {
        return 'Icons/Active icons/torist-bus.svg';
    }

    const nightBusLines =
        new Set([
            'N1',
            'N2',
            'N3',
            'N4'
        ]);

    if (
        nightBusLines.has(
            lineNumber
        )
    ) {
        return 'Icons/Active icons/night-bus.svg';
    }

    switch (type) {
        case 'bus':
            return 'Icons/Active icons/bus.svg';

        case 'night':
            return 'Icons/Active icons/night-bus.svg';

        case 'trolleybus':
            return 'Icons/Active icons/trolley.svg';

        case 'tram':
            return 'Icons/Active icons/tram.svg';

        case 'metro':
            return 'Icons/Active icons/metro.svg';

        default:
            return '';
    }
}


function getLineColor(
    route,
    type
) {
    const override = getLineOverride(route);

    if (override?.color) {
        return String(override.color).startsWith('#')
            ? String(override.color)
            : `#${override.color}`;
    }

    // When the transport type is masked by an override, do not let
    // the original CGM route color leak through (e.g. trolleybus blue
    // on a line that the UI masks as a bus).
    if (!override?.type && (route.route_color || route.bg_color)) {
        return `#${String(route.route_color || route.bg_color).replace(/^#/, '')}`;
    }

    switch (type) {
        case 'bus':
            return '#BE1E2D';

        case 'night':
            return '#BE1E2D';

        case 'tram':
            return '#F7941D';

        case 'trolleybus':
            return '#27AAE1';

        case 'metro':
            return '#1C75BC';

        default:
            return '#BE1E2D';
    }
}

function getDirections(
    routeLongName
) {
    const parts =
        String(
            routeLongName || ''
        )
            .split(' - ')
            .map(
                part =>
                    part.trim()
            )
            .filter(Boolean);

    return {
        A:
            parts[1]
                || parts[0]
                || '',

        B:
            parts[0]
                || parts[1]
                || ''
    };
}


function convertGtfsRoutes(
    routes,
    trips,
    directionsData
) {
    const activeRouteIds =
        new Set(
            trips
                .map(
                    trip =>
                        String(
                            trip.route_id || trip.cgm_id || ''
                        ).trim()
                )
                .filter(Boolean)
        );

    return routes
        .filter(route =>
            activeRouteIds.has(
                String(
                    route.route_id || route.cgm_id || ''
                ).trim()
            )
        )
        .map(route => {

            const routeId =
                String(
                    route.route_id || route.cgm_id || ''
                ).trim();

            const type =
                getLineType(
                    route
                );

            const directionSource =
                directionsData &&
                directionsData[
                    routeId
                ]
                    ? directionsData[
                        routeId
                    ]
                    : {};

            const directionEntries =
                Object.entries(
                    directionSource
                );

            const directions =
                directionEntries
                    .map(
                        ([key, direction]) => ({
                            key,
                            ...direction
                        })
                    )
                    .filter(
                        direction =>
                            direction &&
                            direction.headsign
                    );

            /*
             * Старият A/B формат се запазва само
             * за съвместимост.
             */
            const directionA =
                directions[0]
                    || null;

            const directionB =
                directions[1]
                    || null;

            const fallback =
                getDirections(
                    route.route_long_name
                );

            const displayNumber = getLineDisplayNumber(
                route,
                type
            );

            return {
                id:
                    routeId,

                number:
                    displayNumber,

                type,

                color:
                    getLineColor(
                        route,
                        type
                    ),

                textColor:
                    route.route_text_color
                        ? `#${route.route_text_color}`
                        : '#FFFFFF',

                icon:
                    getTransportIcon(
                        type,
                        displayNumber
                    ),

                /*
                 * Новият реален списък от ВСИЧКИ
                 * направления.
                 */
                directions,

                /*
                 * Стар API за останалата част
                 * от стария сайт.
                 */
                directionA:
                    directionA || {
                        key: 'A',
                        headsign:
                            fallback.A,
                        stops: []
                    },

                directionB:
                    directionB || {
                        key: 'B',
                        headsign:
                            fallback.B,
                        stops: []
                    },

                stopsA:
                    directionA?.stops || [],

                stopsB:
                    directionB?.stops || [],

                activeDirection:
                    directionA?.key
                        || directions[0]?.key
                        || 'D1'
            };
        });
}


window.getLineOverride = getLineOverride;
window.getLineDisplayNumber = getLineDisplayNumber;
window.getLineType = getLineType;
window.getLineColor = getLineColor;
window.getTransportIcon = getTransportIcon;


async function loadTransportLines() {
    const data =
        await loadTransportData();

    return convertGtfsRoutes(
        data.routes || [],
        data.trips || [],
        data.directions || {}
    );
}
