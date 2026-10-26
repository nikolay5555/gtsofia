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
    'trips', 'directions', 'shapes', 'schedules'
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(data, key), `missing ${key}`);
  }
  assert.equal(data.routes.length, 204);
  assert.equal(data.stops.length, 4799);
  assert.equal(Object.keys(data.schedules).length, 142);
  assert.equal(context.transportData, data);
  console.log('transport-data-loader: all tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
