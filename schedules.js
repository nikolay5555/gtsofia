const SCHEDULE_MAIN_TYPES = ['metro', 'tram', 'trolley', 'bus'];
const SCHEDULE_SUBTYPES = ['temporary', 'school', 'night'];
const SCHEDULE_TYPE_LABELS = {
  metro: 'Метролинии',
  tram: 'Трамваи',
  trolley: 'Тролейбуси',
  bus: 'Автобуси',
  temporary: 'Временни линии',
  school: 'Училищни линии',
  night: 'Нощни линии'
};
let scheduleData = null;
let routeByCgmId = new Map();
let stopByCode = new Map();
let directionByCode = new Map();
let tripById = new Map();
let stopTimesByTrip = new Map();
let selectedRoute = null;
let selectedDirectionCode = null;
let selectedStopIndex = 0;
let selectedDayType = 'weekday';
let currentCourses = [];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatTime(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) return '—';
  const total = Math.max(0, Math.floor(Number(minutes)));
  const hour = Math.floor(total / 60) % 24;
  const minute = total % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatTimeWithDay(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) return '—';
  const total = Math.floor(Number(minutes));
  const day = Math.floor(total / 1440);
  const clock = formatTime(total % 1440);
  return day > 0 ? `${clock} (+${day} ден)` : clock;
}

function linePillHtml(route) {
  const display = getLineDisplayNumber(route);
  const bg = getLineColor(route);
  const text = getLineTextColor(route);
  const metro = getLineType(route) === 'metro';
  return `<span class="schedule-line-pill${metro ? ' metro' : ''}" style="background:${escapeHtml(bg)};color:${escapeHtml(text)}">${escapeHtml(display)}</span>`;
}

function lineIdentityHtml(route) {
  const icon = getTransportIcon(route.type, route.route_ref);
  return `<span class="schedule-line-identity"><span class="schedule-line-icon">${icon ? `<img src="${escapeHtml(icon)}" alt="">` : ''}</span>${linePillHtml(route)}</span>`;
}

function getRouteSubtype(route) {
  return typeof getLineSubtype === 'function' ? getLineSubtype(route) : null;
}

function getRouteBucket(route) {
  return getRouteSubtype(route) || getLineType(route);
}

function routeSortNumber(route) {
  const value = String(route?.route_ref || '');
  const number = Number(value.replace(/\D/g, ''));
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}

function sortRoutes(routes) {
  return [...routes].sort((a, b) => {
    const aType = getLineType(a);
    const bType = getLineType(b);
    const aMain = SCHEDULE_MAIN_TYPES.indexOf(aType);
    const bMain = SCHEDULE_MAIN_TYPES.indexOf(bType);
    if (aMain !== bMain) return aMain - bMain;

    const aSub = getRouteSubtype(a);
    const bSub = getRouteSubtype(b);
    if (aSub !== bSub) {
      if (!aSub) return -1;
      if (!bSub) return 1;
      return SCHEDULE_SUBTYPES.indexOf(aSub) - SCHEDULE_SUBTYPES.indexOf(bSub);
    }
    const numeric = routeSortNumber(a) - routeSortNumber(b);
    if (numeric !== 0) return numeric;
    return String(a.route_ref || '').localeCompare(String(b.route_ref || ''), 'bg');
  });
}

function getDestinationName(direction) {
  const code = direction?.stops?.filter(Boolean).at(-1);
  if (!code) return 'Неизвестна дестинация';
  const stop = stopByCode.get(String(code));
  return stop?.names?.bg || getStopName(code, 'bg', true);
}

function destinationIdentityHtml(route, direction) {
  const destination = getDestinationName(direction);
  return `
    <span class="icon-pill-destination">${lineIdentityHtml(route)}</span>
    <img class="arrow-destination" src="Icons/destinationarrow.svg" alt="" aria-hidden="true">
    <span class="schedule-summary-destination">${escapeHtml(destination)}</span>`;
}

function indexData(data) {
  routeByCgmId = new Map((data.routes || []).map(route => [String(route.cgm_id), route]));
  stopByCode = new Map((data.stops || []).map(stop => [String(stop.code), stop]));
  directionByCode = new Map((data.directions || []).map(direction => [String(direction.code), direction]));
  tripById = new Map((data.trips || []).map(trip => [String(trip.id), trip]));
  stopTimesByTrip = new Map();
  for (const row of data.stop_times || []) {
    const key = String(row.trip);
    if (!stopTimesByTrip.has(key)) stopTimesByTrip.set(key, []);
    stopTimesByTrip.get(key).push(row);
  }
}

