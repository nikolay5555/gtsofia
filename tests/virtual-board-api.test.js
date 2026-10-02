const assert = require('node:assert/strict');
const handler = require('../api/virtual-board.js');
const fs = require('node:fs');

const map = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'data', 'realtime-trip-map.json'), 'utf8'));
const [rawTripId, mapping] = Object.entries(map)[0];
const targetStop = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'data', 'directions.json'), 'utf8'))
  .find(direction => String(direction.code) === String(mapping.direction_code)).stops[0];

assert.equal(handler.__test.canonicalStopCode('0328'), '0328');
assert.equal(handler.__test.canonicalStopCode('328'), '0328');
assert.equal(handler.__test.canonicalStopCode('m18'), 'M18');

const now = Math.floor(Date.now() / 1000);
const routes = handler.__test.buildBoard([
  {
    trip: { tripId: rawTripId, routeId: mapping.route_id, directionId: mapping.direction_code, scheduleRelationship: 0 },
    stopTimeUpdates: [{ stopId: targetStop, scheduleRelationship: 0, arrival: { time: now + 120 } }]
  },
  {
    trip: { tripId: 'CANCELED-TEST', routeId: mapping.route_id, directionId: mapping.direction_code, scheduleRelationship: 3 },
    stopTimeUpdates: [{ stopId: targetStop, scheduleRelationship: 0, arrival: { time: now + 60 } }]
  },
  {
    trip: { tripId: 'SKIPPED-TEST', routeId: mapping.route_id, directionId: mapping.direction_code, scheduleRelationship: 0 },
    stopTimeUpdates: [{ stopId: targetStop, scheduleRelationship: 1, arrival: { time: now + 30 } }]
  }
], targetStop, now, now);

assert.equal(routes.length, 1);
assert.equal(routes[0].times.length, 1);
assert.equal(routes[0].times[0].t, 2);
assert.equal(typeof routes[0].destination, 'string');
assert.equal(routes[0].route_ref, JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'data', 'routes.json'), 'utf8')).find(r => r.cgm_id === mapping.route_id).route_ref);

console.log('virtual-board-api: all tests passed');
