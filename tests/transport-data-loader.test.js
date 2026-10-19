const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'transport-data.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const files = {
  'metadata.json': { updatedAt: '2026-10-19', source: 'GTFS + OSM', lineOverrides: [] },
  'calendar.json': { dateTypes: {}, serviceIdsByDate: {}, servicePatterns: [], exceptions: [] },
  'calendar-exceptions.json': { exceptionsByDate: { '20261020': { add: ['NEW'], remove: [] } } },
  'routes.json': [{ route_id: 'R1' }],
  'stops.json': [{ stop_id: '0010', stop_name: 'OSM stop' }],
  'trips.json': [{ trip_id: 'T1' }],
  'directions.json': { R1: { D1: { destination: 'OSM stop' } } },
  'schedules.json': { R1: { D1: { weekday: [] } } },
  'shapes.json': { SH1: [{ lat: 42.7, lon: 23.3 }] }
};
const requested = [];
const context = {
  console: { log() {} },
  window: null,
  fetch: async url => {
    const filename = String(url).split('/').pop();
    requested.push(filename);
    if (!Object.prototype.hasOwnProperty.call(files, filename)) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => files[filename] };
  }
};
context.window = context;
vm.runInNewContext(source, context, { filename: sourcePath });

(async () => {
  const data = await context.loadTransportData();
  assert.equal(data.updatedAt, '2026-10-19');
  assert.equal(data.routes[0].route_id, 'R1');
  assert.equal(data.stops[0].stop_name, 'OSM stop');
  assert.deepEqual(JSON.parse(JSON.stringify(data.calendar.exceptionsByDate['20261020'])), {
    add: ['NEW'], remove: []
  });
  assert.deepEqual(JSON.parse(JSON.stringify(data.shapes)), {});
  assert.equal(requested.includes('transport.json'), false);
  assert.equal(requested.includes('shapes.json'), false);
  assert.equal(requested.length, 8);
  const shapes = await context.loadTransportShapes();
  assert.equal(shapes.SH1[0].lat, 42.7);
  assert.equal(requested.includes('shapes.json'), true);
  console.log('transport-data-loader: all tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
