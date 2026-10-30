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
  const exportedSource = source.replace(
    /\n\}\)\(\);\s*$/,
    `\n  globalThis.__testInternals = {\n    getConsumedRealtimeArrivalKey,\n    getConsumedRealtimeTripKey,\n    rememberConsumedRealtimeTrips,\n    rememberConsumedRealtimeArrivals,\n    isConsumedRealtimeScheduledArrival,\n    isConsumedRealtimeTrip,\n    isSkippedStaticSchedule,\n    isServiceActiveOnDate,\n    formatArrivalCountdown,\n    getDestinationDisplayName,\n    getLimitedUniqueArrivalTimes,\n    mergeBoardRoutesByDestination,\n    getStaticScheduleInfoForTrip,\n    getRealtimeTripDestinationStopId,\n    resolveRealtimeRouteDestinationDetails,\n    shouldHideTerminalArrival,\n    MAX_VISIBLE_BOARD_ARRIVALS,\n    setTestState({ transportData: nextTransportData, trips = [], buildIndexes = false } = {}) {\n      transportData = nextTransportData || null;\n      routeById = new Map((transportData?.routes || []).map(route => [String(route.route_id), route]));\n      const allTrips = trips.length ? trips : (transportData?.trips || []);\n      tripById = new Map(allTrips.map(trip => [String(trip.trip_id), trip]));\n      if (buildIndexes) buildStaticScheduleIndexes();\n    }\n  };\n})();`
  );

  const context = {
    console,
    Math,
    Intl,
    URLSearchParams,
    localStorage: storage,
    sessionStorage: storage,
    document: { addEventListener() {} },
    window: {},
    globalThis: {},
    Date
  };
  context.globalThis = context;

  vm.runInNewContext(exportedSource, context, { filename: sourcePath });
  return context.__testInternals;
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

const nowSeconds = Date.now() / 1000;

const stopId = '1017';
const routeId = 'A234';
const destination = 'Село Долни Лозен';
const scheduledTime = Math.floor((nowSeconds + 60) / 60) * 60;
const realtimeTime = scheduledTime - 120; // Two minutes early.
const nextScheduledTime = scheduledTime + 15 * 60;

// A future course is reserved as soon as it appears in realtime. If the feed
// drops it temporarily, the same course must not reappear as a static fallback.
const futureTripId = 'A234-COURSE-FUTURE';
internals.rememberConsumedRealtimeArrivals({ stop_id: stopId }, [{
  route_id: routeId,
  trip_id: futureTripId,
  destination,
  times: [{ timestamp: nowSeconds + 30, scheduled_time: scheduledTime }]
}]);
assert.equal(
  internals.isConsumedRealtimeScheduledArrival(stopId, routeId, destination, scheduledTime),
  true,
  'future realtime arrivals must reserve the matching scheduled course immediately'
);
assert.equal(
  internals.isConsumedRealtimeTrip(stopId, routeId, futureTripId),
  true,
  'the exact realtime trip identity must remain reserved when its ETA is future'
);
assert.equal(
  internals.isConsumedRealtimeTrip(stopId, routeId, 'A234-OTHER-COURSE'),
  false,
  'observing one realtime trip must not suppress another course on the same line'
);

internals.rememberConsumedRealtimeTrips({ stop_id: stopId }, [{
  route_id: routeId,
  trip_id: 'A234-ACTIVE-WITHOUT-STOP-ETA',
  schedule_relationship_name: 'SCHEDULED'
}]);
assert.equal(
  internals.isConsumedRealtimeTrip(stopId, routeId, 'A234-ACTIVE-WITHOUT-STOP-ETA'),
  true,
  'an active realtime trip suppresses its static fallback even without a stop ETA'
);

