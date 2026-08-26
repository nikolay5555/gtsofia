let scheduleLines = [];
let selectedScheduleLine = null;
let selectedDirectionKey = null;
let selectedStopIndex = 0;
let selectedDayType = "weekday";
let selectedCourse = null;

const typeLabels = {
  bus: "Автобуси",
  trolleybus: "Тролейбуси",
  tram: "Трамваи",
  metro: "Метролинии",
  night: "Нощни линии"
};

const typeOrder = [
  "bus",
  "trolleybus",
  "tram",
  "metro",
  "night"
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseTime(value) {
  const match = String(value || "").match(
    /^(\d+):(\d{2})(?::(\d{2}))?$/
  );

  if (!match) {
    return null;
  }

  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3] || 0)
  );
}

function formatTime(value) {
  const match = String(value || "").match(
    /^(\d+):(\d{2})/
  );

  if (!match) {
    return "—";
  }

  /*
   * GTFS позволява часове над 23:00:
   * 24:xx -> 00:xx
   * 25:xx -> 01:xx
   * 26:xx -> 02:xx
   * 27:xx -> 03:xx
   */
  const hour = Number(match[1]) % 24;

  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function linePillHtml(line) {
  if (line.type === "metro") {
    return `
      <span
        class="schedule-line-pill metro"
        style="background:${line.color};color:${line.textColor}"
      >
        ${escapeHtml(line.number)}
      </span>`;
  }

  return `
    <span
      class="schedule-line-pill"
      style="background:${line.color}"
    >
      ${escapeHtml(line.number)}
    </span>`;
}

function lineIdentityHtml(line) {
  return `
    <span class="schedule-line-identity">
      <span class="schedule-line-icon">
        <img src="${escapeHtml(line.icon)}" alt="" />
      </span>

      ${linePillHtml(line)}
    </span>`;
}

function renderLineDropdown() {
  const menu = document.getElementById(
    "lineDropdownMenu"
  );

  menu.innerHTML = "";

  for (const type of typeOrder) {
    const lines = scheduleLines
      .filter(
        line => line.type === type
      )
      .sort(
        (a, b) =>
          String(a.number).localeCompare(
            String(b.number),
            "bg",
            {
              numeric: true,
              sensitivity: "base"
            }
          )
      );

    if (!lines.length) {
      continue;
    }

    const group =
      document.createElement("div");

    group.className =
      "schedule-dropdown-group";

    group.innerHTML = `
      <div class="schedule-dropdown-group-title">
        ${typeLabels[type]}
      </div>`;

    for (const line of lines) {
      const item =
        document.createElement("button");

      item.type = "button";

      item.className =
        "schedule-line-option";

      item.innerHTML = `
        ${lineIdentityHtml(line)}
        <span class="schedule-option-arrow">›</span>`;

      item.addEventListener(
        "click",
        () => selectScheduleLine(line)
      );

      group.appendChild(item);
    }

    menu.appendChild(group);
  }
}

function openLineDropdown() {
  const button =
    document.getElementById(
      "lineDropdownButton"
    );

  const menu =
    document.getElementById(
      "lineDropdownMenu"
    );

  const isOpen =
    !menu.hidden;

  menu.hidden =
    isOpen;

  button.setAttribute(
    "aria-expanded",
    String(!isOpen)
  );
}

function closeLineDropdown() {
  document.getElementById(
    "lineDropdownMenu"
  ).hidden = true;

  document.getElementById(
    "lineDropdownButton"
  ).setAttribute(
    "aria-expanded",
    "false"
  );
}

function selectScheduleLine(line) {
  selectedScheduleLine =
    line;

  selectedDirectionKey =
    line.directions?.[0]?.key
      || "A";

  selectedStopIndex = 0;
  selectedCourse = null;

  closeLineDropdown();

  const button =
    document.getElementById(
      "lineDropdownButton"
    );

  button
    .querySelector(
      ".schedule-placeholder"
    )
    ?.remove();

  button
    .querySelector(
      ".schedule-selected-line"
    )
    ?.remove();

  const chevron =
    button.querySelector(
      ".schedule-chevron"
    );

  const selected =
    document.createElement(
      "span"
    );

  selected.className =
    "schedule-selected-line";

  selected.innerHTML =
    lineIdentityHtml(line);

  button.insertBefore(
    selected,
    chevron
  );

  renderDirections();
  renderSchedule();
}

function getSelectedDirection() {
  if (!selectedScheduleLine) {
    return null;
  }

  const directions =
    Array.isArray(
      selectedScheduleLine.directions
    )
      ? selectedScheduleLine.directions
      : [];

  if (directions.length) {
    return (
      directions.find(
        direction =>
          direction.key ===
          selectedDirectionKey
      )
      || directions[0]
      || null
    );
  }

  return (
    selectedScheduleLine[
      selectedDirectionKey === "A"
        ? "directionA"
        : "directionB"
    ] || null
  );
}

function renderDirections() {
  const select =
    document.getElementById(
      "directionSelect"
    );

  const directions =
    Array.isArray(
      selectedScheduleLine?.directions
    )
      ? selectedScheduleLine.directions
      : [];

  if (directions.length) {
    if (
      !directions.some(
        direction =>
          direction.key ===
          selectedDirectionKey
      )
    ) {
      selectedDirectionKey =
        directions[0].key;
    }

    select.innerHTML =
      directions
        .filter(
          direction =>
            direction &&
            direction.headsign
        )
        .map(
          direction => `
            <option value="${escapeHtml(
              direction.key
            )}">
              ${escapeHtml(
                direction.headsign
              )}
            </option>`
        )
        .join("");

    select.disabled =
      !directions.length;

    select.value =
      selectedDirectionKey || "";

    renderStops();

    return;
  }

  const directionA =
    selectedScheduleLine?.directionA;

  const directionB =
    selectedScheduleLine?.directionB;

  const legacyDirections = [
    ["A", directionA],
    ["B", directionB]
  ].filter(
    ([, direction]) =>
      direction &&
      direction.headsign
  );

  select.innerHTML =
    legacyDirections
      .map(
        ([key, direction]) => `
          <option value="${key}">
            ${escapeHtml(
              direction.headsign
            )}
          </option>`
      )
      .join("");

  select.disabled =
    !legacyDirections.length;

  if (
    !legacyDirections.some(
      ([key]) =>
        key === selectedDirectionKey
    )
  ) {
    selectedDirectionKey =
      legacyDirections[0]?.[0]
      || "A";
  }

  select.value =
    selectedDirectionKey;

  renderStops();
}

function renderStops() {
  const select =
    document.getElementById(
      "stopSelect"
    );

  const direction =
    getSelectedDirection();

  const stops =
    direction?.stops || [];

  select.innerHTML =
    stops
      .map(
        (stop, index) => `
          <option value="${index}">
            ${index + 1}. ${escapeHtml(
              stop.name
            )}
          </option>`
      )
      .join("");

  select.disabled =
    !stops.length;

  selectedStopIndex =
    Math.min(
      selectedStopIndex,
      Math.max(
        0,
        stops.length - 1
      )
    );

  if (stops.length) {
    select.value =
      String(
        selectedStopIndex
      );
  }
}

function getCourses() {
  if (!selectedScheduleLine) {
    return [];
  }

  const schedules =
    window.transportData?.schedules
    || {};

  const routeSchedule =
    schedules[
      selectedScheduleLine.id
    ];

  /*
   * Новият модел:
   *
   * D1 / D2 / D3 / ...
   */
  if (
    routeSchedule &&
    routeSchedule[
      selectedDirectionKey
    ]
  ) {
    return (
      routeSchedule[
        selectedDirectionKey
      ]?.[
        selectedDayType
      ] || []
    );
  }

  /*
   * Стар fallback.
   */
  const legacyKey =
    selectedDirectionKey === "B"
      ? "B"
      : "A";

  const directionSchedule =
    routeSchedule?.[
      legacyKey
    ];

  return (
    directionSchedule?.[
      selectedDayType
    ] || []
  );
}

function getStopTime(
  course,
  index
) {
  return (
    course?.times?.[index] ||
    ""
  );
}

function renderSummary(courses) {
  const summary =
    document.getElementById(
      "scheduleSummary"
    );

  if (
    !selectedScheduleLine ||
    !getSelectedDirection()
  ) {
    summary.hidden = true;
    return;
  }

  const direction =
    getSelectedDirection();

  /*
   * Търсим всички реални времена за
   * избраната спирка.
   *
   * Това е важно при partial directions,
   * където курсът може да има null
   * за конкретна спирка.
   */
  const validTimes = courses
    .map(
      course =>
        getStopTime(
          course,
          selectedStopIndex
        )
    )
    .filter(
      time =>
        parseTime(time) !== null
    )
    .sort(
      (a, b) =>
        parseTime(a) -
        parseTime(b)
    );

  const first =
    validTimes.length
      ? formatTime(
          validTimes[0]
        )
      : "—";

  const last =
    validTimes.length
      ? formatTime(
          validTimes[
            validTimes.length - 1
          ]
        )
      : "—";

  const stop =
    direction.stops?.[
      selectedStopIndex
    ];

  const courseCount =
    validTimes.length;

  summary.innerHTML = `
    <div class="schedule-summary-main">
      <div class="schedule-summary-route-row">
        ${lineIdentityHtml(
          selectedScheduleLine
        )}

        <img
          class="direction-arrow"
          src="https://raw.githubusercontent.com/nikolay5555/gtsofia/89507f07b1a7e7c1e6c1802db7ad502bd18fa63f/Icons/destinationarrow.svg"
          alt=""
        />

        <strong class="schedule-summary-destination">
          ${escapeHtml(
            direction.headsign
          )}
        </strong>
      </div>

      <span class="schedule-summary-stop">
        От спирка: ${escapeHtml(
          stop?.name || ""
        )}
      </span>
    </div>

    <div class="schedule-summary-stats">
      <div>
        <span>Първи курс</span>
        <strong>${first}</strong>
      </div>

      <div>
        <span>Последен курс</span>
        <strong>${last}</strong>
      </div>

      <div>
        <span>Общо курсове</span>
        <strong>${courseCount}</strong>
      </div>
    </div>
  `;

  summary.hidden = false;
}

function renderTimetable(courses) {
  const section =
    document.getElementById(
      "timetableSection"
    );

  const container =
    document.getElementById(
      "timetableContainer"
    );

  section.hidden = false;

  if (!courses.length) {
    container.innerHTML = `
      <div class="schedule-no-data">
        Няма налични курсове за избрания ден.
      </div>`;

    return;
  }

  const byHour =
    new Map();

  for (const course of courses) {
    const time =
      getStopTime(
        course,
        selectedStopIndex
      );

    const seconds =
      parseTime(time);

    if (seconds == null) {
      continue;
    }

    /*
     * Нормализиране на GTFS часовете:
     *
     * 23:xx -> 23:xx
     * 24:xx -> 00:xx
     * 25:xx -> 01:xx
     * 26:xx -> 02:xx
     * 27:xx -> 03:xx
     */

    const hour =
      Math.floor(
        seconds / 3600
      ) % 24;

    const minute =
      Math.floor(
        (seconds % 3600) / 60
      );

    if (!byHour.has(hour)) {
      byHour.set(
        hour,
        []
      );
    }

    byHour
      .get(hour)
      .push({
        minute,
        course
      });
  }

  /*
   * Определяме реалния първи час,
   * в който има курс.
   */

  const availableHours = [
    ...byHour.keys()
  ];

  const firstHour =
    availableHours.length
      ? availableHours[0]
      : 0;

  const hours =
    availableHours.sort(
      (a, b) =>
        (
          (
            a -
            firstHour +
            24
          ) % 24
        ) -
        (
          (
            b -
            firstHour +
            24
          ) % 24
        )
    );

  /*
   * Първият ред показва само часа.
   */

  const header =
    hours
      .map(
        hour =>
          `<th>${hour}</th>`
      )
      .join("");

  /*
   * Всеки час е отделна колонка.
   */

  const cells =
    hours
      .map(hour => {
        const entries =
          byHour
            .get(hour)
            .sort(
              (a, b) =>
                a.minute -
                b.minute
            );

        return `
          <td>
            <div class="schedule-minute-list">
              ${entries
                .map(entry => {
                  const label =
                    String(
                      entry.minute
                    ).padStart(
                      2,
                      "0"
                    );

                  return `
                    <button
                      class="schedule-minute"
                      type="button"
                      data-trip-id="${escapeHtml(
                        entry.course.trip_id
                      )}"
                    >
                      ${label}
                    </button>`;
                })
                .join("")}
            </div>
          </td>`;
      })
      .join("");

  container.innerHTML = `
    <table class="schedule-timetable">
      <thead>
        <tr>
          ${header}
        </tr>
      </thead>

      <tbody>
        <tr>
          ${cells}
        </tr>
      </tbody>
    </table>`;

  container
    .querySelectorAll(
      ".schedule-minute"
    )
    .forEach(button => {
      button.addEventListener(
        "click",
        () => {
          const course =
            courses.find(
              item =>
                String(
                  item.trip_id
                ) ===
                String(
                  button.dataset.tripId
                )
            );

          if (course) {
            showCourse(course);
          }
        }
      );
    });
}