function getRouteDirections(route, dayType) {
  const weekend = dayType === 'weekend';
  const codes = [...new Set(
    (scheduleData.trips || [])
      .filter(trip => String(trip.cgm_id) === String(route.cgm_id) && Boolean(trip.is_weekend) === weekend)
      .map(trip => String(trip.direction))
  )];
  return codes.map(code => directionByCode.get(code)).filter(Boolean);
}

function getLogicalTrips(route, directionCode, dayType) {
  const weekend = dayType === 'weekend';
  return (scheduleData.trips || []).filter(trip =>
    String(trip.cgm_id) === String(route.cgm_id) &&
    String(trip.direction) === String(directionCode) &&
    Boolean(trip.is_weekend) === weekend
  );
}

function getCourses(route, directionCode, dayType) {
  const trips = getLogicalTrips(route, directionCode, dayType);
  const rows = [];
  for (const trip of trips) {
    for (const row of stopTimesByTrip.get(String(trip.id)) || []) {
      rows.push({ ...row, trip });
    }
  }
  rows.sort((a, b) => {
    const at = Number(a.times?.[selectedStopIndex]);
    const bt = Number(b.times?.[selectedStopIndex]);
    if (Number.isFinite(at) && Number.isFinite(bt)) return at - bt;
    if (Number.isFinite(at)) return -1;
    if (Number.isFinite(bt)) return 1;
    return Number(a.trip?.id || 0) - Number(b.trip?.id || 0);
  });
  return rows;
}

function getSelectedDirection() {
  return directionByCode.get(String(selectedDirectionCode)) || null;
}

function getSelectedStopCode() {
  const direction = getSelectedDirection();
  return String(direction?.stops?.[selectedStopIndex] || '');
}

function getCoursePartialKind(course) {
  const times = Array.isArray(course?.times) ? course.times : [];
  const present = times.map(value => value != null && Number.isFinite(Number(value)));
  const first = present.findIndex(Boolean);
  const last = present.length - 1 - [...present].reverse().findIndex(Boolean);
  if (first < 0) return null;
  if (first > 0 && last < present.length - 1) return 'both';
  if (first > 0) return 'start';
  if (last < present.length - 1) return 'final';
  return null;
}

function isPartialCourse(course) {
  return Boolean(getCoursePartialKind(course));
}



function renderLineDropdown() {
  const menu = document.getElementById('lineDropdownMenu');
  menu.innerHTML = '';
  const grouped = new Map();
  for (const type of [...SCHEDULE_MAIN_TYPES, ...SCHEDULE_SUBTYPES]) grouped.set(type, []);

  for (const route of sortRoutes(scheduleData.routes || [])) {
    grouped.get(getRouteBucket(route))?.push(route);
  }

  for (const [type, routes] of grouped) {
    if (!routes.length) continue;
    const group = document.createElement('div');
    group.className = 'schedule-dropdown-group';
    group.innerHTML = `<div class="schedule-dropdown-group-title">${escapeHtml(SCHEDULE_TYPE_LABELS[type])}</div>`;

    for (const route of routes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'schedule-line-option';
      button.innerHTML = `${lineIdentityHtml(route)}<span class="schedule-option-arrow">›</span>`;
      button.addEventListener('click', () => selectRoute(route));
      group.appendChild(button);
    }
    menu.appendChild(group);
  }
}

function openLineDropdown() {
  const menu = document.getElementById('lineDropdownMenu');
  const button = document.getElementById('lineDropdownButton');
  const open = !menu.hidden;
  menu.hidden = open;
  button.setAttribute('aria-expanded', String(!open));
}

function closeLineDropdown() {
  const menu = document.getElementById('lineDropdownMenu');
  const button = document.getElementById('lineDropdownButton');
  menu.hidden = true;
  button.setAttribute('aria-expanded', 'false');
}

function setSelectedLineButton(route) {
  const button = document.getElementById('lineDropdownButton');
  const chevron = button.querySelector('.schedule-chevron');
  button.querySelector('.schedule-placeholder')?.remove();
  button.querySelector('.schedule-selected-line')?.remove();
  const selected = document.createElement('span');
  selected.className = 'schedule-selected-line';
  selected.innerHTML = lineIdentityHtml(route);
  button.insertBefore(selected, chevron);
}

function selectRoute(route) {
  selectedRoute = route;
  const currentDayType = typeof getTransportCalendarDayType === 'function'
    ? getTransportCalendarDayType()
    : 'weekday';
  const hasCurrent = getRouteDirections(route, currentDayType).length > 0;
  const otherDayType = currentDayType === 'weekday' ? 'weekend' : 'weekday';
  selectedDayType = hasCurrent ? currentDayType : otherDayType;
  selectedDirectionCode = null;
  selectedStopIndex = 0;
  currentCourses = [];
  closeLineDropdown();
  setSelectedLineButton(route);
  syncDayTabs();
  renderDirections();
  renderSchedule();
}

