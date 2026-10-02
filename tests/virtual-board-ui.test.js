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


// Direction resolution regression: when realtime does not provide a usable
// trip-id mapping or direction_id, the selected stop + stop_sequence must
// still identify the canonical direction. Exercise every generated surface
// route with a representative stop from every direction where the sequence is
// unique for that route.
const directionList = JSON.parse(fs.readFileSync(path.join(root, 'data', 'directions.json'), 'utf8'));
const stopsByCode = new Map(stops.map(stop => [String(stop.code), stop]));
const directionModel = {};
for (const direction of directionList) {
  const code = String(direction.code);
  const pattern = (direction.stops || []).map(String);
  const stopObjects = pattern.map(codeValue => {
    const stop = stopsByCode.get(codeValue);
    return stop ? {
      stop_id: String(stop.code),
      stop_code: String(stop.code),
      stop_name: stop.names?.bg || '',
      stop_lat: String(stop.coords?.[0] ?? ''),
      stop_lon: String(stop.coords?.[1] ?? '')
    } : null;
  }).filter(Boolean);

  for (const route of routes) {
    const routeId = String(route.cgm_id || '');
    if (!directionModel[routeId]) directionModel[routeId] = {};
    // A direction code is globally unique in the generated data, so map it
    // once and then attach it to the routes which reference it through trips.
    const routeUsesDirection = trips.some(trip =>
      String(trip.cgm_id) === routeId && String(trip.direction) === code
    );
    if (routeUsesDirection) {
      directionModel[routeId][`D${code}`] = {
        key: `D${code}`,
        code,
        headsign: stopObjects.at(-1)?.stop_name || '',
        destination: stopObjects.at(-1)?.stop_name || '',
        direction_id: '',
        pattern,
        stops: stopObjects,
        trip_ids: []
      };
    }
  }
}

seam.setTestTransportData({
  routes: routes.map(route => ({
    route_id: String(route.cgm_id),
    route_short_name: String(route.route_ref),
    route_type: route.type === 'metro' ? '1' : route.type === 'tram' ? '0' : route.type === 'trolley' ? '11' : '3'
  })),
  stops: legacyStops,
  directions: directionModel,
  trips: [],
  realtimeTripMap
});

let checkedDirections = 0;
for (const [routeId, set] of Object.entries(directionModel)) {
  const allDirections = Object.values(set);
  for (const direction of allDirections) {
    let representative = null;
    for (let index = 0; index < direction.pattern.length; index += 1) {
      const stopId = direction.pattern[index];
      const samePosition = allDirections.filter(other => String(other.pattern?.[index] || '') === stopId);
      if (samePosition.length === 1 && index < direction.pattern.length - 1) {
        representative = { stopId, stopSequence: index + 1 };
        break;
      }
    }
    if (!representative) continue;

    const resolved = seam.resolveDirectionForRealtimeRoute(
      routeId,
      representative.stopId,
      null,
      '',
      '',
      '',
      representative.stopSequence
    );
    assert.ok(resolved, `No direction resolved for ${routeId}/${direction.key}`);
    assert.equal(resolved.key, direction.key, `Wrong direction resolved for ${routeId}/${direction.key}`);
    assert.equal(resolved.destination, direction.destination);
    checkedDirections += 1;
  }
}

assert.ok(checkedDirections >= 300, `Only ${checkedDirections} directions exercised`);

// Explicitly keep the reported surface lines covered because all of them have
// multiple directions and therefore cannot safely fall back to the old
// "only direction at this stop" heuristic.
for (const routeRef of ['404', '94', '84', '78', '22', '27', '4']) {
  const routeIds = routes
    .filter(route => String(route.route_ref) === routeRef)
    .map(route => String(route.cgm_id));
  let covered = false;
  for (const routeId of routeIds) {
    for (const direction of Object.values(directionModel[routeId] || {})) {
      const representativeIndex = direction.pattern.findIndex((stopId, i) =>
        i < direction.pattern.length - 1
        && Object.values(directionModel[routeId] || {}).filter(other => String(other.pattern?.[i] || '') === String(stopId)).length === 1
      );
      if (representativeIndex < 0) continue;
      const resolved = seam.resolveDirectionForRealtimeRoute(
        routeId,
        direction.pattern[representativeIndex],
        null,
        '',
        '',
        '',
        representativeIndex + 1
      );
      assert.ok(resolved);
      assert.equal(resolved.key, direction.key);
      assert.ok(resolved.destination);
      covered = true;
      break;
    }
    if (covered) break;
  }
  assert.ok(covered, `No explicit direction fallback coverage for route ${routeRef}`);
}

console.log(`virtual-board-ui: stop_sequence direction fallback passed (${checkedDirections} directions + reported lines)`);
