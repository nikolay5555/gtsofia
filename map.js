/*
 * GTSofia route map
 *
 * Draws exactly one GTFS shape for the currently selected direction.
 * The route geometry comes from transport.json -> shapes.
 *
 * Stop markers are taken from the same active direction
 * that is currently displayed in the stop list.
 */

let lineMap = null;
let transportMapDataPromise = null;


/*
 * Зареждане на transport.json за картата.
 *
 * Използваме кеширано Promise, за да не теглим
 * transport.json отново при всяка смяна на посока.
 */
async function loadTransportMapData() {

    if (!transportMapDataPromise) {

        transportMapDataPromise =
            fetch("./data/transport.json")
                .then(response => {

                    if (!response.ok) {
                        throw new Error(
                            `Неуспешно зареждане на transport.json за картата: ${response.status}`
                        );
                    }

                    return response.json();

                });

    }

    return transportMapDataPromise;
}


/*
 * Взимаме цвета на линията.
 */
function getMapColor(line) {

    return line && line.color
        ? line.color
        : "#BE1E2D";

}


/*
 * Връща спирките на активното направление.
 *
 * Новият формат използва:
 *
 * line.directions = [
 *     {
 *         key: "D1",
 *         headsign: "...",
 *         stops: [...]
 *     },
 *     {
 *         key: "D2",
 *         headsign: "...",
 *         stops: [...]
 *     }
 * ]
 *
 * Поддържаме и стария A/B формат като fallback.
 */
function getActiveStops(line, stops) {

    /*
     * Ако app.js вече е подал спирките,
     * използваме тях.
     */
    if (Array.isArray(stops)) {
        return stops;
    }


    /*
     * Новият модел:
     *
     * activeDirection = D1 / D2 / D3...
     */
    const directionKey =
        line &&
        line.activeDirection
            ? line.activeDirection
            : (
                line &&
                Array.isArray(
                    line.directions
                ) &&
                line.directions.length
                    ? line.directions[0].key
                    : "A"
            );


    /*
     * Новият формат.
     */
    if (
        line &&
        Array.isArray(
            line.directions
        )
    ) {

        const direction =
            line.directions.find(
                item =>
                    item.key ===
                    directionKey
            );

        if (
            direction &&
            Array.isArray(
                direction.stops
            )
        ) {
            return direction.stops;
        }

    }


    /*
     * Старият A/B формат.
     */
    const legacyDirection =
        directionKey === "B"
            ? line?.directionB
            : line?.directionA;

    if (
        legacyDirection &&
        Array.isArray(
            legacyDirection.stops
        )
    ) {
        return legacyDirection.stops;
    }


    /*
     * Резервен вариант за стария формат.
     */
    if (directionKey === "B") {

        return Array.isArray(
            line?.stopsB
        )
            ? line.stopsB
            : [];

    }


    return Array.isArray(
        line?.stopsA
    )
        ? line.stopsA
        : [];

}


/*
 * Намира координатите на спирките
 * от GTFS stops.
 *
 * Резултатът запазва реда на спирките
 * от активното направление.
 */
function getStopCoordinates(
    data,
    stops
) {

    const stopsById = new Map();


    /*
     * Индексираме всички GTFS спирки
     * по stop_id.
     */
    (data.stops || []).forEach(stop => {

        const id =
            String(
                stop.stop_id ??
                stop.id ??
                ""
            ).trim();


        if (!id) {
            return;
        }


        const lat =
            Number(
                stop.stop_lat ??
                stop.latitude
            );


        const lon =
            Number(
                stop.stop_lon ??
                stop.longitude
            );


        if (
            Number.isFinite(lat) &&
            Number.isFinite(lon)
        ) {

            stopsById.set(
                id,
                [
                    lat,
                    lon
                ]
            );

        }

    });


    /*
     * Взимаме координатите в същия ред,
     * в който спирките са показани под картата.
     */
    return (stops || [])
        .map(stop => {

            const id =
                String(
                    stop.stop_id ??
                    stop.id ??
                    ""
                ).trim();


            const coordinate =
                stopsById.get(id);


            if (!coordinate) {
                return null;
            }


            return {

                name:
                    stop.name ||
                    stop.stop_name ||
                    "",

                coordinate

            };
        })
        .filter(Boolean);

}


/*
 * Премахва предишната Leaflet карта.
 *
 * Нужно е при смяна на направление.
 */
function removeExistingMap() {

    if (lineMap) {

        lineMap.remove();

        lineMap = null;

    }

}


/*
 * Основна функция за визуализиране на картата.
 */