function syncDayTabs() {
  document.querySelectorAll('.schedule-day-tab').forEach(button => {
    const type = button.dataset.dayType;
    const available = !selectedRoute || getRouteDirections(selectedRoute, type).length > 0;
    button.disabled = !available;
    button.classList.toggle('active', type === selectedDayType);
  });
}


function renderDirections() {
  const select = document.getElementById('directionSelect');
  const directions = getRouteDirections(selectedRoute, selectedDayType);
  if (!directions.some(direction => String(direction.code) === String(selectedDirectionCode))) {
    selectedDirectionCode = directions[0] ? String(directions[0].code) : null;
  }

  select.innerHTML = directions.length
    ? directions.map(direction => `<option value="${escapeHtml(direction.code)}">${escapeHtml(getDestinationName(direction))}</option>`).join('')
    : '<option value="">Няма разписание за избрания тип ден.</option>';
  select.disabled = !directions.length;
  if (selectedDirectionCode != null) select.value = selectedDirectionCode;

  renderStops();
}

function renderStops() {
  const select = document.getElementById('stopSelect');
  const direction = getSelectedDirection();
  const stops = direction?.stops || [];
  selectedStopIndex = Math.min(selectedStopIndex, Math.max(0, stops.length - 1));
  select.innerHTML = stops.length
    ? stops.map((code, index) => `<option value="${index}">${escapeHtml(getStopString(code))}</option>`).join('')
    : '<option value="">Няма налични спирки.</option>';
  select.disabled = !stops.length;
  if (stops.length) select.value = String(selectedStopIndex);
}

function renderSummary(courses) {
  const summary = document.getElementById('scheduleSummary');
  const direction = getSelectedDirection();
  if (!selectedRoute || !direction) {
    summary.hidden = true;
    return;
  }

  const valid = courses
    .map(course => Number(course.times?.[selectedStopIndex]))
    .filter(Number.isFinite);
  const first = valid.length ? Math.min(...valid) : null;
  const last = valid.length ? Math.max(...valid) : null;

  summary.innerHTML = `
    <div class="schedule-summary-main">
      <div class="schedule-summary-route-row">
        ${destinationIdentityHtml(selectedRoute, direction)}
      </div>
    </div>
    <div class="schedule-summary-stats">
      <div><span>Първи курс</span><strong>${escapeHtml(formatTime(first))}</strong></div>
      <div><span>Последен курс</span><strong>${escapeHtml(formatTime(last))}</strong></div>
      <div><span>Общо курсове</span><strong>${courses.length}</strong></div>
    </div>`;
  summary.hidden = false;
}

function renderTimetable(courses) {
  const section = document.getElementById('timetableSection');
  const container = document.getElementById('timetableContainer');
  section.hidden = false;

  if (!courses.length) {
    container.innerHTML = '<div class="schedule-no-data">Няма налични курсове за избрания тип ден и направление.</div>';
    return;
  }

  const byHour = new Map();
  courses.forEach((course, index) => {
    const time = Number(course.times?.[selectedStopIndex]);
    if (!Number.isFinite(time)) return;
    const normalized = ((time % 1440) + 1440) % 1440;
    const hour = Math.floor(normalized / 60);
    const minute = normalized % 60;
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour).push({ course, courseIndex: index, minute });
  });

  const hours = Array.from({ length: 24 }, (_, i) => (i + 1) % 24);
  const header = hours.map(hour => `<th>${hour}</th>`).join('');
  const cells = hours.map(hour => {
    const entries = (byHour.get(hour) || []).sort((a, b) => a.minute - b.minute);
    const content = entries.map(entry => {
      const partial = getCoursePartialKind(entry.course);
      const partialClass = partial ? ` partial ${partial === 'start' ? 'partial-start' : partial === 'final' ? 'partial-final' : 'partial-both'}` : '';
      return `<button class="schedule-minute${partialClass}" type="button" data-course-index="${entry.courseIndex}" title="${escapeHtml(entry.course.car ? `Автобус/вагон ${entry.course.car}` : 'Курс')}">${String(entry.minute).padStart(2, '0')}</button>`;
    }).join('');
    return `<td><div class="schedule-minute-list">${content}</div></td>`;
  }).join('');

  container.innerHTML = `<table class="schedule-timetable"><thead><tr>${header}</tr></thead><tbody><tr>${cells}</tr></tbody></table>`;
  container.querySelectorAll('.schedule-minute').forEach(button => {
    button.addEventListener('click', () => showCourse(courses[Number(button.dataset.courseIndex)]));
  });
}

