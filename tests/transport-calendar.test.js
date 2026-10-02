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
  calendar: {
    dateTypes: {
      '2026-10-02': 'weekday',
      '2026-10-03': 'weekend'
    },
    config: { dateOverrides: { '2026-10-05': 'weekend' } }
  }
};

assert.equal(context.getTransportCalendarDayType(new Date('2026-10-02T12:00:00Z')), 'weekday');
assert.equal(context.getTransportCalendarDayType(new Date('2026-10-03T12:00:00Z')), 'weekend');
assert.equal(context.getTransportCalendarDayType(new Date('2026-10-05T12:00:00Z')), 'weekend');

assert.equal(context.getLineDisplayNumber({ route_ref: 'M1', type: 'metro' }), '1');
assert.equal(context.getLineDisplayNumber({ route_ref: 'M4', type: 'metro' }), '4');
assert.equal(context.getLineDisplayNumber({ route_ref: '204', type: 'bus' }), '204');

console.log('transport-calendar: all tests passed');
