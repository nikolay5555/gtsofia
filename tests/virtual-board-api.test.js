const assert = require('node:assert/strict');
const handler = require('../api/virtual-board.js');

function varint(value) {
  let n = BigInt(value);
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

function encodeTripDescriptor({
  tripId,
  startTime,
  routeId,
  scheduleRelationship = 0,
  startDate = '20260930',
  directionId = null
}) {
  const fields = [
    field(1, 2, text(tripId)),
    field(2, 2, text(startTime)),
    field(3, 2, text(startDate)),
    field(4, 0, varint(scheduleRelationship)),
    field(5, 2, text(routeId))
  ];
  if (directionId != null) fields.push(field(6, 0, varint(directionId)));
  return Buffer.concat(fields);
}

function encodeStopTimeUpdate({
  stopId = null,
  stopSequence = null,
  relationship,
  timestamp = null,
  scheduledTime = null,
  delay = null,
  useDeparture = false
}) {
  const fields = [];
  if (stopSequence != null) fields.push(field(1, 0, varint(stopSequence)));
  if (stopId != null) fields.push(field(4, 2, text(stopId)));
  fields.push(field(5, 0, varint(relationship)));

  if (
    timestamp != null
    || scheduledTime != null
    || delay != null
  ) {
    const eventFields = [];
    if (delay != null) eventFields.push(field(1, 0, varint(delay < 0 ? (1n << 32n) + BigInt(delay) : delay)));
    if (timestamp != null) eventFields.push(field(2, 0, varint(timestamp)));
    if (scheduledTime != null) eventFields.push(field(3, 0, varint(scheduledTime)));
    fields.push(field(useDeparture ? 3 : 2, 2, Buffer.concat(eventFields)));
  }

  return Buffer.concat(fields);
}

function encodeTripUpdate({ trip, stopUpdates, delay = null, tripProperties = null }) {
  const fields = [field(1, 2, encodeTripDescriptor(trip))];
  fields.push(...stopUpdates.map(stopUpdate => field(2, 2, encodeStopTimeUpdate(stopUpdate))));
  if (delay != null) fields.push(field(5, 0, varint(delay < 0 ? (1n << 32n) + BigInt(delay) : delay)));
  if (tripProperties) {
    const properties = [];
    if (tripProperties.tripId != null) properties.push(field(1, 2, text(tripProperties.tripId)));
    if (tripProperties.startDate != null) properties.push(field(2, 2, text(tripProperties.startDate)));
    if (tripProperties.startTime != null) properties.push(field(3, 2, text(tripProperties.startTime)));
    fields.push(field(6, 2, Buffer.concat(properties)));
  }
  return Buffer.concat(fields);
}

function encodeEntity(id, tripUpdate) {
  return Buffer.concat([
    field(1, 2, text(id)),
    field(3, 2, tripUpdate)
  ]);
}

const now = Math.floor(Date.now() / 1000);
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

const canceledTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-CANCELED',
    startTime: '08:55:00',
    routeId: 'TB3',
    scheduleRelationship: 3
  },
  stopUpdates: [{
    stopId: '0605',
    relationship: 0,
    timestamp: now + 120,
    scheduledTime: now + 120
  }]
});

const deletedTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-DELETED',
    startTime: '09:05:00',
    routeId: 'TB4',
    scheduleRelationship: 7
  },
  stopUpdates: [{
    stopId: '0605',
    relationship: 0,
    timestamp: now + 180,
    scheduledTime: now + 180
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
    scheduledTime: now + 60
  }]
});


const delayOnlyTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-DELAY-ONLY',
    startTime: '08:45:00',
    routeId: 'TB2'
  },
  delay: 90,
  stopUpdates: [{
    stopId: '0605',
    relationship: 0,
    timestamp: null,
    scheduledTime: null,
    delay: null
  }]
});

const duplicatedDelayOnlyTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-DUPLICATED-SOURCE',
    startTime: '08:50:00',
    routeId: 'TB2',
    scheduleRelationship: 6
  },
  delay: 120,
  tripProperties: {
    tripId: 'REALTIME-DUPLICATED-NEW',
    startDate: '20260930',
    startTime: '08:50:00'
  },
  stopUpdates: [{
    stopId: '0605',
    relationship: 0,
    timestamp: null,
    scheduledTime: null,
    delay: null
  }]
});

const replacementDelayOnlyTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-REPLACEMENT-DELAY',
    startTime: '08:50:00',
    routeId: 'TB2',
    scheduleRelationship: 5
  },
  delay: 120,
  stopUpdates: [{
    stopId: '0605',
    relationship: 0,
    timestamp: null,
    scheduledTime: null,
    delay: null
  }]
});

