const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'virtual-boards.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(root, 'api', 'virtual-board.js'), 'utf8');

// Regression guard: the API's realtime rows use absolute Unix timestamps.
// The restored legacy presentation layer must consume those timestamps
// directly; converting a non-existent relative `t` field empties every
// surface-transit board.
assert.match(
  source,
  /times:\s*route\.times\s*\n\s*\.map\(time => \(\{\s*\n\s*timestamp:\s*Number\(time\?\.timestamp\)/s
);
assert.doesNotMatch(source, /const relative = Number\(time\?\.t\)/);
assert.match(apiSource, /times\.push\(\{\s*\n\s*timestamp,/s);

console.log('virtual-board-ui: realtime timestamp contract passed');

const vm = require('node:vm');
const context = {
  console,
  Intl,
  Date,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Set,
  Map,
  Math,
  JSON,
  Promise,
  Error,
  AbortController,
  TextDecoder,
  window: {},
  document: {
    addEventListener() {},
    getElementById() { return null; }
  },
  sessionStorage: { getItem() { return null; }, setItem() {} },
  localStorage: { getItem() { return null; }, setItem() {} },
  URLSearchParams
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);
const seam = context.__gtsofiaVirtualBoardTestInternals;
assert.ok(seam);
assert.equal(seam.normalizeDirectionReference('54'), 'D54');
assert.equal(seam.normalizeDirectionReference('D54'), 'D54');
assert.equal(seam.normalizeDirectionReference(''), '');

console.log('virtual-board-ui: direction reference compatibility passed');

const routes = JSON.parse(fs.readFileSync(path.join(root, 'data', 'routes.json'), 'utf8'));
const stops = JSON.parse(fs.readFileSync(path.join(root, 'data', 'stops.json'), 'utf8'));
const directions = JSON.parse(fs.readFileSync(path.join(root, 'data', 'directions.json'), 'utf8'));
const trips = JSON.parse(fs.readFileSync(path.join(root, 'data', 'trips.json'), 'utf8'));
const realtimeTripMap = JSON.parse(fs.readFileSync(path.join(root, 'data', 'realtime-trip-map.json'), 'utf8'));

const route404 = routes.find(route => String(route.cgm_id) === 'A100');
assert.ok(route404);
const routeStops404 = directions.find(direction => String(direction.code) === '54')?.stops || [];
assert.ok(routeStops404.includes('1311'));

const legacyStops = stops.map(stop => ({
  stop_id: String(stop.code),
  stop_code: String(stop.code),
  stop_name: stop.names?.bg || '',
  stop_lat: String(stop.coords?.[0] ?? ''),
  stop_lon: String(stop.coords?.[1] ?? '')
}));
const directionMap = {};
for (const dir of directions) {
  const code = String(dir.code);
  if (!['54', '228'].includes(code)) continue;
  const pattern = (dir.stops || []).map(String);
  directionMap[`D${code}`] = {
    key: `D${code}`,
    code,
    direction_id: '',
    headsign: code === '54' || code === '228' ? 'Централна гара' : '',
    destination: code === '54' || code === '228' ? 'Централна гара' : '',
    pattern,
    stops: pattern.map(codeValue => legacyStops.find(stop => stop.stop_id === codeValue)).filter(Boolean),
    trip_ids: []
  };
}
const testTripData = {
  routes: [{ route_id: 'A100', route_short_name: '404', route_type: '3' }],
  stops: legacyStops,
  directions: { A100: directionMap },
  trips: [],
  realtimeTripMap
};
seam.setTestTransportData(testTripData);
const resolved404 = seam.resolveDirectionForRealtimeRoute('A100', '1311', null, '', '54');
assert.ok(resolved404);
assert.equal(resolved404.key, 'D54');
assert.equal(resolved404.destination, 'Централна гара');

console.log('virtual-board-ui: 404 destination direction fallback passed');
