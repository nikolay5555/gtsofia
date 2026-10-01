let gtfsRoutes = [];
let gtfsStops = [];

async function fetchJsonPart(basePath, relativePath) {
    const response = await fetch(`${basePath}${relativePath}`, {
        cache: 'no-store'
    });
    if (!response.ok) {
        throw new Error(`Неуспешно зареждане на ${relativePath}: ${response.status}`);
    }
    return response.json();
}

async function loadTransportData() {
    const manifestResponse = await fetch('./data/transport.json', {
        cache: 'no-store'
    });

    if (!manifestResponse.ok) {
        throw new Error(
            `Неуспешно зареждане на transport.json: ${manifestResponse.status}`
        );
    }

    const manifest = await manifestResponse.json();
    if (!manifest?.files) {
        // Keep old deployments readable during rollout.
        gtfsRoutes = manifest.routes || [];
        gtfsStops = manifest.stops || [];
        window.transportData = manifest;
        return manifest;
    }

    const basePath = './data/';
    const files = manifest.files;
    const [
        calendar,
        routes,
        stops,
        trips,
        directions,
        shapes,
        schedules,
        normalizedStops,
        normalizedRoutes,
        normalizedDirections,
        normalizedTrips,
        normalizedStopTimes,
    ] = await Promise.all([
        fetchJsonPart(basePath, files.calendar),
        fetchJsonPart(basePath, files.routes),
        fetchJsonPart(basePath, files.stops),
        fetchJsonPart(basePath, files.trips),
        fetchJsonPart(basePath, files.directions),
        fetchJsonPart(basePath, files.shapes),
        fetchJsonPart(basePath, files.schedules),
        fetchJsonPart(basePath, files.normalized.stops),
        fetchJsonPart(basePath, files.normalized.routes),
        fetchJsonPart(basePath, files.normalized.directions),
        fetchJsonPart(basePath, files.normalized.trips),
        fetchJsonPart(basePath, files.normalized.stop_times),
    ]);

    const data = {
        updatedAt: manifest.updatedAt,
        source: manifest.source,
        lineOverrides: manifest.lineOverrides || [],
        normalization: manifest.normalization || {},
        calendar,
        routes,
        stops,
        trips,
        directions,
        shapes,
        schedules,
        normalized: {
            stops: normalizedStops,
            routes: normalizedRoutes,
            directions: normalizedDirections,
            trips: normalizedTrips,
            stop_times: normalizedStopTimes,
        },
    };

    gtfsRoutes = data.routes || [];
    gtfsStops = data.stops || [];
    window.transportData = data;

    console.log('GTFS routes:', gtfsRoutes.length);
    console.log('GTFS stops:', gtfsStops.length);
    console.log('GTFS shapes:', Object.keys(data.shapes || {}).length);
    console.log('Transport data parts loaded:', Object.keys(files));

    return data;
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
    const routeId = String(route?.route_id || '').trim();
    const routeNumber = String(route?.route_short_name || '').trim();
    const normalizedNumber = String(
        route?.normalized?.route_ref || ''
    ).trim();
    const overrides = Array.isArray(window.transportData?.lineOverrides)
        ? window.transportData.lineOverrides
        : [];

    return overrides.find(override =>
        String(override?.cgm_id || '').trim() === routeId ||
        (
            !override?.cgm_id &&
            (
                String(override?.route_ref || '').trim() === routeNumber ||
                String(override?.route_ref || '').trim() === normalizedNumber
            )
        )
    ) || null;
}


function getLineType(route) {
    const normalized = route?.normalized || {};
    const number =
        String(
            normalized.route_ref ||
            route.route_short_name ||
            ''
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
        normalized.subtype === 'night' ||
        nightBusLines.has(
            number
        )
    ) {
        return 'night';
    }

    const override = getLineOverride(route);

    if (override?.type) {
        return override.type;
    }

    if (normalized.type) {
        return normalized.type === 'trolley'
            ? 'trolleybus'
            : normalized.type;
    }

    return getTransportType(
        route.route_type
    );
}


function getLineDisplayNumber(route, type) {
    const override = getLineOverride(route);
    const normalizedNumber = String(
        route?.normalized?.route_ref || ''
    ).trim();
    const sourceNumber = String(
        normalizedNumber ||
        route.route_short_name ||
        ''
    ).trim();

    if (override?.route_ref) {
        return String(override.route_ref).trim();
    }

    return type === 'metro'
        ? sourceNumber.replace(/^[МM]/i, '')
        : sourceNumber;
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
    if (!override?.type && route.route_color) {
        return `#${route.route_color}`;
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
                            trip.route_id || ''
                        ).trim()
                )
                .filter(Boolean)
        );

    return routes
        .filter(route =>
            activeRouteIds.has(
                String(
                    route.route_id || ''
                ).trim()
            )
        )
        .map(route => {

            const routeId =
                String(
                    route.route_id || ''
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