const feed = Buffer.concat([
  field(2, 2, encodeEntity('skipped', skippedTrip)),
  field(2, 2, encodeEntity('skipped-sequence', sequenceSkippedTrip)),
  field(2, 2, encodeEntity('no-data', noDataTrip)),
  field(2, 2, encodeEntity('canceled', canceledTrip)),
  field(2, 2, encodeEntity('deleted', deletedTrip)),
  field(2, 2, encodeEntity('normal', normalTrip)),
  field(2, 2, encodeEntity('delay-only', delayOnlyTrip)),
  field(2, 2, encodeEntity('replacement-delay-only', replacementDelayOnlyTrip)),
  field(2, 2, encodeEntity('duplicated-delay-only', duplicatedDelayOnlyTrip))
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
  assert.equal(payload.skipped_trips.length, 2);
  assert.equal(payload.skipped_trips[0].trip_id, 'REALTIME-SKIPPED');
  assert.equal(payload.skipped_trips[0].route_id, 'TB2');
  assert.equal(payload.skipped_trips[0].start_time, '08:10:00');
  assert.equal(payload.skipped_trips[1].trip_id, 'REALTIME-SKIPPED-SEQUENCE');
  assert.equal(payload.skipped_trips[1].stop_id, '');
  assert.equal(payload.skipped_trips[1].stop_sequence, 24);

  assert.equal(
    payload.suppressed_trips.length,
    2,
    'CANCELED and DELETED trips must be exposed as static suppression signals'
  );
  assert.deepEqual(
    payload.suppressed_trips.map(item => item.trip_id).sort(),
    ['REALTIME-CANCELED', 'REALTIME-DELETED'],
    'canceled/deleted trip ids must be retained for exact static suppression'
  );

  const duplicatedDelayOnly = payload.routes.find(
    route => route.trip_id === 'REALTIME-DUPLICATED-NEW'
  );
  assert.ok(
    duplicatedDelayOnly,
    'DUPLICATED trips may use delay relative to their calculated schedule'
  );
  assert.equal(
    duplicatedDelayOnly.times[0].timestamp,
    null,
    'a duplicated delay-only update without a static match must preserve unknown absolute time'
  );

  const replacementDelayOnly = payload.routes.find(
    route => route.trip_id === 'REALTIME-REPLACEMENT-DELAY'
  );
  assert.equal(
    replacementDelayOnly,
    undefined,
    'NEW/REPLACEMENT trips must not derive realtime timing from delay-only data'
  );
  const delayOnly = payload.routes.find(route => route.trip_id === 'REALTIME-DELAY-ONLY');
  assert.ok(delayOnly, 'delay-only scheduled StopTimeUpdate must be preserved');
  assert.equal(delayOnly.times[0].timestamp, null);
  assert.equal(delayOnly.times[0].delay, 90);

  assert.equal(
    payload.routes.length,
    2,
    'NO_DATA must not become a suppression signal, and both normal and delay-only realtime arrivals must remain available'
  );
  assert.equal(
    payload.routes.find(route => route.trip_id === 'REALTIME-NORMAL')?.times?.length,
    1
  );
  assert.deepEqual(
    payload.realtime_route_ids.sort(),
    ['TB2'],
    'canceled/deleted routes must not count as realtime-supported fallback blockers'
  );

  const normalActiveTrip = payload.active_trips.find(
    item => item.trip_id === 'REALTIME-NORMAL'
  );
  assert.equal(
    normalActiveTrip?.trip_delay,
    null,
    'an omitted TripUpdate.delay must remain unknown rather than becoming zero'
  );
  assert.equal(
    normalActiveTrip?.delay_updates?.[0]?.stop_sequence,
    null,
    'an omitted StopTimeUpdate.stop_sequence must remain unknown'
  );

  const duplicatedActiveTrip = payload.active_trips.find(
    item => item.trip_id === 'REALTIME-DUPLICATED-NEW'
  );
  assert.ok(duplicatedActiveTrip, 'DUPLICATED trip properties must define the active trip identity');
  assert.equal(
    duplicatedActiveTrip.trip_delay,
    120,
    'DUPLICATED trips must retain TripUpdate.delay as delay against the calculated duplicate schedule'
  );

  const replacementDelayOnlyActiveTrip = payload.active_trips.find(
    item => item.trip_id === 'REALTIME-REPLACEMENT-DELAY'
  );
  assert.ok(
    replacementDelayOnlyActiveTrip,
    'replacement trip identity may remain active even without valid stop timing'
  );
  assert.equal(
    replacementDelayOnlyActiveTrip.trip_delay,
    null,
    'NEW/REPLACEMENT trips must not expose TripUpdate.delay as static schedule deviation'
  );

  const delayOnlyActiveTrip = payload.active_trips.find(
    item => item.trip_id === 'REALTIME-DELAY-ONLY'
  );
  assert.ok(delayOnlyActiveTrip, 'delay-only trip must remain an active trip');
  assert.equal(delayOnlyActiveTrip.trip_delay, 90);
  assert.deepEqual(
    delayOnlyActiveTrip.delay_updates,
    [{
      stop_id: '0605',
      stop_sequence: null,
      schedule_relationship: 0,
      delay: null,
      timestamp: null,
      scheduled_time: null
    }],
    'missing StopTimeEvent delay must remain unknown rather than coercing to zero'
  );

  console.log('virtual-board-api: all tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
