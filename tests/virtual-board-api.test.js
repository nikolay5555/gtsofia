const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const handler = require('../api/virtual-board.js');
const originalFetch = global.fetch;

function makeEmptyFeed(timestamp = Math.floor(Date.now() / 1000)) {
  // FeedMessage { header: FeedHeader { timestamp } }
  const bytes = [];
  bytes.push(0x0a, 0x0a, 0x18);
  let value = BigInt(timestamp);
  while (value >= 0x80n) {
    bytes.push(Number(value & 0x7fn) | 0x80);
    value >>= 7n;
  }
  bytes.push(Number(value));
  bytes[1] = bytes.length - 2;
  return Uint8Array.from(bytes);
}

function makeResponse(status = 200, body = new ArrayBuffer(0)) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => body
  };
}

(async () => {
  const routes = JSON.parse(fs.readFileSync(path.join(root, 'data', 'routes.json'), 'utf8'));
  const metro = routes.find(route => String(route.route_ref) === 'M1');
  assert.ok(metro);

  const x43 = routes.find(route => String(route.route_ref).toUpperCase() === 'X43');
  assert.ok(x43);

  // Keep the public X43 presentation special case in the shared line metadata.
  global.window = { transportData: { lineOverrides: [] } };
  const transportDataSource = fs.readFileSync(path.join(root, 'transport-data.js'), 'utf8');
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
    window: global.window
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(transportDataSource, context);
  const legacyX43 = {
    route_id: x43.cgm_id,
    route_short_name: x43.route_ref,
    route_type: '3'
  };
  assert.equal(context.window.getTransportIcon('bus', 'X43'), 'Icons/Active icons/torist-bus.svg');
  assert.equal(context.window.getLineColor(legacyX43, 'bus'), '#006838');

  const sampleStop = JSON.parse(fs.readFileSync(path.join(root, 'data', 'stops.json'), 'utf8'))[0].code;
  const feed = makeEmptyFeed();
  global.fetch = async () => makeResponse(200, feed.buffer);

  const response = await new Promise((resolve, reject) => {
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ statusCode: this.statusCode, headers: this.headers, payload }); }
    };

    Promise.resolve(handler({ method: 'GET', query: { stop_code: sampleStop } }, res)).catch(reject);
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.status, 'empty');
  assert.equal(response.payload.stop_code, sampleStop);
  assert.ok(Array.isArray(response.payload.routes));
  assert.ok(Array.isArray(response.payload.active_trips));
  assert.ok(Array.isArray(response.payload.skipped_trips));
  assert.ok(Array.isArray(response.payload.realtime_route_ids));

  global.fetch = originalFetch;
  console.log('virtual-board-api: all tests passed');
})().catch(error => {
  global.fetch = originalFetch;
  console.error(error);
  process.exitCode = 1;
});
