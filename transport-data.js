let gtfsRoutes = [];
let gtfsStops = [];

async function loadTransportData() {
    const response = await fetch('./data/transport.json');

    if (!response.ok) {
        throw new Error(
            `Неуспешно зареждане на transport.json: ${response.status}`
        );
    }

    const data = await response.json();

    gtfsRoutes = data.routes || [];
    gtfsStops = data.stops || [];

    /*
     * Запазваме целия transport.json глобално.
     *
     * map.js ще използва:
     *
     * window.transportData.shapes
     *
     * за да намери геометрията на активното направление.
     */
    window.transportData = data;

    console.log('GTFS routes:', gtfsRoutes.length);
    console.log('GTFS stops:', gtfsStops.length);
    console.log(
        'GTFS shapes:',
        Object.keys(data.shapes || {}).length
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
    const number = String(route.route_short_name || '')
        .trim()
        .toUpperCase();

    const nightBusLines = new Set([
        'N1',
        'N2',
        'N3',
        'N4'
    ]);

    if (nightBusLines.has(number)) {
        return 'night';
    }

    const forcedBusLines = new Set([
        '73',
        '60',
        '288',
        '74',
        'E186',
        '123',
        '801'
    ]);

    if (forcedBusLines.has(number)) {
        return 'bus';
    }

    return getTransportType(route.route_type);
}

function getTransportIcon(type, number) {
    const lineNumber = String(number || '')
        .trim()
        .toUpperCase();

    // Линия X43 е туристически автобус
    if (lineNumber === 'X43') {
        return 'Icons/Active icons/torist-bus.svg';
    }

    // Нощни автобусни линии
    const nightBusLines = new Set([
        'N1',
        'N2',
        'N3',
        'N4'
    ]);

    if (nightBusLines.has(lineNumber)) {
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

function getLineColor(route, type) {
    const number = String(route.route_short_name || '')
        .trim()
        .toUpperCase();

    const forcedBusLines = new Set([
        '73',
        '60',
        '288',
        '74',
        'E186',
        '123',
        '801'
    ]);

    /*
     * Тези линии са автобусни независимо от GTFS route_type
     * и route_color.
     *
     * Използваме стандартния автобусен цвят:
     * BE1E2D
     */
    if (forcedBusLines.has(number)) {
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

function getDirections(routeLongName) {
    const parts = String(routeLongName || '')
        .split(' - ')
        .map(part => part.trim())
        .filter(Boolean);

    return {
        A: parts[1] || parts[0] || '',
        B: parts[0] || parts[1] || ''
    };
}

function convertGtfsRoutes(routes, trips, directionsData) {
    const activeRouteIds = new Set(
        trips
            .map(trip => String(trip.route_id || '').trim())
            .filter(Boolean)
    );

    return routes
        .filter(route =>
            activeRouteIds.has(
                String(route.route_id || '').trim()
            )
        )
        .map(route => {
            const routeId = String(
                route.route_id || ''
            ).trim();

            const type = getLineType(route);

            /*
             * Първо използваме реалните направления,
             * извлечени от trips + stop_times.
             *
             * Ако по някаква причина липсват,
             * използваме стария route_long_name механизъм
             * като резервен вариант.
             */
            const gtfsDirections =
                directionsData &&
                directionsData[routeId]
                    ? directionsData[routeId]
                    : null;

            const fallbackDirections =
                getDirections(route.route_long_name);

            const directionA =
                gtfsDirections &&
                gtfsDirections.A
                    ? gtfsDirections.A
                    : null;

            const directionB =
                gtfsDirections &&
                gtfsDirections.B
                    ? gtfsDirections.B
                    : null;

            const stopsA =
                directionA &&
                Array.isArray(directionA.stops)
                    ? directionA.stops
                    : [];

            const stopsB =
                directionB &&
                Array.isArray(directionB.stops)
                    ? directionB.stops
                    : [];

            /*
             * При метро:
             * М1 -> 1
             * М2 -> 2
             * М3 -> 3
             * М4 -> 4
             *
             * При всички останали линии номерът
             * остава непроменен.
             */
            const displayNumber =
                type === 'metro'
                    ? String(
                          route.route_short_name || ''
                      )
                          .trim()
                          .replace(/^[МM]/i, '')
                    : String(
                          route.route_short_name || ''
                      )
                          .trim()
                          .replace(/^E(?=186$)/i, '');

            /*
             * Запазваме съществуващата структура
             * на directionA / directionB.
             *
             * Добавяме shape_id вътре в тях,
             * без да променяме headsign или stops.
             *
             * Така app.js продължава да работи по
             * същия начин, а map.js може да използва:
             *
             * line.directionA.shape_id
             * line.directionB.shape_id
             */
            const directionAResult = {
                headsign:
                    directionA &&
                    directionA.headsign
                        ? directionA.headsign
                        : fallbackDirections.A,

                stops: stopsA,

                shape_id:
                    directionA &&
                    directionA.shape_id
                        ? directionA.shape_id
                        : ''
            };

            const directionBResult = {
                headsign:
                    directionB &&
                    directionB.headsign
                        ? directionB.headsign
                        : fallbackDirections.B,

                stops: stopsB,

                shape_id:
                    directionB &&
                    directionB.shape_id
                        ? directionB.shape_id
                        : ''
            };

            return {
                id: routeId,

                number: displayNumber,

                type: type,

                color: getLineColor(
                    route,
                    type
                ),

                textColor: route.route_text_color
                    ? `#${route.route_text_color}`
                    : '#FFFFFF',

                icon: getTransportIcon(
                    type,
                    String(
                        route.route_short_name || ''
                    ).trim()
                ),

                /*
                 * Реалните направления от GTFS.
                 *
                 * directionA/directionB остават
                 * обекти, съдържащи:
                 *
                 * - headsign
                 * - stops
                 * - shape_id
                 */
                directionA: directionAResult,

                directionB: directionBResult,

                /*
                 * Реалните спирки за всяко направление.
                 *
                 * Оставяме и тези полета, защото
                 * app.js ги използва директно.
                 */
                stopsA: stopsA,

                stopsB: stopsB,

                activeDirection: 'A'
            };
        });
}

async function loadTransportLines() {
    const data = await loadTransportData();

    return convertGtfsRoutes(
        data.routes,
        data.trips || [],
        data.directions || {}
    );
}
