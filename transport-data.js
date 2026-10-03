let gtfsRoutes = [];
let gtfsStops = [];

async function fetchTransportJson(filename) {
    const response = await fetch(
        `./data/${filename}`,
        {
            cache: 'no-store'
        }
    );

    if (!response.ok) {
        throw new Error(
            `Неуспешно зареждане на data/${filename}: ${response.status}`
        );
    }

    return response.json();
}

function modelRouteTypeToGtfs(type) {
    switch (String(type || '').trim().toLowerCase()) {
        case 'tram':
            return '0';
        case 'metro':
            return '1';
        case 'bus':
            return '3';
        case 'trolley':
        case 'trolleybus':
            return '11';
        default:
            return '';
    }
}

function buildRuntimeRoutes(routes) {
    return (Array.isArray(routes) ? routes : []).map(route => {
        const routeId = String(route?.cgm_id || '').trim();
        const routeRef = String(route?.route_ref || '').trim();
        const routeColor = String(route?.bg_color || '').trim();
        const textColor = String(route?.text_color || '').trim();

        return {
            ...route,
            route_id: routeId,
            route_short_name: routeRef,
            route_type: modelRouteTypeToGtfs(route?.type),
            route_color: routeColor,
            route_text_color: textColor,
            route_long_name: String(route?.route_long_name || '').trim()
        };
    });
}

function buildRuntimeStops(stops) {
    return (Array.isArray(stops) ? stops : []).map(stop => {
        const code = String(stop?.code || '').trim();
        const coords = Array.isArray(stop?.coords)
            ? stop.coords
            : [];

        return {
            ...stop,
            stop_id: code,
            stop_code: code,
            stop_lat: Number(coords[0]),
            stop_lon: Number(coords[1]),
            stop_name: String(stop?.names?.bg || '').trim(),
            stop_name_en: String(stop?.names?.en || '').trim()
        };
    });
}

function mostCommonString(values) {
    const counts = new Map();

    for (const value of values) {
        const normalized = String(value || '').trim();
        if (!normalized) continue;

        counts.set(
            normalized,
            (counts.get(normalized) || 0) + 1
        );
    }

    let best = '';
    let bestCount = -1;

    for (const [value, count] of counts) {
        if (count > bestCount) {
            best = value;
            bestCount = count;
        }
    }

    return best;
}

