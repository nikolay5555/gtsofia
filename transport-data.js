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


function getLineType(route) {
    const number =
        String(
            route.route_short_name || ''
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

    const forcedBusLines =
        new Set([
            '73',
            '60',
            '288',
            '74',
            'E186',
            '123',
            '801'
        ]);

    if (
        forcedBusLines.has(
            number
        )
    ) {
        return 'bus';
    }

    return getTransportType(
        route.route_type
    );
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
    const number =
        String(
            route.route_short_name || ''
        )
            .trim()
            .toUpperCase();

    const forcedBusLines =
        new Set([
            '73',
            '60',
            '288',
            '74',
            'E186',
            '123',
            '801'
        ]);

    if (
        forcedBusLines.has(
            number
        )
    ) {
        return '#BE1E2D';
    }

    if (route.route_color) {
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
            return '#9E1B32';

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

            const displayNumber =
                type === 'metro'
                    ? String(
                          route.route_short_name || ''
                      )
                          .trim()
                          .replace(
                              /^[МM]/i,
                              ''
                          )
                    : String(
                          route.route_short_name || ''
                      )
                          .trim()
                          .replace(
                              /^E(?=186$)/i,
                              ''
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
                        String(
                            route.route_short_name || ''
                        ).trim()
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


async function loadTransportLines() {
    const data =
        await loadTransportData();

    return convertGtfsRoutes(
        data.routes || [],
        data.trips || [],
        data.directions || {}
    );
}