async function renderLineMap(
    line,
    stops
) {

    const mapElement =
        document.getElementById(
            "lineMap"
        );


    if (!mapElement) {
        return;
    }


    /*
     * Премахваме предишната карта.
     */
    removeExistingMap();


    /*
     * Проверяваме дали Leaflet е зареден.
     */
    if (
        typeof L === "undefined"
    ) {

        mapElement.innerHTML = `
            <div class="map-empty">
                Картата не може да бъде заредена.
            </div>
        `;

        return;

    }


    /*
     * Изчистваме старото съдържание.
     */
    mapElement.innerHTML = "";


    /*
     * Leaflet има нужда от реална височина.
     *
     * CSS също може да задава височината,
     * но това гарантира, че картата няма
     * да бъде с височина 0.
     */
    mapElement.style.height =
        "420px";

    mapElement.style.width =
        "100%";


    try {

        /*
         * Зареждаме transport.json.
         */
        const data =
            await loadTransportMapData();


        /*
         * ID на текущата линия.
         */
        const routeId =
            String(
                line.id || ""
            ).trim();


        /*
         * Активно направление.
         *
         * Новият модел:
         *
         * D1 / D2 / D3 / ...
         *
         * Старият A/B формат остава като fallback.
         */
        const directionKey =
            line &&
            line.activeDirection
                ? line.activeDirection
                : (
                    line &&
                    Array.isArray(
                        line.directions
                    ) &&
                    line.directions.length
                        ? line.directions[0].key
                        : "A"
                );


        /*
         * Намираме GTFS информацията
         * за конкретното направление.
         */
        const routeDirections =
            data.directions &&
            data.directions[routeId]
                ? data.directions[
                    routeId
                ]
                : {};


        /*
         * Новият формат:
         *
         * data.directions[routeId][D1]
         *
         * Старият формат:
         *
         * data.directions[routeId].A/B
         */
        const directionData =
            routeDirections[
                directionKey
            ]
            || (
                directionKey === "B"
                    ? routeDirections.B
                    : routeDirections.A
            )
            || null;


        /*
         * Взимаме shape_id.
         */
        const shapeId =
            directionData
                ? String(
                    directionData.shape_id ||
                    ""
                ).trim()
                : "";


        /*
         * Намираме координатите на shape-а.
         */
        const coordinates =
            shapeId &&
            data.shapes &&
            Array.isArray(
                data.shapes[shapeId]
            )
                ? data.shapes[
                    shapeId
                ]
                : [];


        /*
         * Ако няма геометрия,
         * не създаваме празна карта.
         */
        if (!coordinates.length) {

            mapElement.innerHTML = `
                <div class="map-empty">
                    Няма налична геометрия за този маршрут.
                </div>
            `;

            return;

        }


        /*
         * Създаваме Leaflet карта.
         */
        lineMap =
            L.map(
                "lineMap",
                {
                    zoomControl: true,
                    attributionControl: true
                }
            );


        /*
         * OpenStreetMap tiles.
         */
        L.tileLayer(
            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            {
                maxZoom: 19,

                attribution:
                    "&copy; OpenStreetMap contributors"
            }
        ).addTo(lineMap);


        /*
         * Цветът на маршрута е цветът
         * на съответната линия.
         */
        const routeColor =
            getMapColor(line);


        /*
         * Реалният GTFS маршрут.
         *
         * ВАЖНО:
         *
         * Това е ЕДНА полилиния от shape-а.
         * Не свързваме спирките една с друга.
         */
        const routeLine =
            L.polyline(
                coordinates,
                {
                    color: routeColor,

                    /*
                     * Малко по-дебела линия.
                     */
                    weight: 8,

                    opacity: 1,

                    lineJoin:
                        "round",

                    lineCap:
                        "round"
                }
            ).addTo(
                lineMap
            );


        /*
         * Взимаме спирките на текущото
         * активно направление.
         */
        const activeStops =
            getActiveStops(
                line,
                stops
            );


        /*
         * Намираме координатите им
         * от GTFS stops.
         */
        const stopCoordinates =
            getStopCoordinates(
                data,
                activeStops
            );


        /*
         * Добавяме маркер за всяка спирка.
         */
        stopCoordinates.forEach(
            stop => {

                const marker =
                    L.circleMarker(
                        stop.coordinate,
                        {

                            /*
                             * Малка точка,
                             * за да не се превърне картата
                             * отново в "драсканица".
                             */
                            radius: 4,

                            color:
                                "#FFFFFF",

                            weight: 2,

                            fillColor:
                                routeColor,

                            fillOpacity: 1
                        }
                    )
                    .addTo(
                        lineMap
                    );


                /*
                 * При посочване на спирката
                 * показваме името ѝ.
                 */
                marker.bindTooltip(
                    stop.name,
                    {
                        direction:
                            "top",

                        sticky:
                            true
                    }
                );

            }
        );


        /*
         * Центрираме картата върху маршрута.
         */
        lineMap.fitBounds(
            routeLine.getBounds(),
            {
                padding:
                    [
                        30,
                        30
                    ]
            }
        );


        /*
         * Leaflet понякога се инициализира,
         * преди контейнерът да е получил
         * окончателния си размер.
         *
         * invalidateSize() оправя това.
         */
        setTimeout(
            () => {

                if (lineMap) {

                    lineMap.invalidateSize();

                }

            },
            100
        );


    } catch (error) {

        console.error(
            "Грешка при зареждане на картата:",
            error
        );


        removeExistingMap();


        mapElement.innerHTML = `
            <div class="map-empty">
                Картата временно не може да бъде заредена.
            </div>
        `;

    }

}