function showCourse(course) {
  selectedCourse =
    course;

  const section =
    document.getElementById(
      "courseSection"
    );

  const container =
    document.getElementById(
      "courseStops"
    );

  const direction =
    getSelectedDirection();

  const stops =
    direction?.stops || [];

  container.innerHTML =
    stops
      .map(
        (stop, index) => {
          const time =
            course.times?.[
              index
            ] || "";

          const selected =
            index ===
            selectedStopIndex;

          return `
            <div
              class="course-stop ${
                selected
                  ? "selected"
                  : ""
              }"
            >
              <div class="course-stop-marker"></div>

              <div class="course-stop-name">
                ${escapeHtml(
                  stop.name
                )}
              </div>

              <div class="course-stop-time">
                ${formatTime(
                  time
                )}
              </div>
            </div>`;
        }
      )
      .join("");

  section.hidden = false;

  section.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function renderSchedule() {
  const empty =
    document.getElementById(
      "scheduleEmpty"
    );

  if (!selectedScheduleLine) {
    empty.hidden = false;

    document.getElementById(
      "scheduleSummary"
    ).hidden = true;

    document.getElementById(
      "timetableSection"
    ).hidden = true;

    document.getElementById(
      "courseSection"
    ).hidden = true;

    return;
  }

  empty.hidden = true;

  const courses =
    getCourses();

  renderStops();

  renderSummary(
    courses
  );

  renderTimetable(
    courses
  );

  document.getElementById(
    "courseSection"
  ).hidden = true;
}

async function initializeSchedules() {
  try {
    const data =
      await loadTransportData();

    scheduleLines =
      convertGtfsRoutes(
        data.routes || [],
        data.trips || [],
        data.directions || {}
      );

    window.scheduleLines =
      scheduleLines;

    renderLineDropdown();

  } catch (error) {
    console.error(error);

    document.getElementById(
      "scheduleEmpty"
    ).textContent =
      "Разписанията не могат да бъдат заредени в момента.";
  }
}

document.addEventListener(
  "DOMContentLoaded",
  () => {
    document
      .getElementById(
        "lineDropdownButton"
      )
      .addEventListener(
        "click",
        openLineDropdown
      );

    document.addEventListener(
      "click",
      event => {
        if (
          !event.target.closest(
            "#lineDropdown"
          )
        ) {
          closeLineDropdown();
        }
      }
    );

    document
      .getElementById(
        "directionSelect"
      )
      .addEventListener(
        "change",
        event => {
          selectedDirectionKey =
            event.target.value;

          selectedStopIndex =
            0;

          selectedCourse =
            null;

          renderSchedule();
        }
      );

    document
      .getElementById(
        "stopSelect"
      )
      .addEventListener(
        "change",
        event => {
          selectedStopIndex =
            Number(
              event.target.value
            );

          selectedCourse =
            null;

          renderSchedule();
        }
      );

    document
      .querySelectorAll(
        ".schedule-day-tab"
      )
      .forEach(button => {
        button.addEventListener(
          "click",
          () => {
            document
              .querySelectorAll(
                ".schedule-day-tab"
              )
              .forEach(item =>
                item.classList.remove(
                  "active"
                )
              );

            button.classList.add(
              "active"
            );

            selectedDayType =
              button.dataset.dayType;

            selectedCourse =
              null;

            renderSchedule();
          }
        );
      });

    document
      .getElementById(
        "closeCourseButton"
      )
      .addEventListener(
        "click",
        () => {
          document.getElementById(
            "courseSection"
          ).hidden = true;

          selectedCourse =
            null;
        }
      );

    initializeSchedules();
  }
);
