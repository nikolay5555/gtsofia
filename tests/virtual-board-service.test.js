const assert = require('node:assert/strict');
const { buildVirtualBoard, createDataContext } = require('../api/virtual-board-service');

const now = new Date('2026-10-30T13:00:00+02:00');

function createFixture() {
  return {
    routes: [
      { route_id: 'TB7', route_short_name: '7', route_type: '11', route_color: '27AAE1', route_text_color: 'FFFFFF' },
      { route_id: 'M1', route_short_name: 'M1', route_type: '1', route_color: '1C75BC', route_text_color: 'FFFFFF' }
    ],
    directions: {
      TB7: {
        D1: {
          key: 'D1',
          headsign: 'Крайна спирка',
          destination: 'Крайна спирка',
          pattern: ['START', 'BOARD', 'END'],
          stops: [
            { stop_id: 'START', osm_name: 'Начало' },
            { stop_id: 'BOARD', osm_name: 'Табло' },
            { stop_id: 'END', osm_name: 'Крайна спирка от OSM' }
          ]
        }
      },
      M1: {
        D1: {
          key: 'D1',
          headsign: 'Метростанция Крайна',
          destination: 'Метростанция Крайна',
          pattern: ['M1', 'M2'],
          stops: [
            { stop_id: 'M1', osm_name: 'Метростанция Начална' },
            { stop_id: 'M2', osm_name: 'Метростанция Крайна' }
          ]
        }
      }
    },
    schedules: {
      TB7: {
        D1: {
          weekday: [
            {
              trip_id: 1,
              original_trip_id: 'GTFS-TRIP-A',
              service_id: 'SERVICE',
              start_time: '13:00:00',
              stop_sequences: [1, 2, 3],
              times: ['13:00:00', '13:40:00', '14:03:00']
            },
            {
              trip_id: 2,
              original_trip_id: 'GTFS-TRIP-B',
              service_id: 'SERVICE',
              start_time: '13:10:00',
              stop_sequences: [1, 2, 3],
              times: ['13:10:00', '13:50:00', '14:13:00']
            },
            {
              trip_id: 3,
              original_trip_id: 'GTFS-TRIP-C',
              service_id: 'SERVICE',
              start_time: '13:20:00',
              stop_sequences: [1, 2, 3],
              times: ['13:20:00', '14:00:00', '14:23:00']
            },
            {
              trip_id: 4,
              original_trip_id: 'GTFS-TRIP-D',
              service_id: 'SERVICE',
              start_time: '13:30:00',
              stop_sequences: [1, 2, 3],
              times: ['13:30:00', '14:10:00', '14:33:00']
            }
          ],
          weekend: []
        }
      },
      M1: {
        D1: {
          weekday: [{
            trip_id: 5,
            original_trip_id: 'METRO-TRIP-A',
            service_id: 'SERVICE',
            start_time: '13:00:00',
            stop_sequences: [1, 2],
            times: ['13:00:00', '13:20:00']
          }],
          weekend: []
        }
      }
    },
    stops: [
      { stop_id: 'BOARD', stop_code: '0200', stop_name: 'Табло', osm_stop_name: 'Табло', stop_name_source: 'osm' },
      { stop_id: 'END', stop_code: '0300', stop_name: 'Крайна спирка GTFS', osm_stop_name: 'Крайна спирка от OSM', stop_name_source: 'osm' },
      { stop_id: 'M1', stop_code: '1', stop_name: 'Метростанция Начална', osm_stop_name: 'Метростанция Начална', stop_name_source: 'osm' },
      { stop_id: 'M2', stop_code: '2', stop_name: 'Метростанция Крайна', osm_stop_name: 'Метростанция Крайна', stop_name_source: 'osm' }
    ],
    calendar: {
      dateTypes: { '2026-10-30': 'weekday' },
      serviceIdsByDate: { '2026-10-30': ['SERVICE'] }
    },
    lineOverrides: []
  };
}

const fixture = createFixture();
const service = createDataContext(fixture);

// A realtime update ending at an intermediate stop must use the exact
// scheduled trip's real terminal. Only that physical trip is deduplicated.
const intermediateRealtimeBoard = {
  status: 'ok',
  generated_at: Math.floor(now.getTime() / 1000),
  skipped_trips: [],
  routes: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    direction_id: '',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    destination_stop_id: 'BOARD',
    times: [{
      timestamp: Date.parse('2026-10-30T13:42:00+02:00') / 1000,
      scheduled_time: Date.parse('2026-10-30T13:40:00+02:00') / 1000,
      delay: 120
    }]
  }]
};

