const assert = require('node:assert/strict');
const handler = require('../api/virtual-board.js');
const { buildVirtualBoard } = require('../api/virtual-board-service');

function varint(value) {
  let n = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function field(number, wireType, value) {
  const tag = varint((number << 3) | wireType);
  if (wireType === 0) return Buffer.concat([tag, value]);
  if (wireType === 2) return Buffer.concat([tag, varint(value.length), value]);
  throw new Error(`Unsupported wire type ${wireType}`);
}

const text = value => Buffer.from(String(value), 'utf8');

function encodeTripDescriptor({ tripId, startTime, startDate = '20260930', routeId }) {
  return Buffer.concat([
    field(1, 2, text(tripId)),
    field(2, 2, text(startTime)),
    field(3, 2, text(startDate)),
    field(5, 2, text(routeId))
  ]);
}

function encodeStopTimeUpdate({ stopId = null, stopSequence = null, relationship, timestamp = null, scheduledTime = null, delay = null, uncertainty = null }) {
  const fields = [];
  if (stopSequence != null) fields.push(field(1, 0, varint(stopSequence)));
  if (stopId != null) fields.push(field(4, 2, text(stopId)));
  fields.push(field(5, 0, varint(relationship)));

  if (timestamp != null || scheduledTime != null) {
    const eventFields = [];
    if (delay != null) eventFields.push(field(1, 0, varint(delay)));
    if (timestamp != null) eventFields.push(field(2, 0, varint(timestamp)));
    if (scheduledTime != null) eventFields.push(field(3, 0, varint(scheduledTime)));
    if (uncertainty != null) eventFields.push(field(4, 0, varint(uncertainty)));
    fields.push(field(2, 2, Buffer.concat(eventFields)));
  }

  return Buffer.concat(fields);
}

function encodeTripProperties({ tripId, startDate, startTime }) {
  return Buffer.concat([
    field(1, 2, text(tripId)),
    field(2, 2, text(startDate)),
    field(3, 2, text(startTime))
  ]);
}

function encodeTripUpdate({ trip = null, tripProperties = null, stopUpdates = [] }) {
  return Buffer.concat([
    ...(trip ? [field(1, 2, encodeTripDescriptor(trip))] : []),
    ...(tripProperties ? [field(6, 2, encodeTripProperties(tripProperties))] : []),
    ...stopUpdates.map(stopUpdate => field(2, 2, encodeStopTimeUpdate(stopUpdate)))
  ]);
}

function encodeEntity(id, tripUpdate, isDeleted = false) {
  return Buffer.concat([
    field(1, 2, text(id)),
    ...(isDeleted ? [field(2, 0, varint(1))] : []),
    field(3, 2, tripUpdate)
  ]);
}

const now = Math.floor(Date.now() / 1000);
const nowDate = new Date(now * 1000);
const sofiaDateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit'
}).formatToParts(nowDate);
const sofiaDate = `${sofiaDateParts.find(part => part.type === 'year').value}${sofiaDateParts.find(part => part.type === 'month').value}${sofiaDateParts.find(part => part.type === 'day').value}`;

// Choose real scheduled courses from the checked-in GTFS so this test verifies
// that the binary protobuf parser preserves TripUpdates even without a stop
// prediction, and ignores FeedEntity.is_deleted=true.
const staticAtStop0605 = buildVirtualBoard({ routes: [], skipped_trips: [] }, '0605', nowDate);
const deletedFallbackCourse = staticAtStop0605.routes.find(route =>
  route.route_id === 'TB2' && route.original_trip_id && route.trip_start_time
  && route.times?.some(time => time.scheduled)
);
assert.ok(deletedFallbackCourse, 'GTFS must contain an upcoming TB2 fallback course at 0605');
const deletedFallbackTime = deletedFallbackCourse.times.find(time => time.scheduled).timestamp;

const staticAtStop2082 = buildVirtualBoard({ routes: [], skipped_trips: [] }, '2082', nowDate);
const realtimeOnlyCourse = staticAtStop2082.routes.find(route =>
  route.route_id === 'TB7' && route.original_trip_id && route.trip_start_time
  && route.times?.some(time => time.scheduled)
);
assert.ok(realtimeOnlyCourse, 'GTFS must contain an upcoming TB7 fallback course at 2082');
const realtimeOnlyTime = realtimeOnlyCourse.times.find(time => time.scheduled).timestamp;
const skippedTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-SKIPPED',
    startTime: '08:10:00',
    routeId: 'TB2'
  },
  stopUpdates: [{
    stopId: '0605',
    relationship: 1
  }]
});

const sequenceSkippedTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-SKIPPED-SEQUENCE',
    startTime: '08:10:00',
    routeId: 'TB2'
  },
  stopUpdates: [{
    stopSequence: 24,
    relationship: 1
  }]
});

const noDataTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-NODATA',
    startTime: '08:25:00',
    routeId: 'TB2'
  },
  stopUpdates: [{
    stopId: '0605',
    relationship: 2
  }]
});

const normalTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-NORMAL',
    startTime: '08:40:00',
    routeId: 'TB2'
  },
  stopUpdates: [{
    stopId: '0605',
    relationship: 0,
    timestamp: now + 60,
    scheduledTime: now + 75,
    delay: -15,
    uncertainty: 30
  }]
});

const feed = Buffer.concat([
  field(2, 2, encodeEntity('skipped', skippedTrip)),
  field(2, 2, encodeEntity('skipped-sequence', sequenceSkippedTrip)),
  field(2, 2, encodeEntity('no-data', noDataTrip)),
  field(2, 2, encodeEntity('normal', normalTrip)),
  // Exact live trip with no StopTimeUpdates: suppresses only its static fallback.
  field(2, 2, encodeEntity('realtime-without-stop-prediction', encodeTripUpdate({
    tripProperties: {
      tripId: realtimeOnlyCourse.original_trip_id,
      startTime: realtimeOnlyCourse.trip_start_time,
      startDate: sofiaDate
    }
  }))),
  // A deleted entity is not an active realtime trip and must not suppress fallback.
  field(2, 2, encodeEntity('deleted-trip', encodeTripUpdate({
    trip: {
      tripId: deletedFallbackCourse.original_trip_id,
      startTime: deletedFallbackCourse.trip_start_time,
      startDate: sofiaDate,
      routeId: 'TB2'
    }
  }), true))
]);

global.fetch = async () => ({
  ok: true,
  arrayBuffer: async () => feed.buffer.slice(feed.byteOffset, feed.byteOffset + feed.byteLength)
});

const req = {
  method: 'GET',
  query: { stop_code: '0605' }
};

let payload = null;
const res = {
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(value) {
    payload = value;
    return this;
  },
  setHeader() {}
};

(async () => {
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(payload.status === 'ok' || payload.status === 'empty', true);
  assert.ok(Array.isArray(payload.routes), 'the API must return the final board rows');
  assert.equal(typeof payload.generated_at, 'number');
  assert.equal(Object.hasOwn(payload, 'active_trips'), false);
  assert.equal(Object.hasOwn(payload, 'skipped_trips'), false);

  const realtimeArrival = payload.routes.find(route =>
    route.trip_id === 'REALTIME-NORMAL'
      && route.times?.some(time => Number(time.timestamp) === now + 60)
  );
  assert.ok(realtimeArrival, 'a stop-specific realtime prediction must be included in the final board response');
  assert.equal(realtimeArrival.realtime, true);
  assert.ok(realtimeArrival.meta, 'the API should return line display metadata');
  assert.ok(realtimeArrival.destination, 'the API should resolve a destination before returning the board');
  assert.ok(
    realtimeArrival.times.some(time => time.delay === -15 && time.uncertainty === 30
      && Number(time.scheduled_time) === now + 75),
    'the protobuf decoder must preserve signed delay, scheduled time and uncertainty'
  );

  const deletedFallbackTimes = payload.routes
    .filter(route => route.route_id === 'TB2')
    .flatMap(route => route.times.map(time => Number(time.timestamp)));
  assert.ok(
    deletedFallbackTimes.includes(Math.round(deletedFallbackTime)),
    'a deleted FeedEntity must not suppress the matching static fallback course'
  );

  req.query.stop_code = '2082';
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  const realtimeOnlyTimes = payload.routes
    .filter(route => route.route_id === 'TB7')
    .flatMap(route => route.times.map(time => Number(time.timestamp)));
  assert.ok(
    !realtimeOnlyTimes.includes(Math.round(realtimeOnlyTime)),
    'a live TripUpdate without a prediction at the selected stop must suppress its exact static fallback'
  );
  assert.ok(
    realtimeOnlyTimes.some(time => time > realtimeOnlyTime),
    'other scheduled TB7 trips must remain visible when one trip has realtime but no stop prediction'
  );

  console.log('virtual-board-api: all tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
