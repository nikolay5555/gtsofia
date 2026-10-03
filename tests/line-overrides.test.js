const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'transport-data.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const context = {
  console,
  Intl,
  Date,
  window: null
};
context.window = context;
vm.runInNewContext(source, context, { filename: sourcePath });

const busOverride = {
  route_id: 'TB34',
  route_short_name: '20ТМ',
  route_type: '3',
  type: 'bus',
  subtype: 'temporary'
};

assert.equal(
  context.getLineType(busOverride),
  'bus'
);
assert.equal(
  context.getLineSubtype(busOverride),
  'temporary'
);
assert.equal(
  context.getLineDisplayNumber(busOverride, 'bus'),
  '20ТМ'
);
assert.equal(
  context.getLineColor(busOverride, 'bus'),
  '#BE1E2D'
);
assert.equal(
  context.getTransportIcon('bus', '20ТМ'),
  'Icons/Active icons/bus.svg'
);

const schoolBus = {
  route_id: 'Y12',
  route_short_name: 'У12',
  route_type: '3',
  type: 'bus',
  subtype: 'school'
};

assert.equal(
  context.getLineType(schoolBus),
  'bus'
);
assert.equal(
  context.getLineSubtype(schoolBus),
  'school'
);

const nightBus = {
  route_id: 'N1',
  route_short_name: 'N1',
  route_type: '3',
  type: 'bus',
  subtype: 'night'
};

assert.equal(
  context.getLineType(nightBus),
  'bus'
);
assert.equal(
  context.getLineSubtype(nightBus),
  'night'
);
assert.equal(
  context.getTransportIcon('bus', 'N1'),
  'Icons/Active icons/night-bus.svg'
);

const regularTrolley = {
  route_id: 'TB32',
  route_short_name: '3',
  route_type: '11',
  type: 'trolley'
};

assert.equal(
  context.getLineType(regularTrolley),
  'trolley'
);
assert.equal(
  context.getLineDisplayNumber(regularTrolley, 'trolley'),
  '3'
);
assert.equal(
  context.getTransportIcon('trolley', '3'),
  'Icons/Active icons/trolley.svg'
);

console.log('line-overrides: all tests passed');
