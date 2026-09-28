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
  assert.equal(data.routes.length, 204);
  assert.equal(data.trips.length, 29700);
  assert.equal(Object.keys(data.directions).length, 142);
  assert.equal(Object.keys(data.shapes).length, 333);
  assert.equal(Object.keys(data.schedules).length, 142);
  assert.equal(data.stops.filter(s => s.stop_id === '0024').length, 1);
  assert.equal(data.stops.find(s => s.stop_id === '0024').stop_name, '28-МИ ДКЦ');
  assert.equal(data.directions.A91.D1.stops.find(s => s.stop_id === '0024').name, '28-МИ ДКЦ');
  assert.equal(Object.prototype.hasOwnProperty.call(data.calendar, 'exceptions'), false);
  console.log('split loader: all tests passed');
})().catch(error => { console.error(error); process.exit(1); });
