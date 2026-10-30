const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'virtual-boards.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function createStorage(initialEntries = []) {
  const store = new Map(initialEntries);
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    dump(key) {
      return store.get(key) || null;
    }
  };
}

function loadInternals(storage) {
  const context = {
    console,
    Math,
    Intl,
    URLSearchParams,
    localStorage: storage,
    sessionStorage: storage,
    document: { addEventListener() {} },
    window: {},
    Date
  };
  context.globalThis = context;

  vm.runInNewContext(source, context, { filename: sourcePath });
  return context.__gtsofiaVirtualBoardTestInternals;
}

const storage = createStorage();
const internals = loadInternals(storage);

const countdownNow = 1_000;
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60, countdownNow),
  '1 мин.',
  'exactly 60 seconds remaining must show one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60.001, countdownNow),
  '1 мин.',
  'a little over one minute rounds to the nearest whole minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 59.999, countdownNow),
  '1 мин.',
  'just under one minute rounds to one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 59.9, countdownNow),
  '1 мин.',
  '59.9 seconds rounds to one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 29.9, countdownNow),
  '0 мин.',
  'less than 30 seconds rounds to zero minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 30, countdownNow),
  '1 мин.',
  'exactly 30 seconds rounds up to one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow, countdownNow),
  '0 мин.',
  'at the arrival timestamp must show zero minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 + 59, countdownNow),
  '2 мин.',
  '1 minute 59 seconds rounds to two minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 120, countdownNow),
  '2 мин.',
  'exactly two minutes remaining must show two minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 + 29.9, countdownNow),
  '1 мин.',
  '1 minute 29.9 seconds rounds to one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 + 30, countdownNow),
  '2 мин.',
  '1 minute 30 seconds rounds to two minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow - 30, countdownNow),
  '0 мин.',
  'already passed arrivals must stay at zero minutes until the board refreshes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 * 2 + 29.9, countdownNow),
  '2 мин.',
  '2 minutes 29.9 seconds rounds to two minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 * 2 + 30, countdownNow),
  '3 мин.',
  '2 minutes 30 seconds rounds to three minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 * 3 - 1, countdownNow),
  '3 мин.',
  '2 minutes 59 seconds rounds to three minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 9 * 60 + 1, countdownNow),
  '9 мин.',
  '9 minutes 1 second must round to nine minutes, not ten'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 9 * 60 + 29, countdownNow),
  '9 мин.',
  '9 minutes 29 seconds must round to nine minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 9 * 60 + 30, countdownNow),
  '10 мин.',
  '9 minutes 30 seconds must round to ten minutes'
);

// Virtual-board direction labels must prefer OSM even when the GTFS headsign
// is present, while retaining GTFS as a fallback when no OSM name exists.
assert.equal(
  internals.MAX_VISIBLE_BOARD_ARRIVALS,
  3,
  'the board should show the primary arrival plus up to two following times'
);
assert.deepEqual(
  Array.from(
    internals.getLimitedUniqueArrivalTimes([
      { timestamp: 50 },
      { timestamp: 20 },
      { timestamp: 40 },
      { timestamp: 20 },
      { timestamp: 30 },
      { timestamp: 60 },
      { timestamp: null }
    ], 4),
    time => time.timestamp
  ),
  [20, 30, 40, 50],
  'arrival lists should be sorted, deduplicated, and limited to four times'
);
internals.setTestState({
  transportData: {
    stops: [
      {
        stop_id: 'OSM-STOP',
        stop_name: 'Име от OSM',
        osm_stop_name: 'Име от OSM',
        gtfs_stop_name: 'GTFS име',
        stop_name_source: 'osm'
      },
      {
        stop_id: 'GTFS-STOP',
        stop_name: 'GTFS резерв',
        osm_stop_name: '',
        gtfs_stop_name: 'GTFS резерв',
        stop_name_source: 'gtfs'
      }
    ]
  }
});
assert.equal(
  internals.getDestinationDisplayName(
    'OSM-STOP',
    { destination: 'GTFS дестинация', headsign: 'GTFS headsign' }
  ),
  'Име от OSM',
  'OSM stop name must override stale GTFS direction metadata'
);
assert.equal(
  internals.getDestinationDisplayName(
    'GTFS-STOP',
    { destination: 'GTFS направление', headsign: 'GTFS headsign' }
  ),
  'GTFS направление',
  'the GTFS direction name must remain a fallback if no OSM name exists'
);
assert.equal(
  internals.getDestinationDisplayName(
    'DIRECTION-OSM-STOP',
    {
      destination: 'GTFS direction',
      stops: [{ stop_id: 'DIRECTION-OSM-STOP', osm_name: 'OSM от direction metadata' }]
    }
  ),
  'OSM от direction metadata',
  'direction stop metadata should provide the OSM name if a top-level stop lookup misses'
);

