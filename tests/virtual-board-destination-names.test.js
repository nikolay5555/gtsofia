const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'virtual-boards.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const exportedSource = source.replace(
  /\n\}\)\(\);\s*$/,
  `\n  globalThis.__testInternals = {\n    getDirectionDestinationName,\n    getDisplayStopName,\n    resolveDirectionForRealtimeRoute,\n    setTestState({ transportData: nextTransportData, trips = [] } = {}) {\n      transportData = nextTransportData || null;\n      tripById = new Map(trips.map(trip => [String(trip.trip_id), trip]));\n    }\n  };\n})();`
);
const context = {
  console,
  Math,
  Intl,
  URLSearchParams,
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  document: { addEventListener() {} },
  window: {},
  globalThis: {},
  Date
};
context.globalThis = context;
vm.runInNewContext(exportedSource, context, { filename: sourcePath });
const internals = context.__testInternals;

internals.setTestState({
  transportData: {
    stops: [
      { stop_id: '0001', stop_name: 'Избрана спирка' },
      { stop_id: '0099', stop_name: 'OSM крайна спирка' },
      { stop_id: '0100', stop_name: 'Друг край' }
    ],
    directions: {
      R1: {
        D1: { key: 'D1', pattern: ['0001', '0099'], destination: 'GTFS destination', headsign: 'GTFS destination' },
        D2: { key: 'D2', pattern: ['0001', '0100'], destination: 'Друг GTFS destination', headsign: 'Друг GTFS destination' }
      }
    }
  },
  trips: []
});

assert.equal(
  internals.getDirectionDestinationName({ destination: 'GTFS destination', headsign: 'GTFS destination', pattern: ['0001', '0099'] }),
  'OSM крайна спирка',
  'displayed destination should come from the OSM-first terminal stop record'
);
assert.equal(
  internals.getDisplayStopName({ stop_id: '0099', stop_name: 'stale GTFS name' }),
  'OSM крайна спирка',
  'virtual board stop labels should resolve from the canonical OSM-first stop record'
);
assert.equal(
  internals.resolveDirectionForRealtimeRoute('R1', '0001', null, 'GTFS string not matching the OSM name', '', '0099')?.key,
  'D1',
  'realtime direction should resolve by terminal stop ID before headsign text'
);

console.log('virtual-board-destination-names: all tests passed');
