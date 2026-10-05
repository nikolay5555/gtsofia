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
    { cgm_id: 'TB37', type: 'bus' },
    { cgm_id: 'A259', route_ref: 'X43', type: 'bus' }
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
  'trolley'
);
assert.equal(
  context.getLineDisplayNumber(regularTrolley, 'trolley'),
  '3'
);

const x43 = {
  route_id: 'A259',
  route_short_name: 'X43',
  route_type: '3',
  route_color: '006838'
};
assert.equal(context.getLineType(x43), 'bus');
assert.equal(context.getLineSubtype(x43, 'bus', 'X43'), '');
assert.equal(context.getLineDisplayNumber(x43, 'bus'), 'X43');
assert.equal(context.getLineColor(x43, 'bus'), '#BE1E2D');
assert.equal(context.getTransportIcon('bus', 'X43'), 'Icons/Active icons/bus.svg');

const metro = {
  route_id: 'M1',
  route_short_name: 'M1',
  route_type: '1'
};
assert.equal(context.getLineType(metro), 'metro');
assert.equal(context.getLineDisplayNumber(metro, 'metro'), '1');

const temporary = {
  route_id: 'TMP1',
  route_short_name: '10ТМ',
  route_type: '3'
};
assert.equal(context.getLineType(temporary), 'bus');
assert.equal(context.getLineSubtype(temporary, 'bus', '10ТМ'), 'temporary');

const night = {
  route_id: 'A224',
  route_short_name: 'N1',
  route_type: '3'
};
assert.equal(context.getLineType(night), 'bus');
assert.equal(context.getLineSubtype(night, 'bus', 'N1'), 'night');
assert.equal(context.getTransportIcon('bus', 'N1', 'night'), 'Icons/Active icons/night-bus.svg');

const school = {
  route_id: 'S1',
  route_short_name: 'У1',
  route_type: '3'
};
assert.equal(context.getLineType(school), 'bus');
assert.equal(context.getLineSubtype(school, 'bus', 'У1'), 'school');

console.log('line-overrides: all tests passed');