// A service that begins on Saturday must not be treated as active on Thursday
// merely because the generated horizon contains later weekdays.
internals.setTestState({
  transportData: {
    calendar: {
      serviceIdsByDate: {
        '2026-10-01': [],
        '2026-10-03': ['FUTURE-SERVICE'],
        '2026-10-04': ['FUTURE-SERVICE'],
        '2026-10-05': ['FUTURE-SERVICE']
      },
      servicePatterns: [],
      exceptions: []
    }
  },
  trips: []
});
assert.equal(
  internals.isServiceActiveOnDate('FUTURE-SERVICE', new Date('2026-10-01T18:00:00+03:00')),
  false,
  'a service starting on Saturday must not appear on Thursday'
);
assert.equal(
  internals.isServiceActiveOnDate('FUTURE-SERVICE', new Date('2026-10-03T10:00:00+03:00')),
  true,
  'the same service must appear once its GTFS service date starts'
);

// Realtime must suppress only the exact static course present in the current
// stop-specific response. A broad active-trips list is not a suppression signal.
const exactStaticArrival = {
  route_id: 'A234',
  original_trip_id: 'A234-COURSE-FUTURE',
  times: [{ timestamp: 1_000 }]
};
assert.equal(
  internals.staticArrivalIsCoveredByRealtime(exactStaticArrival, []),
  false,
  'an active trip without a stop-specific arrival must not suppress static service'
);
assert.equal(
  internals.staticArrivalIsCoveredByRealtime(exactStaticArrival, [{
    route_id: 'A234',
    trip_id: 'A234-COURSE-FUTURE',
    times: []
  }]),
  false,
  'an exact active trip without a stop-specific time must not suppress the static arrival'
);
assert.equal(
  internals.staticArrivalIsCoveredByRealtime(exactStaticArrival, [{
    route_id: 'A234',
    trip_id: 'A234-COURSE-FUTURE',
    times: [{ timestamp: 1_010 }]
  }]),
  true,
  'the exact trip with a time for the selected stop must suppress its static duplicate'
);
assert.equal(
  internals.staticArrivalIsCoveredByRealtime(exactStaticArrival, [{
    route_id: 'A234',
    trip_id: 'A234-OTHER-COURSE',
    times: []
  }]),
  false,
  'a different trip on the same line must not suppress the static course'
);

// SKIPPED must suppress exactly the matching scheduled course, not the whole
// direction. The compatibility path uses route + direction + GTFS start_time
// until regenerated data carries the exact original_trip_id on each row.
internals.setTestState({
  transportData: {
    directions: {
      TEST_ROUTE: {
        D1: {
          key: 'D1',
          destination: 'Тестова спирка',
          headsign: 'Тестова спирка',
          shape_id: 'SHAPE-1',
          pattern: ['1000', '0605', '2000']
        }
      }
    }
  },
  trips: [{
    trip_id: 'REALTIME-11',
    route_id: 'TEST_ROUTE',
    trip_headsign: 'Тестова спирка',
    shape_id: 'SHAPE-1'
  }]
});

