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

context.transportData = {
  lineOverrides: [
    { cgm_id: 'TB34', route_ref: '20ТМ', type: 'bus' },
    { cgm_id: 'TB46', route_ref: '186', type: 'bus' },
    { cgm_id: 'TB37', type: 'bus' }
  ]
};

const trolley20 = {
  route_id: 'TB34',
  route_short_name: '20T',
  route_type: '11'
};

assert.equal(
  context.getLineType(trolley20),
  'bus'
);
assert.equal(
  context.getLineDisplayNumber(trolley20, 'bus'),
  '20ТМ'
);
assert.equal(
  context.getLineColor(trolley20, 'bus'),
  '#BE1E2D'
);
assert.equal(
  context.getTransportIcon('bus', '20ТМ'),
  'Icons/Active icons/bus.svg'
);

const e186 = {
  route_id: 'TB46',
  route_short_name: 'E186',
  route_type: '11'
};

assert.equal(
  context.getLineType(e186),
  'bus'
);
assert.equal(
  context.getLineDisplayNumber(e186, 'bus'),
  '186'
);

const threeTm = {
  route_id: 'TB37',
  route_short_name: '3TM',
  route_type: '11'
};

assert.equal(
  context.getLineType(threeTm),
  'bus'
);
assert.equal(
  context.getLineDisplayNumber(threeTm, 'bus'),
  '3TM'
);

const regularTrolley = {
  route_id: 'TB32',
  route_short_name: '3',
  route_type: '11'
};

assert.equal(
  context.getLineType(regularTrolley),
  'trolleybus'
);
assert.equal(
  context.getLineDisplayNumber(regularTrolley, 'trolleybus'),
  '3'
);

console.log('line-overrides: all tests passed');