const merged = service.buildBoard(intermediateRealtimeBoard, '0200', now);
const trolley = merged.routes.find(route => route.route_id === 'TB7');
assert.ok(trolley, 'the TB7 row must be returned');
assert.equal(trolley.destination, 'Крайна спирка от OSM', 'the realtime intermediate stop must not replace the static trip terminal');
assert.deepEqual(
  trolley.times.map(time => [time.scheduled, Math.round(time.timestamp)]),
  [
    [false, Math.round(Date.parse('2026-10-30T13:42:00+02:00') / 1000)],
    [true, Math.round(Date.parse('2026-10-30T13:50:00+02:00') / 1000)],
    [true, Math.round(Date.parse('2026-10-30T14:00:00+02:00') / 1000)]
  ],
  'the realtime trip is shown once, and following static trips fill the row up to three times'
);
assert.equal(trolley.meta.number, '7', 'the API must return display-ready line metadata');

// If realtime supplies a Trip ID, a different ID must not be treated as the
// same static trip solely because its scheduled time is within two minutes.
const mismatchedTripIdBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7',
    trip_id: 'NOT-GTFS-TRIP-A',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    destination_stop_id: 'END',
    times: [{
      timestamp: Date.parse('2026-10-30T13:41:00+02:00') / 1000,
      scheduled_time: Date.parse('2026-10-30T13:40:00+02:00') / 1000,
      delay: 60
    }]
  }],
  skipped_trips: []
}, '0200', now);
const mismatchedRow = mismatchedTripIdBoard.routes.find(route => route.route_id === 'TB7');
assert.ok(mismatchedRow, 'the route row must remain present');
assert.ok(
  mismatchedRow.times.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:40:00+02:00') / 1000)),
  'a distinct static trip must not be suppressed by a nearby realtime timestamp when its Trip ID differs'
);

