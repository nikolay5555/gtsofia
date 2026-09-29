const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.cwd();
const source = fs.readFileSync('transport-data.js', 'utf8');

async function fakeFetch(url) {
  const relative = url.replace(/^\.\//, '');
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const context = { console, Intl, Date, fetch: fakeFetch, window: null, Set, Object, Promise, Error, String };
context.window = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'transport-data.js' });

(async () => {
  const data = await context.loadTransportData();
  const expectedRoutes = JSON.parse(
    fs.readFileSync(path.join(root, 'data/routes.json'), 'utf8')
  );
  const expectedStops = JSON.parse(
    fs.readFileSync(path.join(root, 'data/stops.json'), 'utf8')
  );
  const expectedTrips = JSON.parse(
    fs.readFileSync(path.join(root, 'data/trips.json'), 'utf8')
  );
  const expectedDirections = JSON.parse(
    fs.readFileSync(path.join(root, 'data/directions.json'), 'utf8')
  );

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'data/manifest.json'), 'utf8')
  );
  const expectedShapes = Object.assign(
    {},
    ...manifest.shapes.map(file =>
      JSON.parse(fs.readFileSync(path.join(root, 'data', file), 'utf8'))
    )
  );
  const expectedSchedules = Object.assign(
    {},
    ...manifest.schedules.map(file =>
      JSON.parse(fs.readFileSync(path.join(root, 'data', file), 'utf8'))
    )
  );

  // The GTFS feed changes over time, so these assertions intentionally compare
  // the loader result with the current generated files instead of hardcoding a
  // snapshot's trip/direction counts.
  assert.equal(data.routes.length, expectedRoutes.length);
  assert.equal(data.stops.length, expectedStops.length);
  assert.equal(data.trips.length, expectedTrips.length);
  assert.equal(JSON.stringify(data.directions), JSON.stringify(expectedDirections));
  assert.equal(JSON.stringify(data.shapes), JSON.stringify(expectedShapes));
  assert.equal(JSON.stringify(data.schedules), JSON.stringify(expectedSchedules));
  assert.equal(data.stops.filter(s => s.stop_id === '0024').length, 1);
  assert.equal(data.stops.find(s => s.stop_id === '0024').stop_name, '28-МИ ДКЦ');
  assert.equal(data.directions.A91.D1.stops.find(s => s.stop_id === '0024').name, '28-МИ ДКЦ');
  assert.equal(Object.prototype.hasOwnProperty.call(data.calendar, 'exceptions'), false);
  console.log('split loader: all tests passed');
})().catch(error => { console.error(error); process.exit(1); });
