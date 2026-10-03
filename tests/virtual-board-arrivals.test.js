const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'virtual-boards.js');
const source = fs.readFileSync(sourcePath, 'utf8');

// Functional regression coverage below verifies the lifecycle and matching
// behavior directly; these tests intentionally do not depend on implementation
// source strings so refactors do not create false failures.

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
    `\n  globalThis.__testInternals = {\n    getConsumedRealtimeArrivalKey,\n    rememberConsumedRealtimeArrivals,\n    isConsumedRealtimeScheduledArrival,\n    isSkippedStaticSchedule,\n    isServiceActiveOnDate,\n    formatArrivalCountdown,\n    getRealtimeScheduledTimestamp,\n    findRealtimeStaticMatchIndex,\n    findRealtimeStaticMatch,\n    findRealtimeStaticMatchEntryAcrossDirections,\n    getStaticCourseKey,\n    getStaticScheduleTimeValue,\n    gtfsSecondsToServiceDateTimestamp,\n    getRealtimeCourseStateKey,\n    rememberRealtimeCourseAssignment,\n    promotePassedRealtimeCourseStates,\n    isRealtimeCourseConsumed,\n    setTestState({ transportData: nextTransportData, trips = [] } = {}) {\n      transportData = nextTransportData || null;\n      tripById = new Map(trips.map(trip => [String(trip.trip_id), trip]));\n    }\n  };\n})();`
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

assert.equal(
  source.includes('function isSkippedStaticSchedule'),
  true,
  'SKIPPED suppression helper must remain part of the virtual-board pipeline'
);

const storage = createStorage();
const internals = loadInternals(storage);

assert.equal(
  internals.getStaticScheduleTimeValue(
    {
      arrival_times: ['08:01:30'],
      departure_times: ['08:02:00'],
      times: ['08:02:00']
    },
    0
  ),
  '08:01:30',
  'virtual board must prefer GTFS arrival_time at the selected stop'
);

assert.equal(
  internals.getStaticScheduleTimeValue(
    {
      arrival_times: [null],
      departure_times: ['08:02:00'],
      times: ['08:02:00']
    },
    0
  ),
  '08:02:00',
  'virtual board must fall back to departure_time when arrival_time is missing'
);

assert.equal(
  internals.gtfsSecondsToServiceDateTimestamp(
    '2026-10-03',
    25 * 3600 + 30 * 60
  ),
  new Date('2026-10-04T01:30:00+03:00').getTime() / 1000,
  'GTFS service-day time after midnight must stay attached to the service date'
);