const skipped = [{
  trip_id: 'REALTIME-11',
  route_id: 'TEST_ROUTE',
  start_time: '08:10:00',
  stop_id: '0605'
}];

assert.equal(
  internals.isSkippedStaticSchedule(
    { trip_id: 42, original_trip_id: 'REALTIME-11', start_time: '08:10:00', stop_sequences: [1, 24, 25] },
    'TEST_ROUTE',
    'D1',
    '0605',
    1,
    skipped
  ),
  true,
  'SKIPPED must suppress the exact matching scheduled course'
);

assert.equal(
  internals.isSkippedStaticSchedule(
    { trip_id: 43, original_trip_id: 'OTHER-TRIP', start_time: '08:25:00', stop_sequences: [1, 24, 25] },
    'TEST_ROUTE',
    'D1',
    '0605',
    1,
    skipped
  ),
  false,
  'a later scheduled course must remain eligible after an earlier course is SKIPPED'
);

assert.equal(
  internals.isSkippedStaticSchedule(
    { trip_id: 42, original_trip_id: 'REALTIME-11', start_time: '08:25:00', stop_sequences: [1, 24, 25] },
    'TEST_ROUTE',
    'D1',
    '0605',
    1,
    skipped
  ),
  true,
  'exact original_trip_id match must suppress the course even when legacy start times differ'
);

assert.equal(
  internals.isSkippedStaticSchedule(
    { trip_id: 44, original_trip_id: 'REALTIME-11', start_time: '08:10:00', stop_sequences: [1, 24, 25] },
    'OTHER_ROUTE',
    'D1',
    '0605',
    1,
    skipped
  ),
  false,
  'SKIPPED from another route must never suppress this route fallback'
);


const sequenceOnlySkipped = [{
  trip_id: 'REALTIME-11',
  route_id: 'TEST_ROUTE',
  start_time: '08:10:00',
  stop_id: '',
  stop_sequence: 24
}];
assert.equal(
  internals.isSkippedStaticSchedule(
    { trip_id: 42, original_trip_id: 'REALTIME-11', start_time: '08:10:00', stop_sequences: [1, 24, 25] },
    'TEST_ROUTE',
    'D1',
    '0605',
    1,
    sequenceOnlySkipped
  ),
  true,
  'sequence-only SKIPPED must suppress the matching stop'
);
assert.equal(
  internals.isSkippedStaticSchedule(
    { trip_id: 42, original_trip_id: 'REALTIME-11', start_time: '08:10:00', stop_sequences: [1, 24, 25] },
    'TEST_ROUTE',
    'D1',
    '2000',
    2,
    sequenceOnlySkipped
  ),
  false,
  'sequence-only SKIPPED must not suppress a different stop in the same trip'
);

