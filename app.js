let lines = [];
let currentFilter = null;

function renderLines() {

    const grid =
        document.getElementById(
            "linesGrid"
        );

    const search =
        document
            .getElementById(
                "searchInput"
            )
            .value
            .toLowerCase();

    grid.innerHTML = "";

    const typeOrder = {
        bus: 1,
        night: 2,
        trolleybus: 3,
        tram: 4,
        metro: 5
    };

    const sortedLines =
        [...lines].sort(
            (a, b) => {

                const orderA =
                    typeOrder[
                        a.type
                    ] || 99;

                const orderB =
                    typeOrder[
                        b.type
                    ] || 99;

                if (
                    orderA !==
                    orderB
                ) {

                    return (
                        orderA -
                        orderB
                    );

                }

                return String(
                    a.number || ""
                ).localeCompare(
                    String(
                        b.number || ""
                    ),
                    undefined,
                    {
                        numeric: true,
                        sensitivity:
                            "base"
                    }
                );

            }
        );

    sortedLines
        .filter(
            l =>
                (
                    !currentFilter
                    || l.type ===
                       currentFilter
                )
                &&
                l.number
                    .toLowerCase()
                    .includes(
                        search
                    )
        )
        .forEach(
            line => {

                if (
                    line.type ===
                    "metro"
                ) {

                    const el =
                        document.createElement(
                            "div"
                        );

                    el.className =
                        "metro-pill";

                    el.style.background =
                        line.color;

                    el.style.color =
                        line.textColor;

                    el.innerText =
                        line.number;

                    el.onclick =
                        () =>
                            selectLine(
                                line
                            );

                    grid.appendChild(
                        el
                    );

                } else {

                    const el =
                        document.createElement(
                            "div"
                        );

                    el.className =
                        "line-pill";

                    el.style.background =
                        line.color;

                    el.innerText =
                        line.number;

                    el.onclick =
                        () =>
                            selectLine(
                                line
                            );

                    grid.appendChild(
                        el
                    );

                }

            }
        );

}


function getActiveDirection(
    line
) {

    /*
     * Новият модел използва:
     *
     * line.directions = [
     *   {
     *     key: "D1",
     *     headsign: "...",
     *     stops: [...]
     *   },
     *   ...
     * ]
     */

    if (
        Array.isArray(
            line?.directions
        )
        &&
        line.directions.length
    ) {

        const selected =
            line.directions.find(
                direction =>
                    direction.key ===
                    line.activeDirection
            );

        if (selected) {
            return selected;
        }

        return (
            line.directions[0]
            || null
        );

    }


    /*
     * Стар A/B fallback.
     *
     * Това не пречи на новия формат,
     * но позволява на стари данни да
     * продължат да работят.
     */

    if (
        line?.activeDirection ===
        "B"
    ) {

        return (
            line.directionB
            || null
        );

    }

    return (
        line.directionA
        || null
    );

}


function selectLine(
    line
) {

    /*
     * Уверяваме се, че винаги има
     * валидно избрано направление.
     */

    if (
        Array.isArray(
            line?.directions
        )
        &&
        line.directions.length
    ) {

        const exists =
            line.directions.some(
                direction =>
                    direction.key ===
                    line.activeDirection
            );

        if (!exists) {

            line.activeDirection =
                line.directions[0].key;

        }

    } else {

        if (
            line.activeDirection !==
                "A"
            &&
            line.activeDirection !==
                "B"
        ) {

            line.activeDirection =
                "A";

        }

    }


    const activeDirection =
        getActiveDirection(
            line
        );


    const direction =
        activeDirection
            ? activeDirection.headsign
            : "";


    const stops =
        activeDirection
        &&
        Array.isArray(
            activeDirection.stops
        )
            ? activeDirection.stops
            : [];


    const content =
        document.getElementById(
            "contentArea"
        );


    const pill =
        line.type ===
        "metro"
            ? `
              <div class="details-pill">
                <div class="details-icon">
                  <img
                    src="${line.icon}"
                  />
                </div>

                <div
                  class="metro-pill"
                  style="
                    background:${line.color};
                    color:${line.textColor};
                  "
                >
                  ${line.number}
                </div>
              </div>
            `
            : `
              <div class="details-pill">
                <div class="details-icon">
                  <img
                    src="${line.icon}"
                  />
                </div>

                <div
                  class="details-number"
                  style="
                    background:${line.color}
                  "
                >
                  ${line.number}
                </div>
              </div>
            `;


    content.innerHTML = `
        <div class="line-header">

            <div class="line-left">

                <div class="route-direction">

                    ${pill}

                    <img
                        class="direction-arrow"
                        src="https://raw.githubusercontent.com/nikolay5555/gtsofia/fd82ebee531e36adfd1f59f2ba9d5b8dbc33aba4/Icons/destinationarrow.svg"
                    />

                    <div class="destination-name">
                        ${direction}
                    </div>

                </div>

            </div>


            <button
                class="switch-btn"
                onclick="switchDirection('${line.type}', '${line.number}')"
            >
                Промяна на посоката
            </button>

        </div>


        <!-- 🚧 ALERT SLOT -->

        <div id="lineAlerts"></div>


        <div class="stops-card">

            <div class="stops-line">

                ${stops.map(
                    stop => `
                        <div class="stop-item">

                            <div class="stop-dot"></div>

                            <div class="stop-name">
                                ${stop.name}
                            </div>

                        </div>
                    `
                ).join("")}

            </div>

        </div>


        <!-- 🗺️ MAP -->

        <div class="map-card">

            <div class="map-title">
                Маршрут на линията
            </div>

            <div id="lineMap"></div>

        </div>
    `;


    /*
     * Съществуващата система за известия
     * остава непроменена.
     */

    if (
        typeof showLineAlerts ===
        "function"
    ) {

        showLineAlerts(
            line.number,
            line.type
        );

    }


    /*
     * map.js вече използва
     * line.activeDirection:
     *
     * D1 / D2 / D3...
     *
     * вместо само A/B.
     */

    if (
        typeof renderLineMap ===
        "function"
    ) {

        renderLineMap(
            line,
            stops
        );

    }

}


