const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const sourcePath = path.join(root, 'transport-data.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const fetched = [];
const requestOptions = [];

const context = {
  console,
  Intl,
  Date,
  URL,
  fetch: async (url, options = {}) => {
    fetched.push(url);
    requestOptions.push(options);
    const filePath = path.resolve(root, url);
    if (!fs.existsSync(filePath)) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(fs.readFileSync(filePath, 'utf8'))
    };
  },
  window: null
};
context.window = context;
vm.runInNewContext(source, context, { filename: sourcePath });

(async () => {
  const data = await context.loadTransportData();

  assert.equal(data.schemaVersion, 2);
  assert.ok(data.updatedAt);
  assert.ok(Array.isArray(data.routes));
  assert.ok(Array.isArray(data.stops));
  assert.ok(Array.isArray(data.trips));
  assert.ok(data.directions && typeof data.directions === 'object');
  assert.ok(data.shapes && typeof data.shapes === 'object');
  assert.ok(data.schedules && typeof data.schedules === 'object');
  assert.ok(Array.isArray(data.lineOverrides));
  assert.ok(data.calendar.coverageStartDate);
  assert.ok(data.calendar.coverageEndDate);
  assert.ok(
    requestOptions.every(options => options.cache === 'no-cache'),
    'split data files must be revalidated so OSM stop/direction names stay in sync'
  );
  assert.deepEqual(
    [...fetched].sort(),
    [
      './config/line-overrides.json',
      './data/calendar.json',
      './data/directions.json',
      './data/metadata.json',
      './data/routes.json',
      './data/schedules.json',
      './data/shapes.json',
      './data/stops.json',
      './data/trips.json'
    ].sort()
  );
  assert.equal(
    fs.existsSync(path.join(root, 'data', 'transport.json')),
    false,
    'the monolithic transport file should not be required or shipped'
  );

  const requestCountAfterFirstLoad = fetched.length;
  const secondData = await context.loadTransportData();
  assert.equal(secondData, data, 'subsequent callers should share cached data');
  assert.equal(
    fetched.length,
    requestCountAfterFirstLoad,
    'subsequent callers should not refetch every split file'
  );

  console.log('transport-data-load: all tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
