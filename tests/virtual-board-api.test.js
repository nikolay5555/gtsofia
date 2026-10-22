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

function encodeTripDescriptor({ tripId, startTime, routeId }) {
  return Buffer.concat([
    field(1, 2, text(tripId)),
    field(2, 2, text(startTime)),
    field(3, 2, text('20260930')),
    field(5, 2, text(routeId))
  ]);
}

function encodeStopTimeUpdate({
  stopId = null,
  stopSequence = null,
  relationship,
  timestamp = null,
  arrivalTimestamp = timestamp,
  departureTimestamp = null,
  scheduledTime = null,
  departureScheduledTime = null
}) {
  const fields = [];
  if (stopSequence != null) fields.push(field(1, 0, varint(stopSequence)));
  if (stopId != null) fields.push(field(4, 2, text(stopId)));
  fields.push(field(5, 0, varint(relationship)));

  const encodeEvent = (eventTimestamp, eventScheduledTime) => {
    const eventFields = [];
    if (eventTimestamp != null) eventFields.push(field(2, 0, varint(eventTimestamp)));
    if (eventScheduledTime != null) eventFields.push(field(3, 0, varint(eventScheduledTime)));
    return Buffer.concat(eventFields);
  };

  if (arrivalTimestamp != null || scheduledTime != null) {
    fields.push(field(2, 2, encodeEvent(arrivalTimestamp, scheduledTime)));
  }
  if (departureTimestamp != null || departureScheduledTime != null) {
    fields.push(field(3, 2, encodeEvent(departureTimestamp, departureScheduledTime)));
  }

  return Buffer.concat(fields);
}

function encodeTripUpdate({ trip, stopUpdates }) {
  return Buffer.concat([
    field(1, 2, encodeTripDescriptor(trip)),
    ...stopUpdates.map(stopUpdate => field(2, 2, encodeStopTimeUpdate(stopUpdate)))
  ]);
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
    departureTimestamp: now + 120,
    scheduledTime: now + 60,
    departureScheduledTime: now + 120
  }]
});

const dwellingTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-DWELLING',
    startTime: '08:35:00',
    routeId: 'TB3'
  },
  stopUpdates: [{
    stopId: '0605',
    relationship: 0,
    arrivalTimestamp: now - 70,
    departureTimestamp: now + 20,
    scheduledTime: now - 80,
    departureScheduledTime: now + 10
  }]
});

const staleTrip = encodeTripUpdate({
  trip: {
    tripId: 'REALTIME-STALE',
    startTime: '08:30:00',
    routeId: 'TB4'
  },
  stopUpdates: [{
    stopId: '0605',
    relationship: 0,
    arrivalTimestamp: now - 70,
    scheduledTime: now - 70
  }]
});

const feed = Buffer.concat([
  field(2, 2, encodeEntity('skipped', skippedTrip)),
  field(2, 2, encodeEntity('skipped-sequence', sequenceSkippedTrip)),
  field(2, 2, encodeEntity('no-data', noDataTrip)),
  field(2, 2, encodeEntity('normal', normalTrip)),
  field(2, 2, encodeEntity('dwelling', dwellingTrip)),
  field(2, 2, encodeEntity('stale', staleTrip))
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

  const normalRoute = payload.routes.find(item => item.trip_id === 'REALTIME-NORMAL');
  assert.ok(
    normalRoute,
    'NO_DATA must not become a suppression signal, and the normal realtime arrival must remain visible'
  );
  assert.equal(
    normalRoute.times[0].departure_timestamp,
    now + 120,
    'the API should expose the departure timestamp when it is present'
  );
  assert.equal(
    normalRoute.times[0].expiry_timestamp,
    now + 120,
    'the arrival should expire at departure when a departure event is available'
  );

  const dwellingRoute = payload.routes.find(item => item.trip_id === 'REALTIME-DWELLING');
  assert.ok(
    dwellingRoute,
    'an arrival timestamp that has passed must remain visible while its departure timestamp is still in the future'
  );
  assert.equal(dwellingRoute.times[0].timestamp, now - 70);
  assert.equal(dwellingRoute.times[0].departure_timestamp, now + 20);
  assert.equal(dwellingRoute.times[0].expiry_timestamp, now + 20);
  assert.equal(
    payload.routes.some(item => item.trip_id === 'REALTIME-STALE'),
    false,
    'a stale arrival without departure data must expire after the short dwell window instead of lingering for 60 seconds'
  );

  assert.equal(
    payload.active_trips.find(item => item.trip_id === 'REALTIME-NORMAL').destination_stop_id,
    '0605',
    'active realtime trips must expose their terminal stop so unknown/replacement trips can be direction-resolved'
  );

  console.log('virtual-board-api: all tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
