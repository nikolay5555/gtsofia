let gtfsRoutes = [];
let gtfsStops = [];
let transportShapesPromise = null;

const TRANSPORT_DATA_FILES = {
    metadata: 'metadata.json',
    calendar: 'calendar.json',
    calendarExceptions: 'calendar-exceptions.json',
    routes: 'routes.json',
    stops: 'stops.json',
    trips: 'trips.json',
    directions: 'directions.json',
    schedules: 'schedules.json'
};

async function fetchTransportJson(filename) {
    const response = await fetch(`./data/${filename}`);
    if (!response.ok) {
        throw new Error(`Неуспешно зареждане на data/${filename}: ${response.status}`);
    }
    return response.json();
}

async function loadTransportData() {
    const entries = await Promise.all(
        Object.entries(TRANSPORT_DATA_FILES).map(async ([key, filename]) => [
            key,
            await fetchTransportJson(filename)
        ])
    );
    const files = Object.fromEntries(entries);
    const metadata = files.metadata || {};
    const calendar = files.calendar || {};
    const exceptionIndex = files.calendarExceptions?.exceptionsByDate || {};

    // Preserve the in-memory shape expected by existing pages while loading
    // smaller, responsibility-specific JSON files over the network.
    const data = {
        ...metadata,
        routes: files.routes || [],
        stops: files.stops || [],
        trips: files.trips || [],
        directions: files.directions || {},
        // Shapes are published in data/shapes.json for optional consumers,
        // but none of the current pages draws geometry. Avoid downloading the
        // multi-megabyte file during every initial page load.
        shapes: {},
        schedules: files.schedules || {},
        calendar: {
            ...calendar,
            exceptionsByDate: exceptionIndex
        }
    };

    gtfsRoutes = data.routes;
    gtfsStops = data.stops;
    window.transportData = data;

    console.log('GTFS routes:', gtfsRoutes.length);
    console.log('GTFS stops:', gtfsStops.length);

    return data;
}


async function loadTransportShapes() {
    if (window.transportData?.shapes
        && Object.keys(window.transportData.shapes).length) {
        return window.transportData.shapes;
    }
    if (!transportShapesPromise) {
        transportShapesPromise = fetchTransportJson('shapes.json')
            .then(shapes => {
                if (window.transportData) {
                    window.transportData.shapes = shapes || {};
                }
                return shapes || {};
            })
            .catch(error => {
                transportShapesPromise = null;
                throw error;
            });
    }
    return transportShapesPromise;
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
            return 'trolley';

        default:
            return 'other';
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
        (
            !override?.cgm_id &&
            String(override?.route_ref || '').trim() === routeNumber
        )
    ) || null;
}


function normalizeRouteRef(value) {
    let ref = String(value || '').trim();
    if (!ref) return '';

    const number = ref.replace(/[a-zа-я]/gi, '');

    if (/^E/i.test(ref)) {
        ref = number;
    } else if (/^N/i.test(ref)) {
        ref = `N${number}`;
    } else if (/^Y/i.test(ref)) {
        ref = `У${number}`;
    }

    return ref;
}


function normalizeLineType(value) {
    const type = String(value || '').trim().toLowerCase();

    switch (type) {
        case 'trolleybus':
            return 'trolley';
        case 'night':
            return 'bus';
        default:
            return type;
    }
}

function getLineType(route) {
    const override = getLineOverride(route);

    // An explicit override is authoritative. In particular, a route whose
    // number contains T/Т must not silently turn a configured tram/trolley
    // line into a bus.
    if (override?.type) {
        return normalizeLineType(override.type);
    }

    const sourceNumber = String(route?.route_short_name || '').trim();
    const normalizedNumber = normalizeRouteRef(
        override?.route_ref || sourceNumber
    ).toUpperCase();

    // Replacement services are buses by default when there is no override.
    if (
        normalizedNumber.includes('T') ||
        normalizedNumber.includes('Т')
    ) {
        return 'bus';
    }

    return getTransportType(route?.route_type);
}


function getLineDisplayNumber(route, type) {
    const override = getLineOverride(route);
    const sourceNumber = String(
        route.route_short_name || ''
    ).trim();

    const number = override?.route_ref
        ? String(override.route_ref).trim()
        : sourceNumber;

    const normalized = normalizeRouteRef(number);

    return type === 'metro'
        ? normalized.replace(/^[МM]/i, '')
        : normalized;
}


function getLineSubtype(route, type, displayNumber) {
    const override = getLineOverride(route);
    const explicit = String(override?.subtype || '').trim().toLowerCase();
    if (explicit) return explicit;

    if (type !== 'bus') return '';

    const number = String(
        displayNumber ??
        getLineDisplayNumber(route, type)
    ).trim().toUpperCase();

    // Dimitar's normalization: T/Т routes are replacement buses.
    if (number.includes('Т') || number.includes('T')) {
        return 'temporary';
    }

    if (number.startsWith('N')) {
        return 'night';
    }

    if (number.startsWith('У')) {
        return 'school';
    }

    return '';
}


function getTransportIcon(
    type,
    number,
    subtype = ''
) {
    if (type === 'bus' && subtype === 'night') {
        return 'Icons/Active icons/night-bus.svg';
    }

    switch (type) {
        case 'bus':
            return 'Icons/Active icons/bus.svg';

        case 'trolley':
            return 'Icons/Active icons/trolley.svg';

        case 'tram':
            return 'Icons/Active icons/tram.svg';

        case 'metro':
            return 'Icons/Active icons/metro.svg';

        default:
            return '';
    }
}


const TRANSPORT_TYPE_COLORS = Object.freeze({
    bus: '#BE1E2D',
    tram: '#F7941D',
    trolley: '#27AAE1',
    metro: '#1C75BC'
});

function getLineColor(
    route,
    type
) {
    const override = getLineOverride(route);

    // A configured color remains an optional, explicit exception to the
    // standard palette for the selected transport type.
    if (override?.color) {
        const color = String(override.color).trim();
        return color.startsWith('#') ? color : `#${color}`;
    }

    // Keep the original GTFS line color only when the line type itself was
    // not overridden. Otherwise always use the selected type's standard pill.
    if (!override?.type && route?.route_color) {
        const color = String(route.route_color).trim();
        return color.startsWith('#') ? color : `#${color}`;
    }

    return TRANSPORT_TYPE_COLORS[normalizeLineType(type)]
        || TRANSPORT_TYPE_COLORS.bus;
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

            const subtype = getLineSubtype(
                route,
                type,
                displayNumber
            );

            return {
                id:
                    routeId,

                number:
                    displayNumber,

                type,

                subtype,

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
                        displayNumber,
                        subtype
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
window.normalizeLineType = normalizeLineType;
window.getLineSubtype = getLineSubtype;
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