function renderCoursesByCar(courses) {
  const table = document.getElementById('timetableContainer');
  if (!courses.length) {
    table.innerHTML = '<div class="schedule-no-data">Няма налични курсове.</div>';
    return;
  }
  const groups = new Map();
  for (const course of courses) {
    const car = String(course.car || '').trim() || '—';
    if (!groups.has(car)) groups.set(car, []);
    groups.get(car).push(course);
  }
  const cars = [...groups.keys()].sort((a, b) => {
    if (a === '—') return 1;
    if (b === '—') return -1;
    return Number(a) - Number(b);
  });

  table.innerHTML = `<div class="schedule-by-car-list">${cars.map(car => {
    const rows = groups.get(car).map(course => {
      const time = Number(course.times?.[selectedStopIndex]);
      const partial = getCoursePartialKind(course);
      const partialClass = partial ? ` partial ${partial === 'start' ? 'partial-start' : partial === 'final' ? 'partial-final' : 'partial-both'}` : '';
      return `<button type="button" class="schedule-course-chip${partialClass}" data-course-index="${courses.indexOf(course)}">${escapeHtml(formatTime(time))}</button>`;
    }).join('');
    return `<div class="schedule-by-car-row"><strong>№ ${escapeHtml(car)}</strong><div>${rows}</div></div>`;
  }).join('')}</div>`;

  table.querySelectorAll('.schedule-course-chip').forEach(button => {
    button.addEventListener('click', () => showCourse(courses[Number(button.dataset.courseIndex)]));
  });
}

function showCourse(course) {
  if (!course) return;
  const section = document.getElementById('courseSection');
  const container = document.getElementById('courseStops');
  const direction = getSelectedDirection();
  const stops = direction?.stops || [];

  container.innerHTML = stops.map((code, index) => {
      const raw = course.times?.[index];
      const hasTime = raw != null && Number.isFinite(Number(raw));
      const selected = index === selectedStopIndex ? ' selected' : '';
      const partial = !hasTime ? ' partial' : '';
      return `<div class="course-stop${selected}${partial}">
        <div class="course-stop-marker"></div>
        <div class="course-stop-name"><span class="course-stop-name-text">${escapeHtml(getStopName(code, 'bg', true))}</span><span class="course-stop-code">[${escapeHtml(formatStopCode(code))}]</span></div>
        <div class="course-stop-time">${escapeHtml(formatTimeWithDay(raw))}</div>
      </div>`;
    }).join('');

  section.hidden = false;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderSchedule() {
  const empty = document.getElementById('scheduleEmpty');
  if (!selectedRoute || !selectedDirectionCode) {
    empty.hidden = false;
    document.getElementById('scheduleSummary').hidden = true;
    document.getElementById('timetableSection').hidden = true;
    document.getElementById('courseSection').hidden = true;
    return;
  }
  empty.hidden = true;
  renderStops();
  currentCourses = getCourses(selectedRoute, selectedDirectionCode, selectedDayType);
  renderSummary(currentCourses);
  renderTimetable(currentCourses);
  document.getElementById('courseSection').hidden = true;
}

async function initializeSchedules() {
  try {
    scheduleData = await loadTransportData();
    indexData(scheduleData);
    selectedDayType = typeof getTransportCalendarDayType === 'function' ? getTransportCalendarDayType() : 'weekday';
    renderLineDropdown();
    syncDayTabs();
    window.scheduleData = scheduleData;
  } catch (error) {
    console.error('Неуспешно зареждане на разписанията:', error);
    document.getElementById('scheduleEmpty').textContent = 'Разписанията не могат да бъдат заредени в момента.';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('lineDropdownButton').addEventListener('click', openLineDropdown);
  document.addEventListener('click', event => {
    if (!event.target.closest('#lineDropdown')) closeLineDropdown();
  });

  document.getElementById('directionSelect').addEventListener('change', event => {
    selectedDirectionCode = event.target.value || null;
    selectedStopIndex = 0;
    renderSchedule();
  });

  document.getElementById('stopSelect').addEventListener('change', event => {
    selectedStopIndex = Number(event.target.value) || 0;
    renderSchedule();
  });

  document.querySelectorAll('.schedule-day-tab').forEach(button => {
    button.addEventListener('click', () => {
      if (!selectedRoute) return;
      selectedDayType = button.dataset.dayType;
      selectedDirectionCode = null;
      selectedStopIndex = 0;
      syncDayTabs();
      renderDirections();
      renderSchedule();
    });
  });

  document.getElementById('closeCourseButton').addEventListener('click', () => {
    document.getElementById('courseSection').hidden = true;
  });

  initializeSchedules();
});

window.display_schedule = renderSchedule;
window.display_trip_schedule = (courseIndex) => showCourse(currentCourses[Number(courseIndex)]);
