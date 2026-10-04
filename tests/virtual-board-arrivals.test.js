const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'virtual-boards.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const merger = require(path.join(__dirname, '..', 'virtual-board-arrivals.js'));

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
    `\n  globalThis.__testInternals = {
    getConsumedRealtimeArrivalKey,
    rememberConsumedRealtimeArrivals,
    isConsumedRealtimeScheduledArrival,
    isSkippedStaticSchedule,
    isServiceActiveOnDate,
    formatArrivalCountdown,
    setTestState({ transportData: nextTransportData, trips = [], selectedStopId: nextStopId = null } = {}) {
      transportData = nextTransportData || null;
      tripById = new Map(trips.map(trip => [String(trip.trip_id), trip]));
      selectedStopId = nextStopId;
    }
  };
})();`
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
  internals.formatArrivalCountdown(countdownNow + 29.9, countdownNow),
  '0 мин.',
  'the final 30 seconds must display zero minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 59.9, countdownNow),
  '0 мин.',
  'anything below one minute must display zero minutes'
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
  internals.formatArrivalCountdown(countdownNow + 60 + 29, countdownNow),
  '1 мин.',
  '1 minute 29 seconds remaining should still show one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 60 + 30, countdownNow),
  '2 мин.',
  '1 minute 30 seconds remaining should round to two minutes'
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

// Realtime/static continuity: once a realtime course actually reaches the
// selected stop, remember the exact source trip so its static schedule cannot
// resurrect when the RT update disappears a few seconds later.
const stopId = '1017';
const routeId = 'A234';
const destination = 'Село Долни Лозен';
const simulatedNow = 10_000;
const realtimeArrival = simulatedNow + 60;
const scheduledTimestamp = simulatedNow + 180;

internals.setTestState({ selectedStopId: stopId, trips: [] });
const staticCourse = {
  course_id: 'static-course-1',
  source_trip_id: 'RT-EXACT-1',
  route_id: routeId,
  destination,
  timestamp: scheduledTimestamp
};

internals.rememberConsumedRealtimeArrivals({ stop_id: stopId }, [{
  realtime: {
    trip_id: 'RT-EXACT-1',
    route_id: routeId,
    timestamp: realtimeArrival,
    scheduled_timestamp: scheduledTimestamp
  },
  static: staticCourse
}], simulatedNow);
assert.equal(
  internals.isConsumedRealtimeScheduledArrival(staticCourse, stopId, simulatedNow),
  false,
  'an observed future realtime arrival must not consume its scheduled course before its ETA'
);
assert.equal(
  internals.isConsumedRealtimeScheduledArrival(staticCourse, stopId, realtimeArrival + 0.1),
  true,
  'a remembered realtime ETA must consume its static course immediately after the ETA passes'
);

// If a later feed update moves the ETA forward before the old ETA has passed,
// the course remains eligible until that newer ETA; once consumed, it stays
// consumed even if a later update erroneously moves the ETA backwards/forwards.
internals.rememberConsumedRealtimeArrivals({ stop_id: stopId }, [{
  realtime: {
    trip_id: 'RT-EXACT-1',
    route_id: routeId,
    timestamp: realtimeArrival + 30,
    scheduled_timestamp: scheduledTimestamp
  },
  static: staticCourse
}], simulatedNow + 10);
assert.equal(
  internals.isConsumedRealtimeScheduledArrival(staticCourse, stopId, realtimeArrival + 20),
  false,
  'a future ETA update must keep the exact course eligible until the updated ETA'
);
internals.rememberConsumedRealtimeArrivals({ stop_id: stopId }, [{
  realtime: {
    trip_id: 'RT-EXACT-1',
    route_id: routeId,
    timestamp: realtimeArrival + 30,
    scheduled_timestamp: scheduledTimestamp
  },
  static: staticCourse
}], realtimeArrival + 31);
// A later feed change must not resurrect an already consumed course.
internals.rememberConsumedRealtimeArrivals({ stop_id: stopId }, [{
  realtime: {
    trip_id: 'RT-EXACT-1',
    route_id: routeId,
    timestamp: realtimeArrival + 180,
    scheduled_timestamp: scheduledTimestamp
  },
  static: staticCourse
}], realtimeArrival + 31);
assert.equal(
  internals.isConsumedRealtimeScheduledArrival(staticCourse, stopId, realtimeArrival + 31),
  true,
  'once consumed, the course must remain consumed even if a later ETA update moves it again'
);

const nextStaticCourse = {
  ...staticCourse,
  course_id: 'static-course-2',
  source_trip_id: 'RT-EXACT-2',
  timestamp: scheduledTimestamp + 15 * 60
};
assert.equal(
  internals.isConsumedRealtimeScheduledArrival(nextStaticCourse, stopId),
  false,
  'consuming one realtime course must never consume the next scheduled course'
);

