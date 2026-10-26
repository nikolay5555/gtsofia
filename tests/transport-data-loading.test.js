const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'transport-data.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const calls = [];

const payloads = {
  './data/manifest.json': {
    schemaVersion: 3,
    updatedAt: '2026-10-26',
    source: 'test feed',
    dataFiles: {
      routes: 'routes.json',
      stops: 'stops.json',
      trips: 'trips.json',
      directions: 'directions.json',
      lineOverrides: 'line-overrides.json'
    },
    calendarFile: 'calendar.json',
    shapesFile: 'shapes.json',
    schedulesDirectory: 'schedules',
    scheduleFiles: {
      R1: 'schedules/R1.json',
      R2: 'schedules/R2.json'
    }
  },
  './data/routes.json?v=2026-10-26': [{ route_id: 'R1' }, { route_id: 'R2' }],
  './data/stops.json?v=2026-10-26': [],
  './data/trips.json?v=2026-10-26': [],
  './data/directions.json?v=2026-10-26': {},
  './data/line-overrides.json?v=2026-10-26': [],
  './data/calendar.json?v=2026-10-26': {
    dateTypes: {}, serviceIdsByDate: {}, exceptions: []
  },
  './data/schedules/R1.json?v=2026-10-26': {
    D1: { weekday: [{ trip_id: 'T1' }], weekend: [] }
  },
  './data/schedules/R2.json?v=2026-10-26': {},
  './data/shapes.json?v=2026-10-26': { SHAPE1: [{ lat: 42, lon: 23 }] }
};

const context = {
  console,
  Intl,
  Date,
  Map,
  Promise,
  encodeURIComponent,
  fetch: async (url) => {
    calls.push(String(url));
    const payload = payloads[String(url)];
    if (payload === undefined) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => payload };
  },
  window: null
};
context.window = context;
vm.runInNewContext(source, context, { filename: sourcePath });

(async () => {
  const data = await context.loadTransportData();
  assert.equal(data.routes.length, 2);
  assert.deepEqual(Object.keys(data.schedules), [], 'schedules should not load with core data');
  assert.equal(calls.some(url => url.includes('/schedules/')), false);
  assert.equal(calls.some(url => url.includes('shapes.json')), false);

  await context.loadTransportSchedules(['R1', 'R1']);
  assert.equal(data.schedules.R1.D1.weekday.length, 1);
  assert.equal(calls.filter(url => url.includes('/schedules/R1.json')).length, 1,
    'a route schedule should be fetched once and cached');

  await context.loadTransportSchedules(['R1', 'R2']);
  assert.deepEqual(Object.keys(data.schedules).sort(), ['R1', 'R2']);
  assert.equal(calls.filter(url => url.includes('/schedules/R1.json')).length, 1);
  assert.equal(calls.filter(url => url.includes('/schedules/R2.json')).length, 1);

  const shapes = await context.loadTransportShapes();
  assert.equal(shapes.SHAPE1.length, 1);
  assert.equal(calls.filter(url => url.includes('shapes.json')).length, 1);

  console.log('transport-data-loading: all tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
