const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const context = {
  console,
  Intl,
  Date,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Set,
  Map,
  Math,
  JSON,
  Promise,
  Error,
  URL,
  URLSearchParams,
  window: {},
  fetch: async url => {
    const clean = String(url).replace(/^\.\//, '');
    const file = path.join(root, clean);
    if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'transport-data.js'), 'utf8'), context);

(async () => {
  const data = await context.window.loadTransportData();

  assert.equal(data.canonical.routes.length, 143);
  assert.equal(data.canonical.directions.length, 353);
  assert.equal(data.canonical.trips.length, 651);
  assert.equal(data.canonical.stop_times.length, 31033);
  assert.equal(data.routes.length, 143);
  assert.equal(data.stops.length, 2856);

  const route27 = data.routes.find(route => route.route_id === 'A104');
  assert.ok(route27);
  assert.equal(route27.route_short_name, '27');
  const directions27 = data.directions.A104;
  assert.ok(directions27 && directions27.D401 && directions27.D411);
  assert.equal(directions27.D401.stops.length, 31);
  assert.equal(directions27.D401.headsign, 'метростанция Княгиня Мария Луиза');

  const schedule27 = data.schedules.A104;
  assert.ok(schedule27);
  assert.ok(schedule27.D401 && Array.isArray(schedule27.D401.weekday));
  assert.ok(schedule27.D401.weekday.length > 0);
  assert.equal(schedule27.D401.weekday[0].times.length, 31);

  const overrideRoute = data.routes.find(route => route.route_id === 'TB34');
  assert.ok(overrideRoute);
  assert.equal(context.window.getLineType(overrideRoute), 'bus');
  assert.equal(context.window.getLineDisplayNumber(overrideRoute, context.window.getLineType(overrideRoute)), '20ТМ');

  const metro = data.routes.find(route => route.route_id === 'M1');
  assert.ok(metro);
  assert.equal(context.window.getLineDisplayNumber(metro, 'metro'), '1');

  console.log('legacy-view-model: all tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
