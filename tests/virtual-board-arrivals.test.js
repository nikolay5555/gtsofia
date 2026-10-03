const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'virtual-boards.js');
const source = fs.readFileSync(sourcePath, 'utf8');

assert.equal(
  source.includes('displayedPrimaryArrival'),
  false,
  'automatic refresh must not reference the removed displayedPrimaryArrival state'
);

assert.equal(
  source.includes('realtimeSupportedRouteIds.has(routeId)'),
  false,
  'a realtime trip elsewhere on the line must not suppress static departures at this stop'
);

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
    `\n  globalThis.__testInternals = {\n    getConsumedRealtimeArrivalKey,\n    rememberConsumedRealtimeArrivals,\n    isConsumedRealtimeScheduledArrival,\n    isSkippedStaticSchedule,\n    isServiceActiveOnDate,\n    formatArrivalCountdown,\n    setTestState({ transportData: nextTransportData, trips = [] } = {}) {\n      transportData = nextTransportData || null;\n      tripById = new Map(trips.map(trip => [String(trip.trip_id), trip]));\n    }\n  };\n})();`
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
  'exactly 60 seconds remaining must still show one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 59.9, countdownNow),
  '0 мин.',
  'less than 60 seconds remaining must show zero minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow, countdownNow),
  '0 мин.',
  'at the arrival timestamp must show zero minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 + 59, countdownNow),
  '1 мин.',
  '1 minute 59 seconds remaining should stay at one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 + 29, countdownNow),
  '1 мин.',
  '1 minute 29 seconds remaining should still show one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 + 30, countdownNow),
  '1 мин.',
  '1 minute 30 seconds remaining should stay at one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 * 3 - 1, countdownNow),
  '2 мин.',
  '2 minutes 59 seconds remaining must display two minutes'
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

console.log('virtual-board-arrivals: all tests passed');