assert.equal(
  internals.getRealtimeScheduledTimestamp({
    trip_schedule_relationship: 0,
    timestamp: 1_000_600,
    scheduled_time: 1_000_500,
    delay: 100
  }),
  1_000_500,
  'scheduled trip anchor must come from time minus delay, not forbidden scheduled_time'
);

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

  // Exact scheduled arrival time must outrank an ambiguous shared trip start
  // time, otherwise a realtime course can be bound to the wrong direction.
  assert.equal(
    internals.findRealtimeStaticMatchIndex(
      { trip_id: 'RT-SAME-START', trip_start_time: '12:00:00' },
      { trip_id: 'RT-SAME-START', timestamp: 1_001_050, scheduled_time: 1_001_000, delay: 50 },
      [
        { original_trip_id: 'WRONG-DIRECTION', timestamp: 1_000_940, start_time: '12:00:00' },
        { original_trip_id: 'RIGHT-DIRECTION', timestamp: 1_001_000, start_time: '12:00:00' }
      ],
      new Set()
    ),
    1,
    'exact scheduled arrival timestamp must beat an ambiguous shared trip start time'
  );

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
    'A181||D1||1000480',
    'matched static courses must have a stable route/direction/timestamp key'
  );

    // Scheduled trips use the same static course for early, on-time and
  // late predictions. Delay may be negative, zero, or positive.
  {
    const staticRoute = {
      route_id: 'ROUTE-LIFECYCLE',
      route_ref: '9',
      direction_key: 'D1',
      destination: 'Тестова посока',
      direction_id: '0'
    };
    const staticTime = {
      timestamp: 5_000_100,
      service_date: '2026-10-03',
      original_trip_id: 'STATIC-LIFECYCLE',
      start_time: '18:00:00',
      direction_id: '0'
    };

    for (const scenario of [
      { label: 'early', actual: 5_000_040, delay: -60 },
      { label: 'on-time', actual: 5_000_100, delay: 0 },
      { label: 'late', actual: 5_000_220, delay: 120 }
    ]) {
      const match = internals.findRealtimeStaticMatch(
        {
          route_id: 'ROUTE-LIFECYCLE',
          route_ref: '9',
          trip_id: 'STATIC-LIFECYCLE',
          trip_start_date: '20261003',
          trip_start_time: '18:00:00',
          direction_id: '0',
          schedule_relationship: 0
        },
        {
          trip_id: 'STATIC-LIFECYCLE',
          trip_start_date: '20261003',
          trip_start_time: '18:00:00',
          timestamp: scenario.actual,
          delay: scenario.delay,
          trip_schedule_relationship: 0
        },
        [{ staticRoute, time: staticTime }],
        new Set()
      );

      assert.equal(
        match?.entry?.time?.original_trip_id,
        'STATIC-LIFECYCLE',
        `${scenario.label} realtime must match the same static course`
      );
      assert.equal(
        match?.strength,
        100,
        `${scenario.label} realtime must use exact trip identity`
      );
    }
  }

  // A later weaker snapshot must not replace a stronger consumed course mapping,
  // even if its direction label changes.
  {
    const storage2 = createStorage();
    const isolated = loadInternals(storage2);
    const stop = { stop_id: '0700' };
    const realtimeRoute = {
      route_id: 'ROUTE-STATE',
      trip_id: 'RT-STATE',
      trip_start_date: '20261003',
      trip_start_time: '19:00:00',
      direction_key: 'D1'
    };
    const realtimeTime = {
      trip_id: 'RT-STATE',
      trip_start_date: '20261003',
      trip_start_time: '19:00:00',
      timestamp: 6_000_000 + 60
    };

    isolated.rememberRealtimeCourseAssignment(
      stop,
      realtimeRoute,
      realtimeTime,
      { route_id: 'ROUTE-STATE', direction_key: 'D1', destination: 'A' },
      {
        original_trip_id: 'STATIC-STATE',
        service_date: '2026-10-03',
        timestamp: 6_000_000
      },
      100
    );

    isolated.promotePassedRealtimeCourseStates(6_000_000 + 61);

    isolated.rememberRealtimeCourseAssignment(
      stop,
      { ...realtimeRoute, direction_key: 'D2' },
      { ...realtimeTime, timestamp: 6_000_000 + 62 },
      { route_id: 'ROUTE-STATE', direction_key: 'D2', destination: 'B' },
      {
        original_trip_id: 'OTHER-STATIC',
        service_date: '2026-10-03',
        timestamp: 6_000_090
      },
      60
    );

    assert.equal(
      isolated.isStaticCourseConsumed(
        '0700',
        { route_id: 'ROUTE-STATE', direction_key: 'D1', destination: 'A' },
        {
          original_trip_id: 'STATIC-STATE',
          service_date: '2026-10-03',
          timestamp: 6_000_000
        }
      ),
      true,
      'weaker later realtime metadata must not resurrect the old static course'
    );
  }

  // When the realtime direction key is wrong or temporarily unavailable,
  // an exact unique scheduled timestamp must still recover the correct static
  // course across the line's directions.
  {
    const entries = [
      {
        staticRoute: { route_id: 'ROUTE-X', route_ref: '9', direction_key: 'D1', destination: 'A' },
        time: { original_trip_id: 'STATIC-X', timestamp: 4_000_100, start_time: '18:00:00' }
      },
      {
        staticRoute: { route_id: 'ROUTE-X', route_ref: '9', direction_key: 'D2', destination: 'B' },
        time: { original_trip_id: 'STATIC-Y', timestamp: 4_000_200, start_time: '18:00:00' }
      }
    ];

    const matched = internals.findRealtimeStaticMatchEntryAcrossDirections(
      { route_id: 'ROUTE-X', route_ref: '9' },
      {
        trip_id: 'REALTIME-X',
        timestamp: 3_999_990,
        scheduled_time: 4_000_200,
        delay: -210
      },
      entries,
      new Set()
    );

    assert.equal(
      matched?.time?.original_trip_id,
      'STATIC-Y',
      'a unique exact scheduled timestamp must recover a course despite wrong direction metadata'
    );
  }

  {
    const staticTime = {
      timestamp: 7_000_100,
      service_date: '2026-10-03',
      stop_sequence: 30,
      course_times: ['18:00:00', '18:02:00', '18:04:00'],
      course_arrival_times: ['18:00:00', '18:02:00', '18:04:00'],
      course_departure_times: ['18:00:20', '18:02:20', '18:04:20'],
      course_stop_sequences: [10, 20, 30]
    };

    for (const scenario of [
      { label: 'trip-early', tripDelay: -120, updates: [] },
      { label: 'trip-on-time', tripDelay: 0, updates: [] },
      { label: 'trip-late', tripDelay: 180, updates: [] },
      {
        label: 'stop-delay-propagates',
        tripDelay: null,
        updates: [
          { stop_sequence: 20, schedule_relationship: 0, delay: 90, timestamp: null }
        ]
      },
      {
        label: 'no-data-stops-propagation',
        tripDelay: 120,
        updates: [
          { stop_sequence: 20, schedule_relationship: 2, delay: null, timestamp: null }
        ]
      },
      {
        label: 'time-only-updates-propagate',
        tripDelay: null,
        updates: [
          {
            stop_sequence: 20,
            schedule_relationship: 0,
            delay: null,
            timestamp: 7_000_190
          }
        ]
      }
    ]) {
      const delay = internals.getPropagatedRealtimeDelay(
        {
          trip_delay: scenario.tripDelay,
          delay_updates: scenario.updates
        },
        staticTime
      );

      const expected = scenario.label === 'stop-delay-propagates'
        ? 90
        : scenario.label === 'no-data-stops-propagation'
          ? null
          : scenario.label === 'time-only-updates-propagate'
            ? 90
            : scenario.tripDelay;

      assert.equal(
        delay,
        expected,
        `${scenario.label} must resolve the correct propagated delay`
      );
    }
  }