function switchDirection(
    type,
    number
) {

    const line =
        lines.find(
            l =>
                l.type ===
                    type
                &&
                l.number ===
                    number
        );


    if (!line) {
        return;
    }


    /*
     * Новият модел:
     *
     * D1 → D2 → D3 → ...
     *
     * Така не ограничаваме
     * линията изкуствено до A/B.
     */

    if (
        Array.isArray(
            line.directions
        )
        &&
        line.directions.length
    ) {

        const currentIndex =
            line.directions.findIndex(
                direction =>
                    direction.key ===
                    line.activeDirection
            );


        const nextIndex =
            currentIndex < 0
                ? 0
                : (
                    currentIndex + 1
                )
                  %
                  line.directions.length;


        line.activeDirection =
            line.directions[
                nextIndex
            ].key;


    } else {

        /*
         * Стар A/B fallback.
         */

        line.activeDirection =
            line.activeDirection ===
                "A"
                ? "B"
                : "A";

    }


    selectLine(
        line
    );

}


function setFilter(
    type,
    el
) {

    currentFilter =
        type;


    document
        .querySelectorAll(
            ".filter-btn"
        )
        .forEach(
            button =>
                button.classList.remove(
                    "active"
                )
        );


    if (el) {

        el.classList.add(
            "active"
        );

    }


    renderLines();

}


async function initializeTransportPage() {

    try {

        const gtfsLines =
            await loadTransportLines();


        /*
         * Запазваме съществуващата логика:
         *
         * старият масив lines се изчиства,
         * след което се зареждат актуалните GTFS линии.
         */

        lines.length = 0;


        lines.push(
            ...gtfsLines
        );


        /*
         * Уверяваме се, че всяка линия
         * има валидно начално направление.
         */

        lines.forEach(
            line => {

                if (
                    Array.isArray(
                        line.directions
                    )
                    &&
                    line.directions.length
                ) {

                    const hasCurrent =
                        line.directions.some(
                            direction =>
                                direction.key ===
                                line.activeDirection
                        );

                    if (!hasCurrent) {

                        line.activeDirection =
                            line.directions[0].key;

                    }

                } else {

                    if (
                        line.activeDirection !==
                            "A"
                        &&
                        line.activeDirection !==
                            "B"
                    ) {

                        line.activeDirection =
                            "A";

                    }

                }

            }
        );


        renderLines();


        const params =
            new URLSearchParams(
                window.location.search
            );


        const selectedLine =
            params.get(
                "line"
            );


        if (selectedLine) {

            const [
                type,
                number
            ] =
                selectedLine.split(
                    ":"
                );


            const line =
                lines.find(
                    l =>
                        l.type ===
                            type
                        &&
                        l.number ===
                            number
                );


            if (line) {

                selectLine(
                    line
                );

            }

        }


    } catch (error) {

        console.error(
            "Неуспешно зареждане на GTFS:",
            error
        );

    }

}


document
    .getElementById(
        "searchInput"
    )
    .addEventListener(
        "input",
        renderLines
    );


initializeTransportPage();
