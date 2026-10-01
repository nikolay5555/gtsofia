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

function encodeTripDescriptor({ tripId, startTime, startDate = '20260930', routeId }) {
  return Buffer.concat([
    field(1, 2, text(tripId)),
    field(2, 2, text(startTime)),
    field(3, 2, text(startDate)),
    field(5, 2, text(routeId))
  ]);
}

function encodeStopTimeUpdate({ stopId = null, stopSequence = null, relationship, delay = null, timestamp = null, scheduledTime = null }) {
  const fields = [];
  if (stopSequence != null) fields.push(field(1, 0, varint(stopSequence)));
  if (stopId != null) fields.push(field(4, 2, text(stopId)));
  fields.push(field(5, 0, varint(relationship)));

  if (delay != null || timestamp != null || scheduledTime != null) {
    const eventFields = [];
    if (delay != null) eventFields.push(field(1, 0, varint(delay)));
    if (timestamp != null) eventFields.push(field(2, 0, varint(timestamp)));
    if (scheduledTime != null) eventFields.push(field(3, 0, varint(scheduledTime)));
    fields.push(field(2, 2, Buffer.concat(eventFields)));
  }

  return Buffer.concat(fields);
}

function encodeTripUpdate({ trip, stopUpdates, tripDelay = null }) {
  const fields = [field(1, 2, encodeTripDescriptor(trip))];
  fields.push(...stopUpdates.map(stopUpdate => field(2, 2, encodeStopTimeUpdate(stopUpdate))));
  if (tripDelay != null) fields.push(field(5, 0, varint(tripDelay)));
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



// Realtime may publish a delay only for an earlier stop (or at trip level).
// The following stop should inherit that delay even when its own StopTimeUpdate
// has not been published yet.
const sofaParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Sofia',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
}).formatToParts(new Date());
const getPart = type => sofaParts.find(part => part.type === type)?.value || '0';
const currentSofiaSeconds = Number(getPart('hour')) * 3600
  + Number(getPart('minute')) * 60
  + Number(getPart('second'));
const currentSofiaDateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Sofia',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).formatToParts(new Date());
const getDatePart = type => currentSofiaDateParts.find(part => part.type === type)?.value || '00';
const currentSofiaDate = `${getDatePart('year')}${getDatePart('month')}${getDatePart('day')}`;
const inferScheduledStart = currentSofiaSeconds + 5 * 60;
const inferTarget = currentSofiaSeconds + 10 * 60;
const formatGtfs = total => {
  const hour = Math.floor(total / 3600) % 24;
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
};
const inferStaticIndex = handler.buildStaticRealtimeIndex({
  trips: [{
    trip_id: 'STATIC-INFERRED-1',
    route_id: 'TEST-INFERRED',
    service_id: 'TEST-SERVICE',
    trip_headsign: 'Тестова посока'
  }],
  directions: {
    'TEST-INFERRED': {
      D1: { pattern: ['9001', '9002', '9003'], trip_ids: ['STATIC-INFERRED-1'] }
    }
  },
  schedules: {
    'TEST-INFERRED': {
      D1: {
        weekday: [{
          original_trip_id: 'STATIC-INFERRED-1',
          service_id: 'TEST-SERVICE',
          start_time: formatGtfs(inferScheduledStart),
          times: [
            formatGtfs(inferScheduledStart),
            formatGtfs(currentSofiaSeconds + 8 * 60),
            formatGtfs(inferTarget)
          ],
          stop_sequences: [1, 2, 3]
        }],
        weekend: []
      }
    }
  }
});
const inferredTrip = {
  trip: {
    tripId: 'STATIC-INFERRED-1',
    startTime: formatGtfs(inferScheduledStart),
    startDate: currentSofiaDate,
    routeId: 'TEST-INFERRED'
  },
  stopTimeUpdates: [],
  delay: 120
};
const inferredPrediction = handler.predictTripArrivalAtStop(
  inferredTrip,
  '9003',
  inferStaticIndex
);
assert.equal(inferredPrediction.status, 'arrival');
assert.equal(inferredPrediction.inferred, true);
assert.equal(inferredPrediction.delay, 120);
const inferredBoard = handler.buildBoard(
  [inferredTrip],
  '9003',
  Math.floor(Date.now() / 1000),
  inferStaticIndex
);
assert.equal(inferredBoard.routes.length, 1);
assert.equal(inferredBoard.routes[0].times[0].scheduled_time > 0, true);
assert.equal(inferredBoard.routes[0].times[0].delay, 120);


const priorStopDelayTrip = {
  trip: {
    tripId: 'STATIC-INFERRED-1',
    startTime: formatGtfs(inferScheduledStart),
    startDate: currentSofiaDate,
    routeId: 'TEST-INFERRED'
  },
  stopTimeUpdates: [{
    stopSequence: 1,
    relationship: 0,
    arrival: { delay: 180 }
  }],
  delay: null
};
const priorStopPrediction = handler.predictTripArrivalAtStop(
  priorStopDelayTrip,
  '9003',
  inferStaticIndex
);
assert.equal(priorStopPrediction.status, 'arrival');
assert.equal(priorStopPrediction.inferred, true);
assert.equal(priorStopPrediction.delay, 180);
const encodedPriorStopDelayTrip = encodeTripUpdate({
  trip: priorStopDelayTrip.trip,
  stopUpdates: priorStopDelayTrip.stopTimeUpdates
});
assert.ok(encodedPriorStopDelayTrip.length > 0);

const feed = Buffer.concat([
  field(2, 2, encodeEntity('skipped', skippedTrip)),
  field(2, 2, encodeEntity('skipped-sequence', sequenceSkippedTrip)),
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
  assert.equal(payload.skipped_trips.length, 2);
  assert.equal(payload.skipped_trips[0].trip_id, 'REALTIME-SKIPPED');
  assert.equal(payload.skipped_trips[0].route_id, 'TB2');
  assert.equal(payload.skipped_trips[0].start_time, '08:10:00');
  assert.equal(payload.skipped_trips[1].trip_id, 'REALTIME-SKIPPED-SEQUENCE');
  assert.equal(payload.skipped_trips[1].stop_id, '');
  assert.equal(payload.skipped_trips[1].stop_sequence, 24);

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