// Exact trip identity also protects the course when the feed does not provide
// a scheduled_time/delay pair for its stop update.
internals.rememberConsumedRealtimeArrivals({ stop_id: stopId }, [{
  route_id: routeId,
  trip_id: 'A234-COURSE-WITHOUT-SCHEDULED-TIME',
  destination,
  times: [{ timestamp: nowSeconds + 120, scheduled_time: null, delay: null }]
}]);
assert.equal(
  internals.isConsumedRealtimeTrip(stopId, routeId, 'A234-COURSE-WITHOUT-SCHEDULED-TIME'),
  true,
  'trip identity suppresses fallback even when scheduled_time is missing'
);

// Reconfirming a course after its predicted time keeps the same suppression.
internals.rememberConsumedRealtimeArrivals({ stop_id: stopId }, [{
  route_id: routeId,
  trip_id: futureTripId,
  destination,
  times: [{ timestamp: nowSeconds - 5, scheduled_time: scheduledTime }]
}]);

assert.equal(
  internals.isConsumedRealtimeScheduledArrival(stopId, routeId, destination, scheduledTime),
  true,
  'a passed realtime arrival must consume its scheduled course'
);

assert.equal(
  internals.isConsumedRealtimeScheduledArrival(stopId, routeId, destination, nextScheduledTime),
  false,
  'the next scheduled course must remain eligible'
);

