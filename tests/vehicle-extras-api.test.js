const assert = require('node:assert/strict');
const handler = require('../api/vehicle-extras');

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
}

(async () => {
  const previousFetch = global.fetch;
  let requestedUrl = '';

  try {
    global.fetch = async url => {
      requestedUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          status: 'ok',
          routes: [{ route_ref: '7', times: [{ t: 5, extras: ['1', '0', '1'] }] }]
        })
      };
    };

    const req = { method: 'GET', query: { stop_code: '0328' } };
    const res = createResponse();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.routes[0].route_ref, '7');
    assert.match(requestedUrl, /stop_code=0328$/);
    assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0');

    let metroUrl = '';
    global.fetch = async url => {
      metroUrl = String(url);
      return {
        ok: true,
        json: async () => ({ status: 'ok', routes: [] })
      };
    };
    const metroReq = { method: 'GET', query: { stop_code: 'M0St' } };
    const metroRes = createResponse();
    await handler(metroReq, metroRes);
    assert.equal(metroRes.statusCode, 200);
    assert.match(metroUrl, /stop_code=0&metro$/);

    const badReq = { method: 'POST', query: { stop_code: '0328' } };
    const badRes = createResponse();
    await handler(badReq, badRes);
    assert.equal(badRes.statusCode, 405);

    console.log('Vehicle extras API tests passed.');
  } finally {
    global.fetch = previousFetch;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