function buildRuntimeDirections(
    canonicalDirections,
    logicalTrips,
    stops,
    realtimeTrips
) {
    const directionsByCode = new Map(
        (Array.isArray(canonicalDirections)
            ? canonicalDirections
            : []
        ).map(direction => [
            String(direction?.code ?? '').trim(),
            direction
        ])
    );

    const stopByCode = new Map(
        (Array.isArray(stops) ? stops : []).map(stop => [
            String(stop?.code || '').trim(),
            stop
        ])
    );

    const routeDirectionCodes = new Map();

    for (const trip of (Array.isArray(logicalTrips) ? logicalTrips : [])) {
        const routeId = String(trip?.cgm_id || '').trim();
        const directionCode = String(trip?.direction ?? '').trim();

        if (!routeId || !directionCode) continue;

        if (!routeDirectionCodes.has(routeId)) {
            routeDirectionCodes.set(routeId, []);
        }

        const list = routeDirectionCodes.get(routeId);
        if (!list.includes(directionCode)) {
            list.push(directionCode);
        }
    }

    const result = {};

    for (const [routeId, directionCodes] of routeDirectionCodes) {
        const routeDirections = {};

        directionCodes.forEach((directionCode, index) => {
            const canonical = directionsByCode.get(directionCode);
            if (!canonical) return;

            const pattern = Array.isArray(canonical?.stops)
                ? canonical.stops.map(value => String(value || '').trim()).filter(Boolean)
                : [];

            const directionRealtimeTrips = (
                Array.isArray(realtimeTrips)
                    ? realtimeTrips
                    : []
            ).filter(trip =>
                String(trip?.route_id || '').trim() === routeId
                && String(trip?.direction_code ?? '').trim() === directionCode
            );

            // Passenger-facing direction names follow Dimitar's model:
            // resolve the terminal stop through the normalized stops data,
            // where OSM is authoritative and GTFS is only the fallback source.
            const osmDestination = String(
                stopByCode.get(pattern[pattern.length - 1])?.names?.bg
                || ''
            ).trim();

            const gtfsHeadsign = mostCommonString(
                directionRealtimeTrips.map(
                    trip => trip?.trip_headsign
                )
            );

            const headsign = osmDestination || gtfsHeadsign;

            const shapeId = mostCommonString(
                directionRealtimeTrips.map(
                    trip => trip?.shape_id
                )
            );

            const directionId = mostCommonString(
                directionRealtimeTrips.map(
                    trip => trip?.direction_id
                )
            );

            const representativeTripId = String(
                directionRealtimeTrips[0]?.trip_id || ''
            ).trim();

            const tripIds = directionRealtimeTrips
                .map(trip => String(trip?.trip_id || '').trim())
                .filter(Boolean);

            const stopsForDirection = pattern
                .map(stopId => {
                    const stop = stopByCode.get(stopId);
                    if (!stop) return null;

                    return {
                        stop_id: stopId,
                        name: String(
                            stop?.names?.bg || ''
                        ).trim()
                    };
                })
                .filter(Boolean);

            const key = `D${index + 1}`;

            routeDirections[key] = {
                key,
                code: directionCode,
                headsign,
                destination: headsign,
                trip_id: representativeTripId,
                trip_ids: tripIds,
                direction_id: directionId,
                shape_id: shapeId,
                frequency: directionRealtimeTrips.length,
                stop_count: stopsForDirection.length,
                stops: stopsForDirection,
                pattern
            };
        });

        if (Object.keys(routeDirections).length) {
            result[routeId] = routeDirections;
        }
    }

    return result;
}

function formatScheduleMinute(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
        return null;
    }

    const minutes = Number(value);
    const hours = Math.floor(minutes / 60);
    const remainder = minutes - hours * 60;

    return `${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}:00`;
}

