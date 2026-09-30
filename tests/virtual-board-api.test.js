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

function encodeStopTimeUpdate({ stopId, relationship, timestamp = null, scheduledTime = null }) {
  const fields = [
    field(4, 2, text(stopId)),
    field(5, 0, varint(relationship))
  ];

  if (timestamp != null || scheduledTime != null) {
    const eventFields = [];
    if (timestamp != null) eventFields.push(field(2, 0, varint(timestamp)));
    if (scheduledTime != null) eventFields.push(field(3, 0, varint(scheduledTime)));
    fields.push(field(2, 2, Buffer.concat(eventFields)));
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
    scheduledTime: now + 60
  }]
});

const feed = Buffer.concat([
  field(2, 2, encodeEntity('skipped', skippedTrip)),
  field(2, 2, encodeEntity('no-data', noDataTrip)),
  field(2, 2, encodeEntity('normal', normalTrip))
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
  assert.equal(payload.skipped_trips.length, 1);
  assert.equal(payload.skipped_trips[0].trip_id, 'REALTIME-SKIPPED');
  assert.equal(payload.skipped_trips[0].route_id, 'TB2');
  assert.equal(payload.skipped_trips[0].start_time, '08:10:00');

  assert.equal(
    payload.routes.length,
    1,
    'NO_DATA must not become a suppression signal, and the normal realtime arrival must remain visible'
  );
  assert.equal(payload.routes[0].trip_id, 'REALTIME-NORMAL');

  console.log('virtual-board-api: all tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