// The consumed state survives a second script load in the same browser tab.
const reloadedInternals = loadInternals(storage);
assert.equal(
  reloadedInternals.isConsumedRealtimeScheduledArrival(staticCourse, stopId),
  true,
  'consumed scheduled courses must survive a page refresh within the session'
);

// SKIPPED must suppress exactly the matching scheduled course, not the whole
// direction. The compatibility path uses route + direction + GTFS start_time
// until regenerated data carries the exact original_trip_id on each row.
reloadedInternals.setTestState({
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
  reloadedInternals.isSkippedStaticSchedule(
    { trip_id: 42, original_trip_id: 'REALTIME-11', start_time: '08:10:00', stop_sequences: [1, 24, 25] },
    'TEST_ROUTE', 'D1', '0605', 1, skipped
  ),
  true,
  'SKIPPED must suppress the exact matching scheduled course'
);
assert.equal(
  reloadedInternals.isSkippedStaticSchedule(
    { trip_id: 43, original_trip_id: 'OTHER-TRIP', start_time: '08:25:00', stop_sequences: [1, 24, 25] },
    'TEST_ROUTE', 'D1', '0605', 1, skipped
  ),
  false,
  'a later scheduled course must remain eligible after an earlier course is SKIPPED'
);
assert.equal(
  reloadedInternals.isSkippedStaticSchedule(
    { trip_id: 42, original_trip_id: 'REALTIME-11', start_time: '08:25:00', stop_sequences: [1, 24, 25] },
    'TEST_ROUTE', 'D1', '0605', 1, skipped
  ),
  true,
  'exact original_trip_id match must suppress the course even when legacy start times differ'
);
assert.equal(
  reloadedInternals.isSkippedStaticSchedule(
    { trip_id: 44, original_trip_id: 'REALTIME-11', start_time: '08:10:00', stop_sequences: [1, 24, 25] },
    'OTHER_ROUTE', 'D1', '0605', 1, skipped
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
  reloadedInternals.isSkippedStaticSchedule(
    { trip_id: 42, original_trip_id: 'REALTIME-11', start_time: '08:10:00', stop_sequences: [1, 24, 25] },
    'TEST_ROUTE', 'D1', '0605', 1, sequenceOnlySkipped
  ),
  true,
  'sequence-only SKIPPED must suppress the matching stop'
);
assert.equal(
  reloadedInternals.isSkippedStaticSchedule(
    { trip_id: 42, original_trip_id: 'REALTIME-11', start_time: '08:10:00', stop_sequences: [1, 24, 25] },
    'TEST_ROUTE', 'D1', '2000', 2, sequenceOnlySkipped
  ),
  false,
  'sequence-only SKIPPED must not suppress a different stop in the same trip'
);

// Core arrival merge regression: RT must replace its exact static course, and
// the remaining static courses must immediately fill the other positions.
const T = (hour, minute) => hour * 3600 + minute * 60;
const mergeNow = T(10, 56);
const staticCandidates = [
  { course_id: 'c1', source_trip_id: 'TRIP-1', route_id: '72', route_ref: '72', destination: 'Централна гара', timestamp: T(10, 59), direction_key: 'D1' },
  { course_id: 'c2', source_trip_id: 'TRIP-2', route_id: '72', route_ref: '72', destination: 'Централна гара', timestamp: T(11, 5), direction_key: 'D1' },
  { course_id: 'c3', source_trip_id: 'TRIP-3', route_id: '72', route_ref: '72', destination: 'Централна гара', timestamp: T(11, 12), direction_key: 'D1' },
  { course_id: 'c4', source_trip_id: 'TRIP-4', route_id: '72', route_ref: '72', destination: 'Централна гара', timestamp: T(11, 19), direction_key: 'D1' },
  { course_id: 'c5', source_trip_id: 'TRIP-5', route_id: '72', route_ref: '72', destination: 'Централна гара', timestamp: T(11, 26), direction_key: 'D1' }
];
const realtimeCandidates = [
  { course_id: 'rt1', source_trip_id: 'TRIP-1', route_id: '72', route_ref: '72', destination: 'Централна гара', timestamp: T(10, 57), scheduled_timestamp: T(10, 59), direction_key: 'D1', delay: -120 },
  { course_id: 'rt2', source_trip_id: 'TRIP-2', route_id: '72', route_ref: '72', destination: 'Централна гара', timestamp: T(11, 6), scheduled_timestamp: T(11, 5), direction_key: 'D1', delay: 60 },
  { course_id: 'rt4', source_trip_id: 'TRIP-4', route_id: '72', route_ref: '72', destination: 'Централна гара', timestamp: T(11, 17), scheduled_timestamp: T(11, 19), direction_key: 'D1', delay: -120 }
];

const merged = merger.mergeArrivalCandidates({
  staticCandidates,
  realtimeCandidates,
  nowSeconds: mergeNow,
  maxResults: 4
});
assert.deepEqual(
  merged.routes[0].times.map(item => [item.source_trip_id, item.timestamp, item.source]),
  [
    ['TRIP-1', T(10, 57), 'realtime'],
    ['TRIP-2', T(11, 6), 'realtime'],
    ['TRIP-3', T(11, 12), 'static'],
    ['TRIP-4', T(11, 17), 'realtime']
  ],
  'four displayed arrivals must be the merged chronological trips, not RT-first plus stale static duplicates'
);
assert.equal(merged.routes[0].times.length, 4, 'exactly four arrivals should be returned per line/destination');

// The critical early-vehicle case: after TRIP-1 is consumed, an RT refresh
// that temporarily omits the trip must not resurrect its 10:59 static time.
const afterRtDisappears = merger.mergeArrivalCandidates({
  staticCandidates,
  realtimeCandidates: realtimeCandidates.filter(item => item.source_trip_id !== 'TRIP-1'),
  nowSeconds: T(11, 0),
  maxResults: 4,
  isStaticConsumed: candidate => candidate.source_trip_id === 'TRIP-1'
});
assert.deepEqual(
  afterRtDisappears.routes[0].times.map(item => [item.source_trip_id, item.timestamp, item.source]),
  [
    ['TRIP-2', T(11, 6), 'realtime'],
    ['TRIP-3', T(11, 12), 'static'],
    ['TRIP-4', T(11, 17), 'realtime'],
    ['TRIP-5', T(11, 26), 'static']
  ],
  'a consumed early realtime trip must stay absent when its realtime update disappears'
);

// A future RT disappearance must not consume its static counterpart.
const beforeArrival = merger.mergeArrivalCandidates({
  staticCandidates,
  realtimeCandidates: realtimeCandidates.filter(item => item.source_trip_id !== 'TRIP-2'),
  nowSeconds: T(11, 0),
  maxResults: 4,
  isStaticConsumed: () => false
});
assert.ok(
  beforeArrival.routes[0].times.some(item => item.source_trip_id === 'TRIP-2' && item.source === 'static'),
  'a future realtime trip disappearing before arrival must allow its static fallback'
);

// Replacement/added RT trip without a static identity must coexist with the
// next static course rather than suppressing the entire line/direction.
const addedTrip = merger.mergeArrivalCandidates({
  staticCandidates: staticCandidates.slice(1),
  realtimeCandidates: [{
    course_id: 'rt-added',
    source_trip_id: 'NEW-TRIP',
    route_id: '72',
    route_ref: '72',
    destination: 'Централна гара',
    timestamp: T(11, 1),
    scheduled_timestamp: null,
    direction_key: 'D1'
  }],
  nowSeconds: T(11, 0),
  maxResults: 4
});
assert.deepEqual(
  addedTrip.routes[0].times.map(item => [item.source_trip_id, item.source]),
  [
    ['NEW-TRIP', 'realtime'],
    ['TRIP-2', 'static'],
    ['TRIP-3', 'static'],
    ['TRIP-4', 'static']
  ],
  'an unmatched realtime trip must be added without hiding unrelated static trips'
);

// Fallback identity when an RT producer omits trip_id: scheduled time can still
// safely match the nearby static course within the explicit five-minute window.
const fallbackMatched = merger.mergeArrivalCandidates({
  staticCandidates: [staticCandidates[0]],
  realtimeCandidates: [{
    course_id: 'rt-no-trip',
    source_trip_id: '',
    route_id: '72',
    route_ref: '72',
    destination: 'Централна гара',
    timestamp: T(10, 58),
    scheduled_timestamp: T(10, 59),
    direction_key: 'D1'
  }],
  nowSeconds: mergeNow,
  maxResults: 4
});
assert.equal(fallbackMatched.routes[0].times.length, 1);
assert.equal(fallbackMatched.routes[0].times[0].source, 'realtime');
assert.equal(fallbackMatched.matches.length, 1);

// Countdown rounding is deliberately nearest-minute: 29 sec -> 0, 30 sec -> 1.
assert.equal(merger.roundRemainingMinutes(1_059, 1_000), 0);
assert.equal(merger.roundRemainingMinutes(1_060, 1_000), 1);
assert.equal(merger.roundRemainingMinutes(1_089, 1_000), 1);
assert.equal(merger.roundRemainingMinutes(1_090, 1_000), 2);

console.log('virtual-board-arrivals: all tests passed');
