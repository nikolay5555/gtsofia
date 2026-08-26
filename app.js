let lines = [];
let currentFilter = null;

function renderLines() {

    const grid = document.getElementById("linesGrid");
    const search = document.getElementById("searchInput").value.toLowerCase();

    grid.innerHTML = "";

    const typeOrder = {
        bus: 1,
        night: 2,
        trolleybus: 3,
        tram: 4,
        metro: 5
    };

    const sortedLines = [...lines].sort((a, b) => {

        const orderA = typeOrder[a.type] || 99;
        const orderB = typeOrder[b.type] || 99;

        if (orderA !== orderB) {
            return orderA - orderB;
        }

        return String(a.number || "").localeCompare(
            String(b.number || ""),
            undefined,
            {
                numeric: true,
                sensitivity: "base"
            }
        );
    });

    sortedLines
        .filter(l =>
            (!currentFilter || l.type === currentFilter) &&
            l.number.toLowerCase().includes(search)
        )
        .forEach(line => {

            if (line.type === "metro") {

                const el = document.createElement("div");
                el.className = "metro-pill";
                el.style.background = line.color;
                el.style.color = line.textColor;
                el.innerText = line.number;
                el.onclick = () => selectLine(line);
                grid.appendChild(el);

            } else {

                const el = document.createElement("div");
                el.className = "line-pill";
                el.style.background = line.color;
                el.innerText = line.number;
                el.onclick = () => selectLine(line);
                grid.appendChild(el);

            }

        });

}

function selectLine(line) {

    const activeDirection =
        line.activeDirection === "A"
            ? line.directionA
            : line.directionB;

    /*
     * directionA / directionB вече са обекти:
     *
     * {
     *     headsign,
     *     stops,
     *     shape_id
     * }
     *
     * Това запазва съществуващия интерфейс,
     * но позволява и на map.js да използва shape_id.
     */
    const direction =
        activeDirection
            ? activeDirection.headsign
            : "";

    const stops =
        activeDirection &&
        Array.isArray(activeDirection.stops)
            ? activeDirection.stops
            : [];

    const content =
        document.getElementById(
            "contentArea"
        );

    const pill =
        line.type === "metro"
            ? `
              <div class="details-pill">
                <div class="details-icon">
                  <img src="${line.icon}" />
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
                  <img src="${line.icon}" />
                </div>

                <div
                  class="details-number"
                  style="background:${line.color}"
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
                        src="https://raw.githubusercontent.com/nikolay5555/gtsofia/546fec48e624f1eadb3b6676d73d27e92d726e7c/Icons/destinationarrow.svg"
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

                ${stops.map(s => `
                    <div class="stop-item">

                        <div class="stop-dot"></div>

                        <div class="stop-name">
                            ${s.name}
                        </div>

                    </div>
                `).join("")}

            </div>

        </div>

        <!-- 🗺️ MAP -->
        <div class="map-card">
    <div class="map-title">Маршрут на линията</div>
    <div id="lineMap"></div>
</div>
    `;

    /*
     * Съществуващата система за известия
     * остава непроменена.
     */
    if (
        typeof showLineAlerts === "function"
    ) {
        showLineAlerts(
            line.number,
            line.type
        );
    }

    /*
     * Нова част:
     *
     * map.js използва shape_id от активното
     * направление и чертае реалния GTFS shape.
     */
    if (
        typeof renderLineMap === "function"
    ) {
        renderLineMap(line);
    }
}

function switchDirection(
    type,
    number
) {

    const line = lines.find(
        l =>
            l.type === type &&
            l.number === number
    );

    if (!line) {
        return;
    }

    line.activeDirection =
        line.activeDirection === "A"
            ? "B"
            : "A";

    /*
     * selectLine() ще:
     *
     * 1. покаже новото направление;
     * 2. покаже новите спирки;
     * 3. премахне старата карта;
     * 4. начертае shape-а на новото направление.
     */
    selectLine(line);
}

function setFilter(
    type,
    el
) {

    currentFilter = type;

    document
        .querySelectorAll(".filter-btn")
        .forEach(
            b =>
                b.classList.remove(
                    "active"
                )
        );

    if (el) {
        el.classList.add("active");
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

        renderLines();

        const params =
            new URLSearchParams(
                window.location.search
            );

        const selectedLine =
            params.get("line");

        if (selectedLine) {

            const [
                type,
                number
            ] = selectedLine.split(":");

            const line =
                lines.find(
                    l =>
                        l.type === type &&
                        l.number === number
                );

            if (line) {
                selectLine(line);
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
    .getElementById("searchInput")
    .addEventListener(
        "input",
        renderLines
    );

initializeTransportPage();
