const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'virtual-boards.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const utilsSource = fs.readFileSync(path.join(__dirname, '..', 'virtual-board-utils.js'), 'utf8');

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
    `\n  globalThis.__testInternals = {\n    getConsumedRealtimeArrivalKey,\n    rememberConsumedRealtimeArrivals,\n    isConsumedRealtimeScheduledArrival,\n    isSkippedStaticSchedule,\n    isServiceActiveOnDate,\n    formatArrivalCountdown,\n    staticArrivalIsCoveredByRealtime,\n    staticArrivalIsCanceledByRealtime,\n    groupScheduledArrivals,\n    mergeScheduledAndRealtimeRoutes,\n    getRealtimeScheduledTimestamp,\n    setTestState({ transportData: nextTransportData, trips = [] } = {}) {\n      transportData = nextTransportData || null;\n      tripById = new Map(trips.map(trip => [String(trip.trip_id), trip]));\n    }\n  };\n})();`
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

  vm.runInNewContext(utilsSource, context, { filename: 'virtual-board-utils.js' });
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
  internals.formatArrivalCountdown(countdownNow + 59.9, countdownNow),
  '1 мин.',
  'any positive time below one minute must stay at one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 29.9, countdownNow),
  '1 мин.',
  'the final seconds must not be displayed separately'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow, countdownNow),
  '0 мин.',
  'at the arrival timestamp must show zero minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 + 59, countdownNow),
  '2 мин.',
  '1 minute 59 seconds remaining should round to two minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 + 29.9, countdownNow),
  '1 мин.',
  '1 minute 29.9 seconds remaining should still show one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 + 30, countdownNow),
  '2 мин.',
  '1 minute 30 seconds remaining should round to two minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow - 30, countdownNow),
  '0 мин.',
  'already passed arrivals must stay at zero minutes until the board refreshes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 * 2 + 29.9, countdownNow),
  '2 мин.',
  '2 minutes 29.9 seconds remaining should round down to two minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 * 2 + 30, countdownNow),
  '3 мин.',
  '2 minutes 30 seconds remaining should round to three minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 * 3 - 1, countdownNow),
  '3 мин.',
  '2 minutes 59 seconds remaining must display three minutes'
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

// The compressed calendar format must reconstruct date-specific exceptions
// without shipping a repeated full service list for each date.
internals.setTestState({
  transportData: {
    calendar: {
      referenceDate: '2026-10-01',
      endDate: '2026-10-04',
      serviceIdsByWeekday: {
        monday: [], tuesday: [], wednesday: [], thursday: [],
        friday: [], saturday: [], sunday: []
      },
      serviceIdOverridesByDate: {
        '2026-10-03': { add: ['FUTURE-SERVICE'], remove: [] }
      },
      servicePatterns: []
    }
  },
  trips: []
});
assert.equal(
  internals.isServiceActiveOnDate('FUTURE-SERVICE', new Date('2026-10-01T18:00:00+03:00')),
  false,
  'compressed weekday baseline must keep the service inactive when no date addition exists'
);
assert.equal(
  internals.isServiceActiveOnDate('FUTURE-SERVICE', new Date('2026-10-03T10:00:00+03:00')),
  true,
  'compressed date-specific additions must activate the service on the requested date'
);

const nowSeconds = Date.now() / 1000;

const stopId = '1017';
const routeId = 'A234';
const destination = 'Село Долни Лозен';
const scheduledTime = Math.floor((nowSeconds + 60) / 60) * 60;
const realtimeTime = scheduledTime - 120; // Two minutes early.
const nextScheduledTime = scheduledTime + 15 * 60;

// Before the realtime course has actually reached the stop, it must not be
// marked as consumed: a transient realtime disappearance should not hide the
// still-upcoming scheduled course.
internals.rememberConsumedRealtimeArrivals({ stop_id: stopId }, [{
  route_id: routeId,
  destination,
  times: [{ timestamp: nowSeconds + 30, scheduled_time: scheduledTime }]
}]);
assert.equal(
  internals.isConsumedRealtimeScheduledArrival(stopId, routeId, destination, scheduledTime),
  false,
  'future realtime arrivals must not consume their scheduled course'
);

