const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'transport-data.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const samples = {
  'metadata.json': { updatedAt: '2026-10-22', source: 'test', formatVersion: 2 },
  'line-overrides.json': [{ route_ref: '1', type: 'bus' }],
  'calendar.json': { serviceIdsByDate: { '2026-10-22': ['A'] }, exceptions: [] },
  'routes.json': [{ route_id: 'R1' }],
  'stops.json': [{ stop_id: '0001', stop_name: 'OSM stop' }],
  'trips.json': [{ trip_id: 'T1' }],
  'directions.json': { R1: { D1: { headsign: 'OSM stop' } } },
  'shapes.json': { SH1: [{ lat: 42.7, lon: 23.3 }] },
  'schedules.json': { R1: { D1: { weekday: [], weekend: [] } } }
};
const requested = [];
const context = {
  console: { log() {} },
  Intl,
  Date,
  Promise,
  Object,
  fetch: async url => {
    const filename = String(url).split('/').at(-1);
    requested.push(filename);
    return {
      ok: Object.hasOwn(samples, filename),
      status: Object.hasOwn(samples, filename) ? 200 : 404,
      json: async () => samples[filename]
    };
  },
  window: null
};
context.window = context;
vm.runInNewContext(source, context, { filename: sourcePath });

(async () => {
  const first = await context.loadTransportData();
  assert.equal(first.updatedAt, '2026-10-22');
  assert.equal(first.stops[0].stop_name, 'OSM stop');
  assert.equal(first.lineOverrides.length, 1);
  assert.equal(first.calendar.serviceIdsByDate['2026-10-22'][0], 'A');
  assert.equal(first.schedules.R1.D1.weekday.length, 0);
  assert.equal(requested.length, 9, 'all split files should be fetched once');

  const second = await context.loadTransportData();
  assert.equal(second, first, 'loader should reuse the assembled data');
  assert.equal(requested.length, 9, 'subsequent loads should not refetch files');
  console.log('transport-data-loader: all tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
