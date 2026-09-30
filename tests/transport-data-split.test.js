const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const sourcePath = path.join(root, 'transport-data.js');
const source = require('node:fs').readFileSync(sourcePath, 'utf8');

async function makeResponse(url) {
  const relative = String(url).replace(/^\.\//, '');
  const filePath = path.join(root, relative);
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return {
      ok: true,
      status: 200,
      async json() {
        return JSON.parse(text);
      }
    };
  } catch (error) {
    return {
      ok: false,
      status: error?.code === 'ENOENT' ? 404 : 500,
      async json() {
        throw error;
      }
    };
  }
}

(async () => {
  const context = {
    console,
    Intl,
    Date,
    fetch: makeResponse,
    window: null
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: sourcePath });

  const data = await context.loadTransportData();

  assert(data.routes.length > 0);
  assert(data.stops.length > 0);
  assert(data.directionsFlat.length > 0);
  assert(data.trips.length > 0);
  assert(data.stopTimes.length > 0);
  assert(Object.keys(data.tripAliases || {}).length > 0);
  assert.equal(data.lineOverrides.length, 9);
  assert.equal(Object.prototype.toString.call(data.stopTimesByTrip), '[object Map]');
  assert.equal(
    data.stopTimesByTrip.size,
    new Set(data.stopTimes.map(row => String(row.trip))).size
  );
  const logicalTripIds = new Set(data.trips.map(trip => String(trip.id)));
  const firstAliasTarget = Object.values(data.tripAliases)[0];
  assert(logicalTripIds.has(String(firstAliasTarget)));

  const firstDirection = data.directionsFlat[0];
  const routeDirections = data.directions[firstDirection.cgm_id];
  assert(routeDirections);
  assert.equal(
    Object.values(routeDirections)[0].pattern.length,
    firstDirection.stops.length
  );

  console.log('transport-data-split: all tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