// Once the realtime arrival is at/past the stop, remember the exact scheduled
// course that it represents.
internals.rememberConsumedRealtimeArrivals({ stop_id: stopId }, [{
  route_id: routeId,
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

// A line can show realtime and timetable departures together. Realtime for
// one concrete trip must not suppress the next scheduled trips in the same
// direction; the final render is capped at three distinct upcoming times.
const baseTime = Math.floor(Date.now() / 1000) + 120;
const realtimeRoute = {
  route_id: 'R1',
  route_ref: '100',
  destination: 'Център',
  times: [
    { timestamp: baseTime, scheduled_time: baseTime, scheduled: false, source: 'realtime', trip_id: 'TRIP-1' },
    { timestamp: baseTime + 14 * 60, scheduled_time: baseTime + 14 * 60, scheduled: false, source: 'realtime', trip_id: 'TRIP-2' }
  ]
};
const scheduledCandidates = [
  { route_id: 'R1', route_ref: '100', destination: 'Център', original_trip_id: 'TRIP-1', times: [{ timestamp: baseTime, scheduled: true }] },
  { route_id: 'R1', route_ref: '100', destination: 'Център', original_trip_id: 'TRIP-2', times: [{ timestamp: baseTime + 14 * 60, scheduled: true }] },
  { route_id: 'R1', route_ref: '100', destination: 'Център', original_trip_id: 'TRIP-3', times: [{ timestamp: baseTime + 28 * 60, scheduled: true }] },
  { route_id: 'R1', route_ref: '100', destination: 'Център', original_trip_id: 'TRIP-4', times: [{ timestamp: baseTime + 42 * 60, scheduled: true }] }
];

assert.equal(
  internals.staticArrivalIsCoveredByRealtime(scheduledCandidates[0], [
    { route_id: 'R1', trip_id: 'TRIP-1', times: [] }
  ]),
  true,
  'exact GTFS trip identity must link a static arrival to realtime even if the feed omits scheduled_time'
);
assert.equal(
  internals.staticArrivalIsCoveredByRealtime(scheduledCandidates[2], [
    { route_id: 'R1', trip_id: 'TRIP-1', times: [] }
  ]),
  false,
  'realtime for a different course must not suppress a later scheduled course'
);
assert.equal(
  internals.staticArrivalIsCoveredByRealtime(
    {
      route_id: 'R1',
      destination: 'Център',
      times: [{ timestamp: baseTime }]
    },
    [{
      route_id: 'R1',
      destination: 'Център',
      times: [{ timestamp: baseTime + 120, scheduled_time: baseTime }]
    }]
  ),
  true,
  'a realtime prediction with the same scheduled stop time must replace its static counterpart even when actual time is delayed and trip IDs are unavailable'
);
assert.equal(
  internals.staticArrivalIsCoveredByRealtime(
    {
      route_id: 'R1',
      destination: 'Център',
      times: [{ timestamp: baseTime }]
    },
    [{
      route_id: 'R1',
      destination: 'Център',
      times: [{ timestamp: baseTime + 180, delay: 180 }]
    }]
  ),
  true,
  'timestamp minus delay must be used as scheduled time when scheduled_time is absent'
);
assert.equal(
  internals.staticArrivalIsCoveredByRealtime(
    {
      route_id: 'R1',
      destination: 'Център',
      times: [{ timestamp: baseTime }]
    },
    [{
      route_id: 'R1',
      destination: 'Център',
      times: [{ timestamp: baseTime + 600, scheduled_time: baseTime + 600 }]
    }]
  ),
  false,
  'nearby realtime trips with a different scheduled stop time must not replace a static course'
);
assert.equal(
  internals.staticArrivalIsCoveredByRealtime(
    { route_id: 'R1', original_trip_id: 'REAL-GTFS-ID', static_trip_id: '123', times: [{ timestamp: baseTime }] },
    [{ route_id: 'R1', trip_id: '123', times: [] }]
  ),
  false,
  'synthetic internal schedule IDs must never be treated as GTFS-Realtime trip IDs'
);

const remainingScheduled = scheduledCandidates.filter((course, index) => index >= 2);
const combined = internals.mergeScheduledAndRealtimeRoutes(
  [realtimeRoute],
  remainingScheduled.map((course, index) => ({
    ...course,
    // route_ref is display metadata and should not split one route/direction.
    route_ref: index === 0 ? 'BUS-100' : course.route_ref
  }))
);
assert.equal(combined.length, 1, 'same route/destination should render as one row');
assert.equal(combined[0].times.length, 3, 'the row should show up to three courses');
assert.deepEqual(
  Array.from(combined[0].times, time => Number(time.timestamp)),
  [baseTime, baseTime + 14 * 60, baseTime + 28 * 60],
  'the third static course should appear alongside two realtime courses, without duplicates'
);
assert.equal(combined[0].times[2].scheduled, true, 'the added third course must remain marked as timetable data');
assert.equal(
  internals.getRealtimeScheduledTimestamp({ scheduled_time: null, timestamp: null, delay: null }),
  null,
  'missing timestamps must not be coerced to Unix epoch zero'
);

const staticGrouped = internals.groupScheduledArrivals(scheduledCandidates);
assert.equal(staticGrouped.length, 1, 'static courses for one line/destination must be grouped');
assert.equal(staticGrouped[0].times.length, 3, 'static-only fallback should keep the next three courses');

assert.equal(
  internals.staticArrivalIsCanceledByRealtime(
    { route_id: 'R1', original_trip_id: 'TRIP-3', times: [{ timestamp: baseTime }] },
    [{ route_id: 'R1', trip_id: 'TRIP-3', schedule_relationship_name: 'CANCELED' }]
  ),
  true,
  'explicitly canceled trips must not reappear via timetable fallback'
);
assert.equal(
  internals.staticArrivalIsCanceledByRealtime(
    { route_id: 'R1', original_trip_id: 'TRIP-4', times: [{ timestamp: baseTime }] },
    [{ route_id: 'R1', trip_id: 'TRIP-3', schedule_relationship_name: 'CANCELED' }]
  ),
  false,
  'canceling one trip must not suppress the other trips of the same route'
);
assert.equal(
  internals.staticArrivalIsCanceledByRealtime(
    { route_id: 'R1', original_trip_id: 'TRIP-3', trip_start_time: '08:30:00', times: [{ timestamp: baseTime }] },
    [{ route_id: 'R1', trip_id: 'TRIP-3', start_time: '09:00:00', schedule_relationship_name: 'CANCELED' }]
  ),
  false,
  'a cancellation for another instance of the same trip ID must not suppress this departure'
);

console.log('virtual-board-arrivals: all tests passed');