// The consumed state survives a second script load in the same browser tab.
const reloadedInternals = loadInternals(storage);
assert.equal(
  reloadedInternals.isConsumedRealtimeScheduledArrival(stopId, routeId, destination, scheduledTime),
  true,
  'consumed scheduled courses must survive a page refresh within the session'
);
assert.equal(
  reloadedInternals.isConsumedRealtimeTrip(stopId, routeId, futureTripId),
  true,
  'consumed realtime trip identity must survive a page refresh within the session'
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

// Regression: trolleybus 7's D1 pattern passes ул. Опълченска (2082) and
// continues to ж.к. Люлин 3 - ухо (0610). A SCHEDULED TripUpdate can end at
// 2082 even though the exact timetable row reaches 0610. The partial RT prefix
// must not suppress the static arrival at a later stop on the same trip.
const dataDir = path.join(__dirname, '..', 'data');
const readData = name => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
const actualRoutes = readData('routes.json');
const actualDirections = readData('directions.json');
const actualSchedules = readData('schedules.json');
const actualTrips = readData('trips.json');
const actualStops = readData('stops.json');
const trolley7 = actualRoutes.find(route =>
  String(route.route_short_name) === '7'
  && String(route.route_type) === '11'
);
assert.ok(trolley7, 'the provided static data must contain trolleybus 7');
const trolley7RouteId = String(trolley7.route_id);
const directionEntry = Object.entries(actualDirections[trolley7RouteId] || {}).find(([, direction]) =>
  String(direction?.headsign || '').toLocaleLowerCase('bg-BG').includes('люлин 3')
  && Array.isArray(direction.pattern)
  && direction.pattern.some(stopId => String(stopId) === '2082')
);
assert.ok(directionEntry, 'trolleybus 7 direction must include ул. Опълченска and Lyulin 3');
const [trolley7DirectionKey, trolley7Direction] = directionEntry;
const pattern = trolley7Direction.pattern.map(String);
const opalchenskaIndex = pattern.findIndex(stopId => stopId === '2082');
const boardStopIndex = pattern.findIndex(stopId => stopId === '0325');
assert.ok(opalchenskaIndex >= 0 && boardStopIndex > opalchenskaIndex, 'the test board stop must be after ул. Опълченска');
const scheduleSet = actualSchedules[trolley7RouteId]?.[trolley7DirectionKey] || {};
const allDirectionSchedules = Object.values(scheduleSet).flatMap(rows => Array.isArray(rows) ? rows : []);
const getTerminalIndex = row => {
  const times = Array.isArray(row?.times) ? row.times : [];
  for (let i = Math.min(times.length, pattern.length) - 1; i >= 0; i--) {
    if (times[i] !== null && times[i] !== undefined && String(times[i]).trim() !== '') return i;
  }
  return -1;
};
const fullSchedule = allDirectionSchedules.find(row =>
  getTerminalIndex(row) === pattern.length - 1
  && row?.times?.[boardStopIndex] != null
  && row?.times?.[opalchenskaIndex] != null
);
assert.ok(fullSchedule, 'trolleybus 7 data must contain a full trip with a scheduled time after ул. Опълченска');
const fullTrip = actualTrips.find(trip => String(trip.trip_id) === String(fullSchedule.original_trip_id));
assert.ok(fullTrip, 'the full timetable course must map to its original GTFS trip');
const boardStopId = pattern[boardStopIndex];
const lyulinTerminalId = pattern[pattern.length - 1];
assert.equal(lyulinTerminalId, '0610', 'the test direction must end at ж.к. Люлин 3 - ухо');
const boardStop = actualStops.find(stop => String(stop.stop_id) === boardStopId);
assert.ok(boardStop, 'the test board stop must exist in the stops data');

internals.setTestState({
  transportData: {
    routes: [trolley7],
    stops: actualStops,
    directions: { [trolley7RouteId]: { [trolley7DirectionKey]: trolley7Direction } },
    schedules: { [trolley7RouteId]: { [trolley7DirectionKey]: scheduleSet } }
  },
  trips: [fullTrip]
});

const truncatedRealtimeTrip = {
  trip_id: fullTrip.trip_id,
  route_id: trolley7RouteId,
  schedule_relationship: 0,
  schedule_relationship_name: 'SCHEDULED',
  destination_stop_id: '2082'
};
const staticScheduleInfo = internals.getStaticScheduleInfoForTrip(
  trolley7RouteId,
  fullTrip.trip_id
);
assert.equal(
  staticScheduleInfo?.terminalStopId,
  lyulinTerminalId,
  'the exact static timetable row must resolve the true terminal to ж.к. Люлин 3 - ухо'
);
assert.equal(
  internals.getRealtimeTripDestinationStopId(truncatedRealtimeTrip, staticScheduleInfo),
  lyulinTerminalId,
  'a SCHEDULED trip must use its exact static terminal instead of the truncated realtime endpoint'
);
assert.equal(
  internals.resolveRealtimeRouteDestinationDetails(
    truncatedRealtimeTrip,
    fullTrip,
    trolley7RouteId,
    boardStopId
  ).destination,
  'ж.к. Люлин 3 - ухо',
  'the board destination must be displayed as ж.к. Люлин 3 - ухо'
);

internals.rememberConsumedRealtimeTrips(
  { stop_id: boardStopId },
  [truncatedRealtimeTrip]
);
assert.equal(
  internals.isConsumedRealtimeTrip(boardStopId, trolley7RouteId, fullTrip.trip_id),
  false,
  'a truncated realtime prefix ending before the board stop must not suppress the full static course'
);

// The same must hold when the selected board is exactly at ул. Опълченска:
// that stop is an intermediate stop for this full scheduled course.
const opalchenskaStopId = pattern[opalchenskaIndex];
internals.rememberConsumedRealtimeTrips(
  { stop_id: opalchenskaStopId },
  [truncatedRealtimeTrip]
);
assert.equal(
  internals.isConsumedRealtimeTrip(opalchenskaStopId, trolley7RouteId, fullTrip.trip_id),
  false,
  'an intermediate stop reported as the realtime endpoint must not hide a full scheduled trip at that same stop'
);

internals.rememberConsumedRealtimeTrips(
  { stop_id: boardStopId },
  [{ ...truncatedRealtimeTrip, destination_stop_id: lyulinTerminalId }]
);
assert.equal(
  internals.isConsumedRealtimeTrip(boardStopId, trolley7RouteId, fullTrip.trip_id),
  true,
  'a matching full realtime destination must continue to reserve its static course and prevent duplicates'
);

console.log('virtual-board-arrivals: all tests passed');
