let scheduleLines = [];
let selectedScheduleLine = null;
let selectedDirectionKey = null;
let selectedStopIndex = 0;
let selectedDayType = "weekday";
let selectedCourse = null;

const typeLabels = {
  bus: "Автобус",
  trolleybus: "Тролейбус",
  tram: "Трамвай",
  metro: "Метро",
  night: "Нощен"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parseTime(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();

  if (!text) {
    return null;
  }

  const parts = text.split(":").map(Number);

  if (
    parts.length !== 2 &&
    parts.length !== 3
  ) {
    return null;
  }

  let hours;
  let minutes;
  let seconds;

  if (parts.length === 2) {
    [hours, minutes] = parts;
    seconds = 0;
  } else {
    [hours, minutes, seconds] = parts;
  }

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds)
  ) {
    return null;
  }

  return (
    hours * 3600 +
    minutes * 60 +
    seconds
  );
}

function formatTime(value) {
  const seconds = parseTime(value);

  if (seconds == null) {
    return "—";
  }

  const totalMinutes =
    Math.floor(seconds / 60) % (24 * 60);

  const hours =
    Math.floor(totalMinutes / 60);

  const minutes =
    totalMinutes % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function linePillHtml(line) {
  const type =
    line?.route_type ||
    line?.type ||
    "bus";

  const label =
    typeLabels[type] ||
    "Транспорт";

  return `
    <span class="line-type-pill">
      ${escapeHtml(label)}
    </span>`;
}

function lineIdentityHtml(line) {
  const name =
    line?.short_name ||
    line?.name ||
    line?.route_short_name ||
    line?.id ||
    "";

  return `
    <div class="line-identity">
      <span class="line-number">
        ${escapeHtml(name)}
      </span>
      ${linePillHtml(line)}
    </div>`;
}

function getLineDisplayName(line) {
  return (
    line?.short_name ||
    line?.name ||
    line?.route_short_name ||
    line?.id ||
    ""
  );
}

function getDirectionLabel(direction) {
  return (
    direction?.label ||
    direction?.name ||
    direction?.headsign ||
    direction?.direction_name ||
    ""
  );
}

function getDirectionKey(direction, index) {
  return (
    direction?.direction_id ??
    direction?.id ??
    direction?.key ??
    index
  );
}

function getSelectedDirection() {
  if (!selectedScheduleLine) {
    return null;
  }

  const directions =
    selectedScheduleLine.directions ||
    selectedScheduleLine.direction_variants ||
    [];

  if (!directions.length) {
    return null;
  }

  const found =
    directions.find(
      (direction, index) =>
        String(
          getDirectionKey(
            direction,
            index
          )
        ) ===
        String(selectedDirectionKey)
    );

  return (
    found ||
    directions[0]
  );
}

function getDirectionStops(direction) {
  if (!direction) {
    return [];
  }

  return (
    direction.stops ||
    direction.stop_times ||
    direction.stopSequence ||
    []
  );
}

function getStopName(stop) {
  if (typeof stop === "string") {
    return stop;
  }

  return (
    stop?.name ||
    stop?.stop_name ||
    stop?.stopName ||
    stop?.title ||
    stop?.id ||
    ""
  );
}

function getStopId(stop) {
  if (typeof stop === "string") {
    return stop;
  }

  return (
    stop?.stop_id ||
    stop?.stopId ||
    stop?.id ||
    ""
  );
}

function getStopTime(course, stopIndex) {
  if (!course) {
    return null;
  }

  const times =
    Array.isArray(course.times)
      ? course.times
      : [];

  return times[stopIndex] ?? null;
}

function getCoursesForDirection(direction) {
  if (!direction) {
    return [];
  }

  const courses =
    direction.courses ||
    direction.trips ||
    direction.schedule ||
    [];

  if (!Array.isArray(courses)) {
    return [];
  }

  return courses;
}

function isPartialCourse(course) {
  const times =
    Array.isArray(course?.times)
      ? course.times
      : [];

  if (!times.length) {
    return false;
  }

  let lastRealIndex = -1;

  for (
    let index = 0;
    index < times.length;
    index++
  ) {
    if (
      times[index] !== null &&
      times[index] !== undefined &&
      String(times[index]).trim() !== ""
    ) {
      lastRealIndex = index;
    }
  }

  if (lastRealIndex < 0) {
    return false;
  }

  for (
    let index = lastRealIndex + 1;
    index < times.length;
    index++
  ) {
    if (
      times[index] === null ||
      times[index] === undefined ||
      String(times[index]).trim() === ""
    ) {
      return true;
    }
  }

  return false;
}

function getCourseMinuteStyle(course) {
  if (!isPartialCourse(course)) {
    return "";
  }

  return `
    background:#dc3545;
    color:#ffffff;
    border-color:#dc3545;
  `;
}

function populateLineDropdown() {
  const select =
    document.getElementById(
      "scheduleLineSelect"
    );

  if (!select) {
    return;
  }

  select.innerHTML = `
    <option value="">
      Избери линия
    </option>
    ${scheduleLines
      .map(
        (line, index) => `
          <option value="${index}">
            ${escapeHtml(
              getLineDisplayName(line)
            )}
          </option>`
      )
      .join("")}
  `;
}

function openLineDropdown() {
  const wrapper =
    document.querySelector(
      ".schedule-line-dropdown"
    );

  if (!wrapper) {
    return;
  }

  wrapper.classList.add("open");
}

function closeLineDropdown() {
  const wrapper =
    document.querySelector(
      ".schedule-line-dropdown"
    );

  if (!wrapper) {
    return;
  }

  wrapper.classList.remove("open");
}

function renderLineOptions() {
  const container =
    document.getElementById(
      "scheduleLineOptions"
    );

  if (!container) {
    return;
  }

  container.innerHTML =
    scheduleLines
      .map(
        (line, index) => `
          <button
            type="button"
            class="schedule-line-option"
            data-line-index="${index}"
          >
            ${lineIdentityHtml(line)}
          </button>`
      )
      .join("");

  container
    .querySelectorAll(
      ".schedule-line-option"
    )
    .forEach(button => {
      button.addEventListener(
        "click",
        () => {
          const index =
            Number(
              button.dataset.lineIndex
            );

          selectScheduleLine(
            index
          );

          closeLineDropdown();
        }
      );
    });
}

function selectScheduleLine(index) {
  const line =
    scheduleLines[index];

  if (!line) {
    return;
  }

  selectedScheduleLine = line;

  const directions =
    line.directions ||
    line.direction_variants ||
    [];

  if (directions.length) {
    selectedDirectionKey =
      getDirectionKey(
        directions[0],
        0
      );
  } else {
    selectedDirectionKey = null;
  }

  selectedStopIndex = 0;
  selectedCourse = null;

  renderSelectedLine();
  renderDirections();
  renderSchedule();
}

function renderSelectedLine() {
  const selected =
    document.getElementById(
      "selectedScheduleLine"
    );

  if (!selected) {
    return;
  }

  if (!selectedScheduleLine) {
    selected.innerHTML = `
      <span class="schedule-select-placeholder">
        Избери линия
      </span>`;

    return;
  }

  selected.innerHTML =
    lineIdentityHtml(
      selectedScheduleLine
    );
}

function renderDirections() {
  const select =
    document.getElementById(
      "scheduleDirectionSelect"
    );

  if (!select) {
    return;
  }

  const directions =
    selectedScheduleLine?.directions ||
    selectedScheduleLine?.direction_variants ||
    [];

  select.innerHTML =
    directions
      .map(
        (direction, index) => {
          const key =
            getDirectionKey(
              direction,
              index
            );

          const label =
            getDirectionLabel(
              direction
            );

          return `
            <option
              value="${escapeHtml(key)}"
              ${
                String(key) ===
                String(selectedDirectionKey)
                  ? "selected"
                  : ""
              }
            >
              ${escapeHtml(label)}
            </option>`;
        }
      )
      .join("");

  if (!directions.length) {
    select.innerHTML = `
      <option value="">
        Няма направления
      </option>`;
  }
}

function renderStops() {
  const direction =
    getSelectedDirection();

  const stops =
    getDirectionStops(
      direction
    );

  const select =
    document.getElementById(
      "scheduleStopSelect"
    );

  if (!select) {
    return;
  }

  select.innerHTML =
    stops
      .map(
        (stop, index) => `
          <option
            value="${index}"
            ${
              index === selectedStopIndex
                ? "selected"
                : ""
            }
          >
            ${escapeHtml(
              getStopName(stop)
            )}
          </option>`
      )
      .join("");

  if (!stops.length) {
    select.innerHTML = `
      <option value="">
        Няма спирки
      </option>`;
  }
}

function getDayTypeLabel(dayType) {
  const labels = {
    weekday: "Делник",
    saturday: "Събота",
    sunday: "Неделя"
  };

  return (
    labels[dayType] ||
    dayType
  );
}

function getCoursesForDay(
  direction,
  dayType
) {
  if (!direction) {
    return [];
  }

  const byDay =
    direction.coursesByDay ||
    direction.byDay ||
    direction.scheduleByDay;

  if (
    byDay &&
    Array.isArray(byDay[dayType])
  ) {
    return byDay[dayType];
  }

  const courses =
    getCoursesForDirection(
      direction
    );

  return courses.filter(
    course => {
      if (!course) {
        return false;
      }

      const courseDay =
        course.day_type ||
        course.dayType ||
        course.service_type ||
        course.serviceType;

      if (!courseDay) {
        return true;
      }

      if (
        Array.isArray(courseDay)
      ) {
        return courseDay.includes(
          dayType
        );
      }

      return (
        String(courseDay) ===
        String(dayType)
      );
    }
  );
}

function renderStopList(
  direction
) {
  const stops =
    getDirectionStops(
      direction
    );

  const container =
    document.getElementById(
      "scheduleStops"
    );

  if (!container) {
    return;
  }

  if (!stops.length) {
    container.innerHTML = `
      <div class="schedule-no-data">
        Няма налични спирки.
      </div>`;

    return;
  }

  container.innerHTML = `
    <div class="schedule-stop-list">
      ${stops
        .map(
          (stop, index) => `
            <button
              type="button"
              class="schedule-stop-item ${
                index === selectedStopIndex
                  ? "active"
                  : ""
              }"
              data-stop-index="${index}"
            >
              <span class="schedule-stop-number">
                ${index + 1}
              </span>

              <span class="schedule-stop-name">
                ${escapeHtml(
                  getStopName(stop)
                )}
              </span>
            </button>`
        )
        .join("")}
    </div>`;

  container
    .querySelectorAll(
      ".schedule-stop-item"
    )
    .forEach(button => {
      button.addEventListener(
        "click",
        () => {
          selectedStopIndex =
            Number(
              button.dataset.stopIndex
            );

          renderSchedule();
        }
      );
    });
}

