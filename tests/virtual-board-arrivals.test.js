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
    `\n  globalThis.__testInternals = {\n    getConsumedRealtimeArrivalKey,\n    rememberConsumedRealtimeArrivals,\n    isConsumedRealtimeScheduledArrival,\n    isSkippedStaticSchedule,\n    isServiceActiveOnDate,\n    getArrivalExpiryTimestamp,\n    isArrivalStillRelevant,\n    shouldRefreshForArrivalExpiry,\n    formatArrivalCountdown,\n    shouldUseStaticFallbackForDirection,\n    getOSMDestinationName,\n    setTestState({ transportData: nextTransportData, trips = [] } = {}) {\n      transportData = nextTransportData || null;\n      tripById = new Map(trips.map(trip => [String(trip.trip_id), trip]));\n    }\n  };\n})();`
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
  internals.formatArrivalCountdown(countdownNow + 59.9, countdownNow),
  '1 мин.',
  '59.9 seconds remaining rounds to one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 29.9, countdownNow),
  '0 мин.',
  'the final 30 seconds before arrival must show zero minutes'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 30, countdownNow),
  '1 мин.',
  'exactly 30 seconds remaining rounds to one minute'
);
assert.equal(
  internals.formatArrivalCountdown(countdownNow + 0.1, countdownNow),
  '0 мин.',
  'a vehicle predicted to arrive in less than 30 seconds should already show zero minutes'
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

const atStopArrival = {
  timestamp: 1_000,
  departureTimestamp: 1_100,
  expiryTimestamp: 1_100,
  scheduled: false,
  source: 'realtime'
};
assert.equal(
  internals.formatArrivalCountdown(atStopArrival.timestamp, 1_050),
  '0 мин.',
  'a vehicle that has reached the stop should keep a zero-minute arrival display while its departure is still ahead'
);
assert.equal(
  internals.getArrivalExpiryTimestamp(atStopArrival),
  1_100,
  'when available, the predicted departure time expires the current arrival'
);
const nearImmediateDeparture = {
  timestamp: 4_000,
  departureTimestamp: 4_003,
  expiryTimestamp: 4_003,
  scheduled: false,
  source: 'realtime'
};
assert.equal(
  internals.getArrivalExpiryTimestamp(nearImmediateDeparture),
  4_015,
  'a near-immediate departure must not shorten the visible zero-minute state below 15 seconds after arrival'
);
assert.equal(
  internals.isArrivalStillRelevant(atStopArrival, 1_099),
  true,
  'the current vehicle must remain visible up to its departure time'
);
assert.equal(
  internals.isArrivalStillRelevant(atStopArrival, 1_104),
  true,
  'a brief five-second grace avoids flicker at the predicted departure boundary'
);
assert.equal(
  internals.isArrivalStillRelevant(atStopArrival, 1_106),
  false,
  'the vehicle should no longer remain the current arrival after the short departure grace'
);
assert.equal(
  internals.shouldRefreshForArrivalExpiry(atStopArrival, 1_105),
  false,
  'an expiry must not trigger a refresh before the API expiry grace elapses'
);
assert.equal(
  internals.shouldRefreshForArrivalExpiry(atStopArrival, 1_106),
  true,
  'the board should refresh after departure plus the short grace to fetch the next course'
);

const realtimeWithoutDeparture = {
  timestamp: 2_000,
  departureTimestamp: null,
  expiryTimestamp: null,
  scheduled: false,
  source: 'realtime'
};
assert.equal(
  internals.getArrivalExpiryTimestamp(realtimeWithoutDeparture),
  2_015,
  'when departure is missing, realtime arrivals use a short 15-second dwell window'
);
assert.equal(
  internals.isArrivalStillRelevant(realtimeWithoutDeparture, 2_020),
  true,
  'arrival-only realtime data stays visible only through the short dwell window and its boundary grace'
);
assert.equal(
  internals.isArrivalStillRelevant(realtimeWithoutDeparture, 2_021),
  false,
  'arrival-only realtime data must not linger for a full minute'
);
assert.equal(
  internals.getArrivalExpiryTimestamp({ timestamp: 3_000, scheduled: true, source: 'static' }),
  3_000,
  'static timetable fallback expires at its scheduled time, not at the realtime dwell-window end'
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

// Once a split calendar declares its exact coverage, old/future exceptions are
// not scanned as a fallback when the date is outside that coverage.
internals.setTestState({
  transportData: {
    calendar: {
      coverageStartDate: '2026-10-22',
      coverageEndDate: '2026-11-06',
      serviceIdsByDate: {
        '2026-10-22': ['IN-WINDOW']
      },
      servicePatterns: [],
      exceptions: [
        { service_id: 'OLD-SERVICE', date: '20261001', exception_type: '1' }
      ]
    }
  },
  trips: []
});
assert.equal(
  internals.isServiceActiveOnDate('OLD-SERVICE', new Date('2026-10-01T10:00:00+03:00')),
  false,
  'old calendar exceptions must not reactivate services outside split-data coverage'
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

// Regression: the vehicle's prediction is still in the future at one poll,
// then its realtime record vanishes after it passes before the next poll.
// The observed ETA must still consume the old scheduled course.
const pendingStorage = createStorage();
const pendingInternals = loadInternals(pendingStorage);
const pendingNow = Date.now() / 1000;
const pendingScheduled = Math.floor((pendingNow + 300) / 60) * 60;
const pendingTripId = 'GTFS-TRIP-EARLY';
pendingInternals.rememberConsumedRealtimeArrivals(
  { stop_id: stopId },
  [{
    route_id: routeId,
    trip_id: pendingTripId,
    destination: 'Краен пункт по реално време',
    times: [{
      timestamp: pendingNow + 20,
      scheduled_time: pendingScheduled,
      trip_id: pendingTripId
    }]
  }],
  pendingNow
);
assert.equal(
  pendingInternals.isConsumedRealtimeScheduledArrival(
    stopId,
    routeId,
    'Разписание за по-дълъг маршрут',
    pendingScheduled,
    pendingTripId,
    pendingNow
  ),
  false,
  'a future prediction must not consume the static course early'
);
assert.equal(
  pendingInternals.isConsumedRealtimeScheduledArrival(
    stopId,
    routeId,
    'Разписание за по-дълъг маршрут',
    pendingScheduled,
    pendingTripId,
    pendingNow + 25
  ),
  true,
  'the passed course must stay consumed even when the next realtime response omitted it'
);
assert.equal(
  pendingInternals.isConsumedRealtimeScheduledArrival(
    stopId,
    routeId,
    destination,
    pendingScheduled + 15 * 60,
    'GTFS-TRIP-NEXT',
    pendingNow + 25
  ),
  false,
  'the next realtime/scheduled course must remain eligible'
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
          destination: 'Старо име от GTFS',
          headsign: 'Старо име от GTFS',
          shape_id: 'SHAPE-1',
          pattern: ['1000', '0605', '2000']
        }
      }
    },
    stops: [
      { stop_id: '2000', stop_name: 'Актуално OSM име' },
      { stop_id: '3000', stop_name: 'Краен пункт на частичен курс' }
    ]
  },
  trips: [{
    trip_id: 'REALTIME-11',
    route_id: 'TEST_ROUTE',
    trip_headsign: 'Тестова спирка',
    shape_id: 'SHAPE-1'
  }]
});