// Realtime and timetable courses on the same displayed line/destination must
// merge into a single row. Realtime arrivals keep their identity; distinct
// scheduled courses fill the remaining slots up to four visible times.
assert.deepEqual(
  Array.from(
    internals.mergeBoardRoutesByDestination([
      {
        route_id: 'R1', route_ref: '10', destination: 'Център',
        realtime: true, source: 'realtime',
        times: [
          { timestamp: 100, scheduled: false },
          { timestamp: 400, scheduled: false }
        ]
      },
      {
        route_id: 'R1', route_ref: '10', destination: 'Център',
        scheduled: true, source: 'static',
        times: [
          { timestamp: 200, scheduled: true },
          { timestamp: 300, scheduled: true },
          { timestamp: 500, scheduled: true }
        ]
      }
    ], 4)[0].times,
    time => [time.timestamp, time.scheduled]
  ),
  [[100, false], [200, true], [300, true], [400, false]],
  'realtime and schedule arrivals should combine, sort, and stop at four'
);
assert.equal(
  internals.mergeBoardRoutesByDestination([
    {
      route_id: 'R1', route_ref: '10', destination: 'Център',
      realtime: true, times: [{ timestamp: 100, scheduled: false }]
    },
    {
      route_id: 'R1', route_ref: '10', destination: 'Център',
      scheduled: true, times: [{ timestamp: 100, scheduled: true }]
    }
  ])[0].times.length,
  1,
  'duplicate timestamps from realtime and timetable must not occupy two slots'
);
assert.equal(
  internals.mergeBoardRoutesByDestination([
    {
      route_id: 'R1', route_ref: '10', destination: 'Център',
      realtime: true, times: [{ timestamp: 100, scheduled: false }]
    },
    {
      route_id: 'R1', route_ref: '10', destination: 'Квартал',
      scheduled: true, times: [{ timestamp: 200, scheduled: true }]
    }
  ]).length,
  2,
  'different destinations on the same line must remain separate rows'
);
assert.equal(
  internals.mergeBoardRoutesByDestination([
    {
      route_id: 'R1', route_ref: '—', destination: 'Център',
      realtime: true, times: [{ timestamp: 100, scheduled: false }]
    },
    {
      route_id: 'R1', route_ref: '10', destination: 'Център',
      scheduled: true, times: [{ timestamp: 200, scheduled: true }]
    }
  ])[0].route_ref,
  '10',
  'a missing realtime route label must not prevent merging and should use the static label'
);

// Regression: line 26 has short-turn trips ending at stop 0542 (Модна къща
// Агресия), which is an intermediate stop in the representative D1 pattern.
// The realtime filter must hide those specific trips on their own terminal,
// without hiding full-length trips that merely pass through the same stop.
const dataDir = path.join(__dirname, '..', 'data');
const readData = name => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
const actualRoutes = readData('routes.json');
const actualDirections = readData('directions.json');
const actualSchedules = readData('schedules.json');
const actualTrips = readData('trips.json');
const actualStops = readData('stops.json');
const bus26 = actualRoutes.find(route => String(route.route_short_name) === '26');
assert.ok(bus26, 'the provided static data must contain bus 26');
const bus26RouteId = String(bus26.route_id);
const directionEntry = Object.entries(actualDirections[bus26RouteId] || {}).find(([, direction]) =>
  Array.isArray(direction.pattern) && direction.pattern.some(stopId => String(stopId) === '0542')
);
assert.ok(directionEntry, 'bus 26 direction must contain stop 0542');
const [bus26DirectionKey, bus26Direction] = directionEntry;
const pattern = bus26Direction.pattern.map(String);
const stopIndex = pattern.findIndex(stopId => stopId === '0542');
const scheduleSet = actualSchedules[bus26RouteId]?.[bus26DirectionKey] || {};
const allDirectionSchedules = Object.values(scheduleSet).flatMap(rows => Array.isArray(rows) ? rows : []);
const getTerminalIndex = row => {
  const times = Array.isArray(row?.times) ? row.times : [];
  for (let i = Math.min(times.length, pattern.length) - 1; i >= 0; i--) {
    if (times[i] !== null && times[i] !== undefined && String(times[i]).trim() !== '') return i;
  }
  return -1;
};
const partialSchedule = allDirectionSchedules.find(row => getTerminalIndex(row) === stopIndex);
const fullSchedule = allDirectionSchedules.find(row => getTerminalIndex(row) === pattern.length - 1);
assert.ok(partialSchedule, 'actual bus 26 data must include a trip terminating at stop 0542');
assert.ok(fullSchedule, 'actual bus 26 data must include a full trip past stop 0542');
const partialTrip = actualTrips.find(trip => String(trip.trip_id) === String(partialSchedule.original_trip_id));
const fullTrip = actualTrips.find(trip => String(trip.trip_id) === String(fullSchedule.original_trip_id));
assert.ok(partialTrip, 'the partial schedule must map to its original GTFS trip');
assert.ok(fullTrip, 'the full schedule must map to its original GTFS trip');
const stop0542 = actualStops.find(stop => String(stop.stop_id) === '0542');
assert.ok(stop0542, 'actual stop data must contain stop 0542');
internals.setTestState({
  transportData: {
    routes: [bus26],
    stops: [stop0542],
    directions: { [bus26RouteId]: { [bus26DirectionKey]: bus26Direction } },
    schedules: { [bus26RouteId]: { [bus26DirectionKey]: scheduleSet } }
  },
  trips: [partialTrip, fullTrip],
  buildIndexes: true
});
assert.equal(
  internals.getScheduledTripTerminalStopId(bus26RouteId, partialTrip),
  '0542',
  'the concrete terminal of the partial bus 26 course must resolve to stop 0542'
);
assert.equal(
  internals.getScheduledTripTerminalStopId(bus26RouteId, fullTrip),
  String(pattern[pattern.length - 1]),
  'the full bus 26 course must retain the full-line terminal'
);
assert.equal(
  internals.shouldHideTerminalArrival(bus26RouteId, '0542', partialTrip, bus26Direction.headsign || ''),
  true,
  'hide the partial bus 26 course when viewing its actual terminal at stop 0542'
);
assert.equal(
  internals.shouldHideTerminalArrival(bus26RouteId, '0542', fullTrip, bus26Direction.headsign || ''),
  false,
  'a full course that passes through the partial-trip terminal must remain visible there'
);
assert.equal(
  internals.shouldHideTerminalArrival(bus26RouteId, '0542', fullTrip, bus26Direction.headsign || ''),
  false,
  'do not hide a full bus 26 course at stop 0542 because it continues beyond it'
);

