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
  (source.match(/rememberConsumedRealtimeArrivals\(stop, mergedSurfaceRoutes\);/g) || []).length,
  1,
  'a passed realtime course must be persisted before static fallback is evaluated'
);

assert.equal(
  source.includes('realtimeSupportedRouteIds.has(routeId)'),
  false,
  'a realtime trip elsewhere on the line must not suppress static departures at this stop'
);

assert.equal(
  source.includes('scheduled_time: Number.isFinite(Number(time?.scheduled_time))'),
  false,
  'missing realtime scheduled_time must not be coerced from null to zero'
);

assert.equal(
  source.includes("original_trip_id: String(schedule?.original_trip_id || '').trim()"),
  true,
  'every static course must retain its concrete original GTFS trip identity'
);

assert.equal(
  source.includes("existing.times.push({ timestamp, trip_id })"),
  false,
  'static course metadata must not be lost for later departures in the same direction'
);

assert.equal(
  source.includes('delay: Number.isFinite(Number(time?.delay)) ? Number(time?.delay) : null'),
  false,
  'missing realtime delay must not be coerced from null to zero'
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
    `\n  globalThis.__testInternals = {\n    getConsumedRealtimeArrivalKey,\n    rememberConsumedRealtimeArrivals,\n    isConsumedRealtimeScheduledArrival,\n    isSkippedStaticSchedule,\n    isServiceActiveOnDate,\n    formatArrivalCountdown,\n    getRealtimeScheduledTimestamp,\n    findRealtimeStaticMatchIndex,\n    getStaticCourseKey,\n    setTestState({ transportData: nextTransportData, trips = [] } = {}) {\n      transportData = nextTransportData || null;\n      tripById = new Map(trips.map(trip => [String(trip.trip_id), trip]));\n    }\n  };\n})();`
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

// A realtime course keeps the exact static schedule timestamp as its anchor.
// Once the vehicle has passed the stop, that anchor must suppress the static
// timetable fallback even when GTFS-RT did not provide scheduled_time.
const anchoredScheduledTime = scheduledTime + 30;
internals.rememberConsumedRealtimeArrivals({ stop_id: stopId }, [{
  route_id: routeId,
  destination,
  times: [{
    timestamp: nowSeconds - 10,
    scheduled_time: null,
    matched_scheduled_timestamp: anchoredScheduledTime
  }]
}]);
assert.equal(
  internals.isConsumedRealtimeScheduledArrival(stopId, routeId, destination, anchoredScheduledTime),
  true,
  'a passed realtime arrival must consume its explicitly matched static schedule anchor'
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


// Realtime and static must represent one course even when the vehicle is
// running early/late and the feed uses a different trip_id namespace.
{
  const staticTimes = [
    { timestamp: 1_000_480, trip_id: 'STATIC-A', start_time: '12:00:00' },
    { timestamp: 1_000_600, trip_id: 'STATIC-B', start_time: '12:10:00' },
    { timestamp: 1_000_720, trip_id: 'STATIC-C', start_time: '12:20:00' }
  ];

  assert.equal(
    internals.findRealtimeStaticMatchIndex(
      { trip_id: 'RT-A', trip_start_time: '12:00:00' },
      { trip_id: 'RT-A', timestamp: 1_000_420, scheduled_time: null, delay: null },
      staticTimes,
      new Set()
    ),
    0,
    'realtime early arrival must replace the static course with the same start time'
  );

  assert.equal(
    internals.findRealtimeStaticMatchIndex(
      { trip_id: 'GTFS-ORIGINAL-A', trip_start_time: '12:00:00' },
      { trip_id: 'GTFS-ORIGINAL-A', timestamp: 1_000_420, scheduled_time: null, delay: null },
      [
        { timestamp: 1_000_480, trip_id: '12345', original_trip_id: 'GTFS-ORIGINAL-A', start_time: '12:00:00' }
      ],
      new Set()
    ),
    0,
    'realtime trip_id must also match the static original_trip_id namespace'
  );

  assert.equal(
    internals.findRealtimeStaticMatchIndex(
      { trip_id: 'RT-B', trip_start_time: '12:10:00' },
      { trip_id: 'RT-B', timestamp: 1_000_690, scheduled_time: 1_000_600, delay: 90 },
      staticTimes,
      new Set([0])
    ),
    1,
    'realtime late arrival must replace the static course using scheduled_time'
  );

  assert.equal(
    internals.getRealtimeScheduledTimestamp({
      timestamp: 1_000_410,
      scheduled_time: null,
      delay: -70
    }),
    1_000_480,
    'negative realtime delay must reconstruct the scheduled timestamp'
  );

  assert.equal(
    internals.getRealtimeScheduledTimestamp({
      timestamp: 1_000_410,
      scheduled_time: '',
      delay: 0
    }),
    1_000_410,
    'an empty scheduled_time must fall back to actual time plus delay'
  );

  assert.equal(
    internals.getRealtimeScheduledTimestamp({
      timestamp: null,
      scheduled_time: null,
      delay: null
    }),
    null,
    'missing realtime timing fields must remain unavailable, not become timestamp zero'
  );

  assert.equal(
    internals.getRealtimeScheduledTimestamp({
      timestamp: 1_000_410,
      scheduled_time: 0,
      delay: -70
    }),
    1_000_480,
    'a coerced zero scheduled_time must still allow schedule reconstruction from delay'
  );

  // Without a concrete trip identity, start time, or scheduled time there is
  // no safe course to attach realtime to. Showing it separately is preferable
  // to making it jump between nearby scheduled courses.
  assert.equal(
    internals.findRealtimeStaticMatchIndex(
      { trip_id: '', trip_start_time: '' },
      { trip_id: '', timestamp: 1_000_420, scheduled_time: null, delay: null },
      staticTimes,
      new Set()
    ),
    -1,
    'realtime without course identity must not be guessed from time proximity'
  );

  // The same realtime course keeps the same static slot across refreshes even
  // when its actual arrival time changes.
  const stableStaticTimes = [
    { timestamp: 3_000_480, trip_id: 'LOGICAL-A', original_trip_id: 'GTFS-A', start_time: '14:00:00' },
    { timestamp: 3_000_600, trip_id: 'LOGICAL-A', original_trip_id: 'GTFS-B', start_time: '14:10:00' }
  ];

  assert.equal(
    internals.findRealtimeStaticMatchIndex(
      { trip_id: 'RT-A', trip_start_time: '14:00:00' },
      { trip_id: 'RT-A', timestamp: 3_000_420, scheduled_time: null, delay: null },
      stableStaticTimes,
      new Set()
    ),
    0,
    'first refresh must attach the realtime course to its start-time slot'
  );

  assert.equal(
    internals.findRealtimeStaticMatchIndex(
      { trip_id: 'RT-A', trip_start_time: '14:00:00' },
      { trip_id: 'RT-A', timestamp: 3_000_450, scheduled_time: null, delay: null },
      stableStaticTimes,
      new Set()
    ),
    0,
    'later refresh must keep the same realtime course on the same static slot'
  );

}

  assert.equal(
    internals.getStaticCourseKey(
      {
        route_id: 'A181',
        route_ref: '181',
        direction_key: 'D1',
        destination: 'Тестова дестинация'
      },
      { timestamp: 1_000_480 }
    ),
    'A181|D1||1000480',
    'matched static courses must have a stable route/direction/timestamp key'
  );

console.log('virtual-board-arrivals: all tests passed');
