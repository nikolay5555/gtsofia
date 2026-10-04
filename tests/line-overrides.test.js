const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'transport-data.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const context = { console, Intl, Date, window: null };
context.window = context;
vm.runInNewContext(source, context, { filename: sourcePath });

context.transportData = {
  lineOverrides: [
    { cgm_id: 'TB34', route_ref: '20ТМ', type: 'bus' },
    { cgm_id: 'TB46', route_ref: '186', type: 'bus' },
    { cgm_id: 'TB37', type: 'bus' }
  ]
};

const trolley20 = { route_id: 'TB34', route_short_name: '20T', route_type: '11' };
assert.equal(context.getLineType(trolley20), 'bus');
assert.equal(context.getLineSubtype(trolley20), 'temporary');
assert.equal(context.getLineDisplayNumber(trolley20), '20ТМ');
assert.equal(context.getLineColor(trolley20, 'bus'), '#BE1E2D');
assert.equal(context.getTransportIcon('bus', '20ТМ', 'temporary'), 'Icons/Active icons/bus.svg');

const e186 = { route_id: 'TB46', route_short_name: 'E186', route_type: '11' };
assert.equal(context.getLineType(e186), 'bus');
assert.equal(context.getLineSubtype(e186), null);
assert.equal(context.getLineDisplayNumber(e186), '186');

const threeTm = { route_id: 'TB37', route_short_name: '3TM', route_type: '11' };
assert.equal(context.getLineType(threeTm), 'bus');
assert.equal(context.getLineSubtype(threeTm), 'temporary');
assert.equal(context.getLineDisplayNumber(threeTm), '3ТМ');

const regularTrolley = { route_id: 'TB32', route_short_name: '3', route_type: '11' };
assert.equal(context.getLineType(regularTrolley), 'trolley');
assert.equal(context.getLineSubtype(regularTrolley), null);
assert.equal(context.getLineDisplayNumber(regularTrolley), '3');
assert.equal(context.getTransportIcon('trolley', '3'), 'Icons/Active icons/trolley.svg');

for (const [sourceNumber, expected] of [['M1', '1'], ['M2', '2'], ['M3', '3'], ['M4', '4']]) {
  const metro = { route_id: sourceNumber, route_short_name: sourceNumber, route_type: '1' };
  assert.equal(context.getLineType(metro), 'metro');
  assert.equal(context.getLineDisplayNumber(metro), expected);
  assert.equal(context.getLineSubtype(metro), null);
}

const school = { route_id: 'A242', route_short_name: 'Y1', route_type: '3' };
assert.equal(context.getLineDisplayNumber(school), 'У1');
assert.equal(context.getLineType(school), 'bus');
assert.equal(context.getLineSubtype(school), 'school');

const night = { route_id: 'A224', route_short_name: 'N1', route_type: '3' };
assert.equal(context.getLineType(night), 'bus');
assert.equal(context.getLineSubtype(night), 'night');
assert.equal(context.getTransportIcon('bus', 'N1', 'night'), 'Icons/Active icons/night-bus.svg');

console.log('line-overrides: all tests passed');