// Regression for the reported trolleybus 7 issue:
// a realtime feed ending its StopTimeUpdates at 2082 (ул. Опълченска) must not
// make that intermediate stop the destination of a scheduled full trip.
const tb7 = actualRoutes.find(route => String(route.route_id) === 'TB7');
assert.ok(tb7, 'the supplied GTFS data must contain trolleybus 7');
const tb7DirectionEntry = Object.entries(actualDirections.TB7 || {}).find(([, direction]) =>
  Array.isArray(direction.pattern) && direction.pattern.some(stopId => String(stopId) === '2082')
);
assert.ok(tb7DirectionEntry, 'trolleybus 7 direction must contain ул. Опълченска');
const [tb7DirectionKey, tb7Direction] = tb7DirectionEntry;
const tb7Pattern = tb7Direction.pattern.map(String);
const tb7OpalchenskaIndex = tb7Pattern.indexOf('2082');
const tb7ScheduleSet = actualSchedules.TB7?.[tb7DirectionKey] || {};
const tb7Rows = Object.values(tb7ScheduleSet).flatMap(rows => Array.isArray(rows) ? rows : []);
const tb7FullSchedule = tb7Rows.find(row => getTerminalIndex(row) === tb7Pattern.length - 1 && row.times?.[tb7OpalchenskaIndex] != null);
assert.ok(tb7FullSchedule, 'trolleybus 7 must contain full trips passing through ул. Опълченска');
const tb7Trip = actualTrips.find(trip => String(trip.trip_id) === String(tb7FullSchedule.original_trip_id));
assert.ok(tb7Trip, 'the full trolleybus 7 schedule must map to its GTFS trip');
const tb7Stop2082 = actualStops.find(stop => String(stop.stop_id) === '2082');
const tb7Stop0610 = actualStops.find(stop => String(stop.stop_id) === '0610');
assert.ok(tb7Stop2082 && tb7Stop0610, 'both trolleybus 7 stops must exist in the supplied GTFS data');
internals.setTestState({
  transportData: {
    routes: [tb7],
    stops: [tb7Stop2082, tb7Stop0610],
    directions: { TB7: { [tb7DirectionKey]: tb7Direction } },
    schedules: { TB7: { [tb7DirectionKey]: tb7ScheduleSet } }
  },
  trips: [tb7Trip],
  buildIndexes: true
});
const tb7Realtime = {
  trip_id: tb7Trip.trip_id,
  route_id: 'TB7',
  destination_stop_id: '2082',
  destination: 'ул. Опълченска',
  schedule_relationship_name: 'SCHEDULED'
};
const tb7Destination = internals.resolveRealtimeRouteDestinationDetails(
  tb7Realtime,
  tb7Trip,
  'TB7',
  '2082'
);
assert.equal(
  tb7Destination.destinationStopId,
  '0610',
  'a SCHEDULED trolleybus 7 trip must use its concrete GTFS terminal, not the last realtime StopTimeUpdate'
);
assert.match(
  tb7Destination.destination,
  /Люлин 3/i,
  'the board destination must be ж.к. Люлин 3 – ухо'
);
assert.equal(
  internals.getScheduledTripTerminalStopId('TB7', tb7Trip),
  '0610',
  'the exact trolleybus 7 GTFS trip must resolve to terminal stop 0610'
);
assert.equal(
  internals.shouldHideTerminalArrival('TB7', '2082', tb7Trip, 'ул. Опълченска'),
  false,
  'an intermediate realtime stop must not cause the trolleybus 7 trip to disappear'
);
assert.equal(
  internals.shouldHideTerminalArrival('TB7', '0610', tb7Trip, 'ж.к. Люлин 3 – ухо'),
  true,
  'the same trip must not be shown as a departure at its actual terminal'
);