function renderSummary(
  courses
) {
  const summary =
    document.getElementById(
      "scheduleSummary"
    );

  if (!summary) {
    return;
  }

  if (!courses.length) {
    summary.hidden = true;
    summary.innerHTML = "";
    return;
  }

  const times =
    courses
      .map(course =>
        getStopTime(
          course,
          selectedStopIndex
        )
      )
      .filter(
        time =>
          parseTime(time) != null
      )
      .sort(
        (a, b) =>
          parseTime(a) -
          parseTime(b)
      );

  if (!times.length) {
    summary.hidden = true;
    summary.innerHTML = "";
    return;
  }

  const first =
    formatTime(times[0]);

  const last =
    formatTime(
      times[times.length - 1]
    );

  const courseCount =
    courses.length;

  summary.innerHTML = `
    <div class="schedule-summary-grid">
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

  const availableHours =
    [
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

  const header =
    hours
      .map(
        hour =>
          `<th>${hour}</th>`
      )
      .join("");

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

                  const partialStyle =
                    getCourseMinuteStyle(
                      entry.course
                    );

                  /*
                   * КЛЮЧОВАТА ПРОМЯНА:
                   *
                   * Не използваме trip_id за намиране
                   * на курса, защото няколко курса могат
                   * да имат един и същ trip_id след
                   * обработката.
                   *
                   * Вместо това записваме реалния индекс
                   * на конкретния course object в courses.
                   */
                  const courseIndex =
                    courses.indexOf(
                      entry.course
                    );

                  return `
                    <button
                      class="schedule-minute"
                      type="button"
                      data-course-index="${courseIndex}"
                      style="${partialStyle}"
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
    </table>

    <div class="schedule-partial-note">
      Частичните курсове са отбелязани с червен фон.
    </div>`;

  container
    .querySelectorAll(
      ".schedule-minute"
    )
    .forEach(button => {
      button.addEventListener(
        "click",
        () => {
          /*
           * Вече взимаме точно курса,
           * който е представен от този бутон.
           */
          const courseIndex =
            Number(
              button.dataset.courseIndex
            );

          const course =
            courses[
              courseIndex
            ];

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
    getDirectionStops(
      direction
    );

  const times =
    Array.isArray(course?.times)
      ? course.times
      : [];

  if (!section || !container) {
    return;
  }

  container.innerHTML = `
    <div class="course-detail-list">
      ${stops
        .map(
          (stop, index) => {
            const time =
              times[index];

            return `
              <div class="course-detail-stop">
                <div class="course-detail-stop-number">
                  ${index + 1}
                </div>

                <div class="course-detail-stop-name">
                  ${escapeHtml(
                    getStopName(stop)
                  )}
                </div>

                <div class="course-detail-time">
                  ${escapeHtml(
                    formatTime(time)
                  )}
                </div>
              </div>`;
          }
        )
        .join("")}
    </div>`;

  section.hidden = false;

  section.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function renderSchedule() {
  const emptyState =
    document.getElementById(
      "scheduleEmptyState"
    );

  const directionSection =
    document.getElementById(
      "directionSection"
    );

  const stopSection =
    document.getElementById(
      "stopSection"
    );

  const summarySection =
    document.getElementById(
      "summarySection"
    );

  const timetableSection =
    document.getElementById(
      "timetableSection"
    );

  const courseSection =
    document.getElementById(
      "courseSection"
    );

  if (!selectedScheduleLine) {
    if (emptyState) {
      emptyState.hidden = false;
    }

    if (directionSection) {
      directionSection.hidden = true;
    }

    if (stopSection) {
      stopSection.hidden = true;
    }

    if (summarySection) {
      summarySection.hidden = true;
    }

    if (timetableSection) {
      timetableSection.hidden = true;
    }

    if (courseSection) {
      courseSection.hidden = true;
    }

    return;
  }

  if (emptyState) {
    emptyState.hidden = true;
  }

  if (directionSection) {
    directionSection.hidden = false;
  }

  if (stopSection) {
    stopSection.hidden = false;
  }

  renderDirections();

  const direction =
    getSelectedDirection();

  renderStopList(
    direction
  );

  renderStops();

  const courses =
    getCoursesForDay(
      direction,
      selectedDayType
    );

  renderSummary(
    courses
  );

  renderTimetable(
    courses
  );

  if (courseSection) {
    courseSection.hidden = true;
  }
}

function setDayType(dayType) {
  selectedDayType =
    dayType;

  document
    .querySelectorAll(
      ".schedule-day-tab"
    )
    .forEach(tab => {
      tab.classList.toggle(
        "active",
        tab.dataset.dayType ===
          dayType
      );
    });

  renderSchedule();
}

function convertGtfsRoutes(data) {
  if (!data) {
    return [];
  }

  if (Array.isArray(data)) {
    return data;
  }

  if (
    Array.isArray(
      data.routes
    )
  ) {
    return data.routes;
  }

  return Object.values(
    data
  ).filter(
    item =>
      item &&
      typeof item ===
        "object"
  );
}

async function loadTransportData() {
  try {
    const response =
      await fetch(
        "data/routes.json"
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    scheduleLines =
      convertGtfsRoutes(
        data
      );

    renderLineOptions();
    renderSchedule();
  } catch (error) {
    console.error(
      "Грешка при зареждане на транспортните данни:",
      error
    );

    scheduleLines = [];

    const container =
      document.getElementById(
        "scheduleLineOptions"
      );

    if (container) {
      container.innerHTML = `
        <div class="schedule-no-data">
          Данните за линиите не могат да бъдат заредени.
        </div>`;
    }
  }
}

function initializeSchedules() {
  loadTransportData();
}

document.addEventListener(
  "DOMContentLoaded",
  () => {
    const selectedLine =
      document.getElementById(
        "selectedScheduleLine"
      );

    const lineDropdown =
      document.querySelector(
        ".schedule-line-dropdown"
      );

    const lineToggle =
      document.getElementById(
        "scheduleLineToggle"
      );

    const directionSelect =
      document.getElementById(
        "scheduleDirectionSelect"
      );

    const stopSelect =
      document.getElementById(
        "scheduleStopSelect"
      );

    const dayTabs =
      document.querySelectorAll(
        ".schedule-day-tab"
      );

    const closeCourseButton =
      document.getElementById(
        "closeCourseButton"
      );

    if (lineToggle) {
      lineToggle.addEventListener(
        "click",
        event => {
          event.stopPropagation();

          if (
            lineDropdown?.classList.contains(
              "open"
            )
          ) {
            closeLineDropdown();
          } else {
            openLineDropdown();
          }
        }
      );
    }

    if (selectedLine) {
      selectedLine.addEventListener(
        "click",
        event => {
          event.stopPropagation();

          if (
            lineDropdown?.classList.contains(
              "open"
            )
          ) {
            closeLineDropdown();
          } else {
            openLineDropdown();
          }
        }
      );
    }

    document.addEventListener(
      "click",
      event => {
        if (
          lineDropdown &&
          !lineDropdown.contains(
            event.target
          )
        ) {
          closeLineDropdown();
        }
      }
    );

    if (directionSelect) {
      directionSelect.addEventListener(
        "change",
        () => {
          selectedDirectionKey =
            directionSelect.value;

          selectedStopIndex = 0;
          selectedCourse = null;

          renderSchedule();
        }
      );
    }

    if (stopSelect) {
      stopSelect.addEventListener(
        "change",
        () => {
          selectedStopIndex =
            Number(
              stopSelect.value
            );

          selectedCourse = null;

          renderSchedule();
        }
      );
    }

    dayTabs.forEach(
      tab => {
        tab.addEventListener(
          "click",
          () => {
            setDayType(
              tab.dataset.dayType
            );
          }
        );
      }
    );

    if (closeCourseButton) {
      closeCourseButton.addEventListener(
        "click",
        () => {
          const courseSection =
            document.getElementById(
              "courseSection"
            );

          selectedCourse = null;

          if (courseSection) {
            courseSection.hidden = true;
          }
        }
      );
    }

    initializeSchedules();
  }
);
