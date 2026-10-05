let gtfsRoutes = [];
let gtfsStops = [];

async function loadTransportData() {
    const response = await fetch(
        './data/transport.json'
    );

    if (!response.ok) {
        throw new Error(
            `Неуспешно зареждане на transport.json: ${response.status}`
        );
    }

    const data =
        await response.json();

    gtfsRoutes =
        data.routes || [];

    gtfsStops =
        data.stops || [];

    window.transportData =
        data;

    console.log(
        'GTFS routes:',
        gtfsRoutes.length
    );

    console.log(
        'GTFS stops:',
        gtfsStops.length
    );

    console.log(
        'GTFS shapes:',
        Object.keys(
            data.shapes || {}
        ).length
    );

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


function getLineType(route) {
    const override = getLineOverride(route);
    const sourceNumber = String(route?.route_short_name || '').trim();
    const normalizedNumber = normalizeRouteRef(
        override?.route_ref || sourceNumber
    ).toUpperCase();

    // Dimitar's route normalization makes replacement services buses even
    // when the source GTFS transport mode is different.
    if (
        normalizedNumber.includes('T') ||
        normalizedNumber.includes('Т')
    ) {
        return 'bus';
    }

    if (override?.type) {
        const overrideType = String(override.type).trim().toLowerCase();
        return overrideType === 'trolleybus'
            ? 'trolley'
            : overrideType === 'night'
                ? 'bus'
                : overrideType;
    }

    return getTransportType(
        route.route_type
    );
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

        case 'tram':
            return '#F7941D';

        case 'trolley':
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
