const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'schedules.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const context = {
  console,
  document: { addEventListener() {} },
  window: {
    transportData: {
      stops: [
        { stop_id: '0001', stop_name: 'OSM начална спирка' },
        { stop_id: '0099', stop_name: 'OSM крайна спирка' }
      ]
    }
  }
};
vm.runInNewContext(source, context, { filename: sourcePath });

assert.equal(
  context.getDirectionDisplayName({
    headsign: 'GTFS destination',
    destination: 'old GTFS destination',
    pattern: ['0001', '0099'],
    stops: [{ stop_id: '0001', name: 'old start' }, { stop_id: '0099', name: 'old GTFS terminal' }]
  }),
  'OSM крайна спирка',
  'schedule destination display should resolve from the canonical terminal stop first'
);
assert.equal(
  context.getDirectionDisplayName({
    headsign: 'GTFS fallback',
    destination: 'OSM destination'
  }),
  'OSM destination',
  'direction.destination should be preferred over GTFS headsign when there is no terminal ID'
);
assert.equal(
  context.getDirectionDisplayName({ headsign: 'GTFS fallback' }),
  'GTFS fallback',
  'GTFS should be used only when no OSM/canonical destination exists'
);
assert.equal(
  context.getScheduleStopName({ stop_id: '0001', name: 'old GTFS label' }),
  'OSM начална спирка',
  'schedule stop labels should resolve from the canonical OSM-first stop list'
);
assert.equal(
  context.getScheduleStopName({ stop_id: '7777', name: 'GTFS-only stop' }),
  'GTFS-only stop',
  'a local GTFS label is the fallback when the canonical list has no stop'
);

console.log('schedule-name-priority: all tests passed');