function buildRuntimeSchedules(
    logicalTrips,
    canonicalStopTimes,
    runtimeDirections
) {
    const tripById = new Map(
        (Array.isArray(logicalTrips) ? logicalTrips : []).map(trip => [
            String(trip?.id ?? ''),
            trip
        ])
    );

    const directionKeyByRouteAndCode = new Map();

    for (const [routeId, directionSet] of Object.entries(
        runtimeDirections || {}
    )) {
        for (const [key, direction] of Object.entries(directionSet || {})) {
            directionKeyByRouteAndCode.set(
                `${routeId}|${String(direction?.code ?? '').trim()}`,
                key
            );
        }
    }

    const schedules = {};

    for (const item of (
        Array.isArray(canonicalStopTimes)
            ? canonicalStopTimes
            : []
    )) {
        const tripId = String(item?.trip ?? '').trim();
        const logicalTrip = tripById.get(tripId);

        if (!logicalTrip) continue;

        const routeId = String(
            logicalTrip?.cgm_id || ''
        ).trim();

        const directionKey = directionKeyByRouteAndCode.get(
            `${routeId}|${String(logicalTrip?.direction ?? '').trim()}`
        );

        if (!routeId || !directionKey) continue;

        const times = (
            Array.isArray(item?.times)
                ? item.times.map(formatScheduleMinute)
                : []
        );
        const arrivalTimes = (
            Array.isArray(item?.arrival_times)
                ? item.arrival_times.map(formatScheduleMinute)
                : []
        );
        const departureTimes = (
            Array.isArray(item?.departure_times)
                ? item.departure_times.map(formatScheduleMinute)
                : []
        );

        if (!times.some(Boolean) && !arrivalTimes.some(Boolean) && !departureTimes.some(Boolean)) continue;

        // The first stop's departure_time is the authoritative GTFS trip
        // start_time. Keep the old effective-time fallback for incomplete data.
        const first = departureTimes.find(Boolean)
            || times.find(Boolean)
            || arrivalTimes.find(Boolean);
        if (!first) continue;

        const direction = runtimeDirections?.[routeId]?.[directionKey] || {};

        const row = {
            trip_id: Number.isFinite(Number(logicalTrip?.id))
                ? Number(logicalTrip.id)
                : logicalTrip.id,
            original_trip_id: String(
                item?.original_trip_id || ''
            ).trim(),
            service_id: String(
                item?.service_id || ''
            ).trim(),
            stop_sequences: Array.isArray(item?.stop_sequences)
                ? item.stop_sequences.map(value =>
                    value === null || value === undefined
                        ? null
                        : Number(value)
                )
                : [],
            direction_id: String(direction?.direction_id || '').trim(),
            start_time: first,
            times,
            arrival_times: arrivalTimes,
            departure_times: departureTimes
        };

        schedules[routeId] ??= {};
        schedules[routeId][directionKey] ??= {
            weekday: [],
            weekend: []
        };

        // Keep each concrete source trip available in both buckets. The exact
        // service_id on the row is authoritative and the virtual board evaluates
        // calendar.txt + calendar_dates.txt for the requested service date. This
        // allows date exceptions to move a normal weekday trip to a weekend
        // holiday (and vice versa) without losing the row at generation time.
        for (const dayType of ['weekday', 'weekend']) {
            schedules[routeId][directionKey][dayType].push({
                ...row
            });
        }
    }

    for (const routeDirections of Object.values(schedules)) {
        for (const daySchedule of Object.values(routeDirections)) {
            for (const dayType of ['weekday', 'weekend']) {
                daySchedule[dayType].sort((a, b) =>
                    String(a?.start_time || '').localeCompare(
                        String(b?.start_time || '')
                    )
                );
            }
        }
    }

    return schedules;
}

function buildRuntimeTransportData(parts) {
    const runtimeRoutes = buildRuntimeRoutes(parts.routes);
    const runtimeStops = buildRuntimeStops(parts.stops);
    const runtimeDirections = buildRuntimeDirections(
        parts.directions,
        parts.trips,
        parts.stops,
        parts.realtimeTrips
    );
    const runtimeSchedules = buildRuntimeSchedules(
        parts.trips,
        parts.stopTimes,
        runtimeDirections
    );

    return {
        updatedAt: String(
            parts.metadata?.updatedAt
            || parts.metadata?.retrieval_date
            || ''
        ),
        source: String(
            parts.metadata?.source
            || 'CGM Sofia official GTFS'
        ),
        lineOverrides: Array.isArray(parts.lineOverrides)
            ? parts.lineOverrides
            : [],
        calendar: parts.calendar || {},
        routes: runtimeRoutes,
        stops: runtimeStops,
        trips: Array.isArray(parts.realtimeTrips)
            ? parts.realtimeTrips
            : [],
        directions: runtimeDirections,
        shapes: parts.shapes || {},
        schedules: runtimeSchedules,

        // Canonical normalized model is exposed separately for consumers
        // that want the compact Dimitar-style data directly.
        logicalTrips: Array.isArray(parts.trips)
            ? parts.trips
            : [],
        stopTimes: Array.isArray(parts.stopTimes)
            ? parts.stopTimes
            : [],
        activeServiceIds: Array.isArray(parts.activeServiceIds)
            ? parts.activeServiceIds
            : [],
        metadata: parts.metadata || {},
    };
}