// A metro short-turn is still a real scheduled course. It must not be hidden
// merely because it is more than 30 minutes away from the selected stop.
const sofiaNowParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Sofia',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
}).formatToParts(new Date());
const sofiaPart = type => Number(sofiaNowParts.find(part => part.type === type)?.value || 0);
const futureMetroSeconds = sofiaPart('hour') * 3600 + sofiaPart('minute') * 60 + sofiaPart('second') + 45 * 60;
const formatGtfsTime = seconds => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map(value => String(value).padStart(2, '0')).join(':');
};
const currentSofiaWeekday = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Sofia',
  weekday: 'short'
}).format(new Date());
const currentScheduleBucket = currentSofiaWeekday === 'Sat' || currentSofiaWeekday === 'Sun'
  ? 'weekend'
  : 'weekday';
const metroDirection = {
  key: 'D1',
  direction_id: 'D1',
  destination: 'Метростанция Тест',
  headsign: 'Метростанция Тест',
  pattern: ['METRO-START', 'METRO-BOARD', 'METRO-SHORT-END']
};
const metroRoute = {
  route_id: 'M-TEST',
  route_type: '1',
  route_short_name: '99'
};
internals.setTestState({
  transportData: {
    routes: [metroRoute],
    stops: [
      { stop_id: 'METRO-BOARD', stop_name: 'Тестова метростанция' },
      { stop_id: 'METRO-SHORT-END', stop_name: 'Крайна тестова метростанция' }
    ],
    directions: { 'M-TEST': { D1: metroDirection } },
    schedules: {
      'M-TEST': {
        D1: {
          [currentScheduleBucket]: [{
            times: [null, formatGtfsTime(futureMetroSeconds), formatGtfsTime(futureMetroSeconds + 5 * 60)]
          }]
        }
      }
    }
  },
  trips: [],
  buildIndexes: true
});
const metroDepartures = internals.getMetroScheduledArrivals({ stop_id: 'METRO-BOARD' });
assert.equal(metroDepartures.length, 1, 'the future metro short-turn must be included in the board');
assert.equal(metroDepartures[0].terminal_stop_id, 'METRO-SHORT-END', 'the metro course must retain its actual short-turn terminal');
assert.ok(
  metroDepartures[0].times[0].timestamp > Date.now() / 1000 + 30 * 60,
  'metro short-turns must not be hidden by the removed 30-minute display threshold'
);

console.log('virtual-board-arrivals: all tests passed');