// The time-based fallback remains available for feeds that omit Trip ID.
const realtimeWithoutTripIdBoard = service.buildBoard({
  routes: [{
    route_id: 'TB7',
    destination_stop_id: 'END',
    direction_id: 'D1',
    times: [{
      timestamp: Date.parse('2026-10-30T13:41:00+02:00') / 1000,
      scheduled_time: Date.parse('2026-10-30T13:40:00+02:00') / 1000,
      delay: 60
    }]
  }],
  skipped_trips: []
}, '0200', now);
const noIdRow = realtimeWithoutTripIdBoard.routes.find(route => route.route_id === 'TB7');
assert.ok(noIdRow, 'a realtime row without Trip ID must still be displayed');
assert.ok(
  !noIdRow.times.some(time => time.scheduled && Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:40:00+02:00') / 1000)),
  'the fallback should deduplicate the matching static trip when realtime omits Trip ID'
);

// An active trip with no arrival at this stop is not a reason to hide a
// static timetable course. The endpoint receives only stop-specific arrivals.
const withoutStopPrediction = service.buildBoard({
  status: 'empty',
  generated_at: Math.floor(now.getTime() / 1000),
  skipped_trips: [],
  routes: []
}, '0200', now);
const staticTrolley = withoutStopPrediction.routes.find(route => route.route_id === 'TB7');
assert.ok(staticTrolley, 'static TB7 courses remain visible when there is no realtime arrival for this stop');
assert.equal(staticTrolley.times[0].scheduled, true);

// SKIPPED applies to the specific trip and stop only.
const skippedBoard = service.buildBoard({
  status: 'empty',
  generated_at: Math.floor(now.getTime() / 1000),
  skipped_trips: [{
    trip_id: 'GTFS-TRIP-A',
    route_id: 'TB7',
    stop_id: 'BOARD',
    stop_sequence: 2
  }],
  routes: []
}, '0200', now);
const skippedTimes = skippedBoard.routes.find(route => route.route_id === 'TB7').times;
assert.ok(
  !skippedTimes.some(time => Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:40:00+02:00') / 1000)),
  'the exact skipped trip must not be shown'
);
assert.ok(
  skippedTimes.some(time => Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:50:00+02:00') / 1000)),
  'a different trip on the same line and direction must remain visible'
);

// Departures at a terminal stop remain visible; terminal hiding was removed.
const terminalBoard = service.buildBoard({ routes: [], skipped_trips: [] }, '0300', now);
const terminalRow = terminalBoard.routes.find(route => route.route_id === 'TB7');
assert.ok(terminalRow, 'departures at the route terminal must remain visible');

// Metro remains schedule-only and can resolve a station when the public stop
// code does not contain the M prefix.
const metroBoard = service.buildBoard({
  routes: [{ route_id: 'M1', trip_id: 'METRO-RT', times: [{ timestamp: Date.parse('2026-10-30T13:10:00+02:00') / 1000 }] }],
  skipped_trips: []
}, '1', now);
const metroRow = metroBoard.routes.find(route => route.route_id === 'M1');
assert.ok(metroRow, 'metro static departures must be included');
assert.equal(metroRow.destination, 'Метростанция Крайна');
assert.equal(metroRow.meta.type, 'metro');
assert.ok(metroRow.times.every(time => time.scheduled), 'metro board rows remain timetable-based');

// Explicit calendar overrides take precedence over a weekday fallback when
// no precomputed dateTypes entry is present.
const overrideFixture = createFixture();
overrideFixture.calendar.dateTypes = {};
overrideFixture.calendar.config = { dateOverrides: { '2026-10-30': 'weekend' } };
overrideFixture.schedules.TB7.D1.weekend = [{
  trip_id: 20,
  original_trip_id: 'WEEKEND-TRIP',
  service_id: 'SERVICE',
  start_time: '13:11:00',
  stop_sequences: [1, 2, 3],
  times: ['13:11:00', '13:51:00', '14:14:00']
}];
const overrideService = createDataContext(overrideFixture);
const overrideBoard = overrideService.buildBoard({ routes: [], skipped_trips: [] }, '0200', now);
const overrideTimes = overrideBoard.routes.find(route => route.route_id === 'TB7').times;
assert.ok(
  overrideTimes.some(time => Math.round(time.timestamp) === Math.round(Date.parse('2026-10-30T13:51:00+02:00') / 1000)),
  'the configured weekend schedule should be selected for the override date'
);

// Use the real GTFS for TB7 to ensure the API-side terminal lookup works with
// the production data, not only with a synthetic fixture.
const actual = createDataContext();
const actualRoutes = require('../data/routes.json');
const actualDirections = require('../data/directions.json');
const actualSchedules = require('../data/schedules.json');
const actualRoute = actualRoutes.find(route => route.route_id === 'TB7');
assert.ok(actualRoute, 'the actual data must contain trolleybus 7');
const actualDirection = Object.entries(actualDirections.TB7 || {}).find(([, direction]) =>
  Array.isArray(direction.pattern) && direction.pattern.map(String).includes('2082')
);
assert.ok(actualDirection, 'the actual TB7 direction must serve stop 2082');
const [actualDirectionKey, direction] = actualDirection;
const stopIndex = direction.pattern.map(String).indexOf('2082');
const actualRow = (actualSchedules.TB7?.[actualDirectionKey]?.weekday || []).find(row =>
  row.original_trip_id && row.times?.[stopIndex] === '13:40:00'
);
assert.ok(actualRow, 'the actual timetable must contain a 13:40 TB7 trip at stop 2082');
const actualTerminalIndex = actualRow.times.map((value, index) => value ? index : -1).filter(index => index >= 0).pop();
const actualTerminalId = String(direction.pattern[actualTerminalIndex]);
const actualTripTime = Date.parse('2026-10-30T13:40:00+02:00') / 1000;
const actualNow = new Date('2026-10-30T13:35:00+02:00');
const actualBoard = actual.buildBoard({
  routes: [{
    trip_id: actualRow.original_trip_id,
    route_id: 'TB7',
    schedule_relationship: 0,
    schedule_relationship_name: 'SCHEDULED',
    destination_stop_id: '2082',
    times: [{ timestamp: actualTripTime + 90, scheduled_time: actualTripTime, delay: 90 }]
  }],
  skipped_trips: []
}, '2082', actualNow);
const actualTrolley = actualBoard.routes.find(route =>
  route.route_id === 'TB7' && route.times.some(time => Math.round(time.timestamp) === actualTripTime + 90)
);
assert.ok(actualTrolley, 'the actual TB7 realtime trip must be present');
assert.equal(actualTrolley.terminal_stop_id, actualTerminalId, 'the API must replace the intermediate realtime endpoint with the course terminal');

console.log('virtual-board-service: all tests passed');