async function loadSplitTransportData() {
    const [
        metadata,
        calendar,
        lineOverrides,
        routes,
        stops,
        trips,
        directions,
        stopTimes,
        activeServiceIds,
        shapes,
        realtimeTrips
    ] = await Promise.all([
        fetchTransportJson('metadata.json'),
        fetchTransportJson('calendar.json'),
        fetchTransportJson('line-overrides.json'),
        fetchTransportJson('routes.json'),
        fetchTransportJson('stops.json'),
        fetchTransportJson('trips.json'),
        fetchTransportJson('directions.json'),
        fetchTransportJson('stop_times.json'),
        fetchTransportJson('active_service_ids.json'),
        fetchTransportJson('shapes.json'),
        fetchTransportJson('realtime-trips.json')
    ]);

    return buildRuntimeTransportData({
        metadata,
        calendar,
        lineOverrides,
        routes,
        stops,
        trips,
        directions,
        stopTimes,
        activeServiceIds,
        shapes,
        realtimeTrips
    });
}

async function loadTransportData() {
    try {
        const data = await loadSplitTransportData();

        gtfsRoutes = data.routes || [];
        gtfsStops = data.stops || [];

        window.transportData = data;

        console.log(
            'Normalized split GTFS routes:',
            gtfsRoutes.length
        );

        console.log(
            'Normalized split GTFS stops:',
            gtfsStops.length
        );

        console.log(
            'GTFS shapes:',
            Object.keys(data.shapes || {}).length
        );

        return data;
    } catch (splitError) {
        console.warn(
            'Split transport data is unavailable; falling back to transport.json.',
            splitError
        );

        const response = await fetch(
            './data/transport.json',
            {
                cache: 'no-store'
            }
        );

        if (!response.ok) {
            throw new Error(
                `Неуспешно зареждане на transport data: ${response.status}`
            );
        }

        const data = await response.json();

        gtfsRoutes = data.routes || [];
        gtfsStops = data.stops || [];

        window.transportData = data;

        console.log(
            'Legacy GTFS routes:',
            gtfsRoutes.length
        );

        console.log(
            'Legacy GTFS stops:',
            gtfsStops.length
        );

        return data;
    }
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


function getLineType(route) {
    const type = String(
        route?.type || ''
    ).trim().toLowerCase();

    if (
        type === 'metro' ||
        type === 'tram' ||
        type === 'trolley' ||
        type === 'bus'
    ) {
        return type;
    }

    return 'other';
}


function getLineSubtype(route) {
    const subtype = String(
        route?.subtype || ''
    ).trim().toLowerCase();

    return (
        subtype === 'temporary' ||
        subtype === 'school' ||
        subtype === 'night'
    )
        ? subtype
        : '';
}



function getLineDisplayNumber(route, type) {
    const override = getLineOverride(route);
    const sourceNumber = String(
        route.route_short_name || ''
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
    number,
    subtype = ''
) {
    const normalizedSubtype = String(subtype || '')
        .trim()
        .toLowerCase();

    if (normalizedSubtype === 'night') {
        return 'Icons/Active icons/night-bus.svg';
    }

    switch (type) {
        case 'bus':
            return 'Icons/Active icons/bus.svg';

        case 'trolley':
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
    type,
    subtype = ''
) {
    const override = getLineOverride(route);
    const normalizedSubtype = String(
        subtype || getLineSubtype(route) || ''
    ).trim().toLowerCase();

    if (override?.color) {
        return String(override.color).startsWith('#')
            ? String(override.color)
            : `#${override.color}`;
    }

    if (normalizedSubtype === 'night') {
        return '#111827';
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
    // routes.json is already filtered and normalized by the generator.
    // Do not derive route activity or transport types again in the browser.
    return routes
        .map(route => {

            const routeId =
                String(
                    route.route_id || ''
                ).trim();

            const type =
                getLineType(
                    route
                );

            const subtype =
                getLineSubtype(
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

                subtype,

                color:
                    getLineColor(
                        route,
                        type,
                        subtype
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
window.getLineSubtype = getLineSubtype;
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