assert.equal(
  internals.getOSMDestinationName({
    destination: 'Старо име от GTFS',
    headsign: 'Старо име от GTFS',
    pattern: ['1000', '0605', '2000']
  }),
  'Актуално OSM име',
  'virtual-board destination must come from the current OSM-enriched terminal stop, not a stale GTFS headsign'
);
assert.equal(
  internals.getOSMDestinationName({
    destination: 'Дългото направление',
    headsign: 'Дългото направление',
    pattern: ['1000', '0605', '2000']
  }, '3000'),
  'Краен пункт на частичен курс',
  'an explicit terminal stop must take precedence for a short/partial course'
);

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

// Static fallback is directional, not line-wide: the same line may keep a
// realtime course in one direction while the opposite direction uses static.
assert.equal(
  internals.shouldUseStaticFallbackForDirection(
    { route_id: 'R1', direction_key: 'D1', destination: 'Център' },
    { realtimeRoutes: [{ route_id: 'R1', direction_key: 'D1' }], activeDirections: [] }
  ), false, 'same line + direction realtime must suppress static fallback'
);
assert.equal(
  internals.shouldUseStaticFallbackForDirection(
    { route_id: 'R1', direction_key: 'D2', destination: 'Квартал' },
    { realtimeRoutes: [{ route_id: 'R1', direction_key: 'D1' }], activeDirections: [] }
  ), true, 'realtime in the opposite direction must not suppress static fallback'
);
assert.equal(
  internals.shouldUseStaticFallbackForDirection(
    { route_id: 'R1', direction_key: 'D2', destination: 'Квартал' },
    { realtimeRoutes: [], activeDirections: [{ route_id: 'R1', key: 'D2' }] }
  ), false, 'an active realtime trip without an arrival row must still suppress that direction'
);
assert.equal(
  internals.shouldUseStaticFallbackForDirection(
    { route_id: 'R1', direction_key: 'D2', destination: 'Квартал' },
    { realtimeRoutes: [], activeDirections: [{ route_id: 'R1', key: 'D1' }] }
  ), true, 'an active trip in another direction must not suppress fallback'
);

console.log('virtual-board-arrivals: all tests passed');