// Lifecycle regression: an early realtime course must remain attached to
  // its static course after the realtime update disappears just after passing.
  {
    const lifecycleStop = { stop_id: '0687' };
    const lifecycleStaticRoute = {
      route_id: 'ROUTE-9',
      direction_key: 'D1',
      destination: 'Тестова посока'
    };
    const lifecycleStaticTime = {
      timestamp: nowSeconds + 120,
      original_trip_id: 'STATIC-9-1842',
      trip_id: 'LOGICAL-9',
      start_time: '18:00:00'
    };
    const lifecycleRealtimeRoute = {
      route_id: 'ROUTE-9',
      direction_key: 'D1',
      trip_id: 'REALTIME-9',
      trip_start_date: '20261003',
      trip_start_time: '18:00:00',
      destination: 'Тестова посока'
    };
    const lifecycleRealtimeTime = {
      trip_id: 'REALTIME-9',
      trip_start_time: '18:00:00',
      timestamp: nowSeconds + 60,
      scheduled_time: lifecycleStaticTime.timestamp
    };

    internals.rememberRealtimeCourseAssignment(
      lifecycleStop,
      lifecycleRealtimeRoute,
      lifecycleRealtimeTime,
      lifecycleStaticRoute,
      lifecycleStaticTime
    );

    assert.equal(
      internals.isRealtimeCourseConsumed(
        lifecycleStop,
        lifecycleRealtimeRoute,
        lifecycleRealtimeTime
      ),
      false,
      'an early realtime course must not be consumed before its actual arrival'
    );

    // Simulate the next refresh after the vehicle has passed the stop. The
    // realtime update itself is absent; only the persisted course state remains.
    internals.promotePassedRealtimeCourseStates(nowSeconds + 61);

    assert.equal(
      internals.isConsumedRealtimeScheduledArrival(
        '0687',
        'ROUTE-9',
        'Тестова посока',
        lifecycleStaticTime.timestamp
      ),
      true,
      'the passed realtime course must consume its anchored static time even after the feed disappears'
    );

    assert.equal(
      internals.isStaticCourseConsumed(
        '0687',
        lifecycleStaticRoute,
        lifecycleStaticTime
      ),
      true,
      'the passed realtime course must suppress its concrete static fallback after the feed disappears'
    );

    assert.equal(
      internals.isRealtimeCourseConsumed(
        lifecycleStop,
        lifecycleRealtimeRoute,
        lifecycleRealtimeTime
      ),
      true,
      'the same concrete realtime course must stay consumed after it passes'
    );

    assert.equal(
      internals.isConsumedRealtimeScheduledArrival(
        '0687',
        'ROUTE-9',
        'Тестова посока',
        lifecycleStaticTime.timestamp + 900
      ),
      false,
      'the following static course must remain available'
    );

    const reloadedLifecycleInternals = loadInternals(storage);
    assert.equal(
      reloadedLifecycleInternals.isRealtimeCourseConsumed(
        lifecycleStop,
        lifecycleRealtimeRoute,
        lifecycleRealtimeTime
      ),
      true,
      'consumed realtime course identity must survive a page refresh'
    );
  }

console.log('virtual-board-arrivals: all tests passed');
