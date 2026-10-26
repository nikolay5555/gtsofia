const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'transport-data.js'), 'utf8');

const context = {
  console,
  Intl,
  Date,
  fetch: async (url) => {
    const filename = path.join(root, url.replace(/^\.\//, ''));
    if (!fs.existsSync(filename)) return { ok: false, status: 404 };
    const text = fs.readFileSync(filename, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  }
};
context.window = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'transport-data.js' });

(async () => {
  const data = await context.loadTransportData();
  for (const key of [
    'updatedAt', 'source', 'lineOverrides', 'calendar', 'routes', 'stops',
    'trips', 'directions', 'schedules'
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(data, key), `missing ${key}`);
  }
  assert.ok(data.routes.length > 0, 'routes must not be empty');
  assert.ok(data.stops.length > 0, 'stops must not be empty');
  assert.ok(Object.keys(data.schedules).length > 0, 'schedules must not be empty');
  assert.ok(data.trips.length > 0, 'trips must not be empty');
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'shapes'), false, 'unused shape geometry must not be downloaded');
  assert.equal(context.transportData, data);
  console.log('transport-data-loader: all tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
