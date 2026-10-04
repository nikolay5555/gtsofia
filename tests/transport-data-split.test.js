const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'transport-data.js'), 'utf8');
const context = {
  console,
  Promise,
  URL,
  setTimeout,
  clearTimeout,
  fetch: async (requestPath) => {
    const filePath = path.join(root, requestPath.replace(/^\//, ''));
    const body = fs.readFileSync(filePath, 'utf8');
    return { ok: true, json: async () => JSON.parse(body) };
  },
  window: {},
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(script, context, { filename: 'transport-data.js' });

(async () => {
  assert.strictEqual(fs.existsSync(path.join(root, 'data', 'transport.json')), false);

  const data = await context.loadTransportData();
  assert.ok(data);
  const byCgmId = (id) => data.routes.find((route) => route.cgm_id === id);
  const byRef = (ref) => data.routes.find((route) => route.route_ref === ref && route.type === 'metro');
  assert.ok(byCgmId('M1'));
  assert.strictEqual(byRef('1').route_ref, '1');
  assert.strictEqual(byCgmId('M1').type, 'metro');
  assert.strictEqual(byRef('2').route_ref, '2');
  assert.strictEqual(byRef('3').route_ref, '3');
  assert.strictEqual(byRef('4').route_ref, '4');
  assert.ok(byCgmId('A224'));
  assert.strictEqual(byCgmId('A224').type, 'bus');
  assert.strictEqual(byCgmId('A224').subtype, 'night');
  assert.ok(byCgmId('A242'));
  assert.strictEqual(byCgmId('A242').type, 'bus');
  assert.strictEqual(byCgmId('A242').subtype, 'school');
  assert.ok(byCgmId('A183'));
  assert.strictEqual(byCgmId('A183').subtype, 'temporary');

  assert.ok(Object.keys(data.stops).length > 0);
  assert.ok(Object.keys(data.directions).length > 0);
  assert.ok(Object.keys(data.trips).length > 0);
  assert.ok(Object.keys(data.sourceTrips).length > 0);
  assert.ok(Object.keys(data.schedules).length > 0);

  const firstRouteSchedules = Object.values(data.schedules)[0];
  const firstDirectionBuckets = Object.values(firstRouteSchedules)[0];
  const firstSchedule = firstDirectionBuckets.weekday[0] || firstDirectionBuckets.weekend[0];
  assert.ok(firstSchedule);
  assert.ok(Number.isInteger(firstSchedule.trip_id));
  assert.ok(Array.isArray(firstSchedule.times));
  assert.ok(firstSchedule.times.length > 0);
  assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(firstSchedule.start_time));
  assert.ok(firstSchedule.times.every((value) => value === null || /^\d{2}:\d{2}:\d{2}$/.test(value)));

  const metroRouteNumbers = data.routes
    .filter((route) => route.type === 'metro')
    .map((route) => route.route_ref);
  assert.deepStrictEqual(metroRouteNumbers.sort(), ['1', '2', '3', '4']);
  assert.ok(!metroRouteNumbers.some((number) => /^M/i.test(number)));

  console.log('transport-data-split: all tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
