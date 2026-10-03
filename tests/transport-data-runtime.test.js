const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'transport-data.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const context = {
  console,
  Math,
  Intl,
  window: {},
  fetch: async () => {
    throw new Error('fetch must not be called by buildRuntimeSchedules tests');
  }
};

vm.runInNewContext(source, context, { filename: sourcePath });

const schedules = context.buildRuntimeSchedules(
  [{
    id: 1,
    cgm_id: 'R1',
    direction: 1
  }],
  [{
    trip: 1,
    times: [null, 482],
    arrival_times: [28830, 28950],
    departure_times: [null, 28970],
    stop_sequences: [1, 2],
    original_trip_id: 'TRIP-1',
    service_id: 'SERVICE-1'
  }],
  {
    R1: {
      D1: {
        code: 1,
        direction_id: '0'
      }
    }
  }
);

const row = schedules.R1.D1.weekday[0];

assert.equal(
  row.start_time,
  '08:00:30',
  'trip start time must come from the first populated stop index, not a later departure'
);

assert.deepEqual(
  row.arrival_times,
  ['08:00:30', '08:02:30'],
  'exact GTFS arrival seconds must be preserved'
);

assert.deepEqual(
  row.departure_times,
  [null, '08:02:50'],
  'exact GTFS departure seconds must be preserved'
);

console.log('transport-data-runtime: all tests passed');
