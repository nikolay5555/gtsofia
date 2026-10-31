const assert = require('node:assert/strict');
const VehicleIcons = require('../vehicle-icons');

const nowMs = Date.parse('2026-10-31T12:00:00+02:00');

assert.deepEqual(
  VehicleIcons.getExtrasFlags(['1', '0', '1']),
  [true, false, true]
);
assert.deepEqual(
  VehicleIcons.getExtrasFlags('011'),
  [false, true, true]
);
assert.deepEqual(
  VehicleIcons.getExtrasFlags({ airConditioning: true, wheelchair: '1', bikeRack: 0 }),
  [true, true, false]
);

const rendered = VehicleIcons.renderHtml(['1', '1', '1']);
assert.match(rendered, /Icons\/snow\.svg/);
assert.match(rendered, /Icons\/chair\.svg/);
assert.match(rendered, /Icons\/wheel\.svg/);
assert.equal(VehicleIcons.renderHtml(['0', '0', '0']), '');

const targetRoutes = [{
  meta: { number: '7' },
  destination: 'Крайна спирка',
  times: [
    { timestamp: nowMs / 1000 + 5 * 60 },
    { timestamp: nowMs / 1000 + 12 * 60 }
  ]
}];
const proxyRoutes = [{
  route_ref: '7',
  destination: 'Крайна спирка',
  times: [
    { t: 5, extras: ['1', '0', '1'] },
    { t: 12, extras: ['0', '1', '0'] }
  ]
}];

const enriched = VehicleIcons.attachExtras(targetRoutes, proxyRoutes, nowMs);
assert.deepEqual(enriched[0].times[0].extras, ['1', '0', '1']);
assert.deepEqual(enriched[0].times[1].extras, ['0', '1', '0']);
assert.notEqual(enriched, targetRoutes);

const byDestinationId = VehicleIcons.attachExtras(
  [{ route_ref: '7', destination: 'Име на крайна спирка', terminal_stop_id: '1234', times: [{ timestamp: nowMs / 1000 + 5 * 60 }] }],
  [{ route_ref: '7', destination: '1234', times: [{ t: 5, extras: ['1', '0', '0'] }] }],
  nowMs
);
assert.deepEqual(byDestinationId[0].times[0].extras, ['1', '0', '0']);

const ambiguousProxyRoutes = [
  {
    route_ref: '7',
    destination: 'Посока А',
    times: [{ t: 5, extras: ['1', '0', '0'] }]
  },
  {
    route_ref: '7',
    destination: 'Посока Б',
    times: [{ t: 5, extras: ['0', '1', '0'] }]
  }
];
const ambiguous = VehicleIcons.attachExtras(
  [{ meta: { number: '7' }, destination: 'Неизвестна посока', times: [{ timestamp: nowMs / 1000 + 5 * 60 }] }],
  ambiguousProxyRoutes,
  nowMs
);
assert.equal(ambiguous[0].times[0].extras, undefined);

// A vehicle with no equipment flags must still count as a candidate.
// Otherwise an equipped vehicle in the opposite direction could be attached
// to the wrong arrival when both reach the stop at the same time.
const ambiguousWithUnequippedVehicle = VehicleIcons.attachExtras(
  [{ meta: { number: '7' }, destination: 'Непозната посока', times: [{ timestamp: nowMs / 1000 + 5 * 60 }] }],
  [
    { route_ref: '7', destination: 'Посока А', times: [{ t: 5, extras: ['1', '0', '0'] }] },
    { route_ref: '7', destination: 'Посока Б', times: [{ t: 5, extras: ['0', '0', '0'] }] }
  ],
  nowMs
);
assert.equal(ambiguousWithUnequippedVehicle[0].times[0].extras, undefined);

(async () => {
  let requestedUrl = '';
  const fetched = await VehicleIcons.enrichRoutes(
    [{ route_ref: '7', destination: 'Крайна спирка', times: [{ timestamp: nowMs / 1000 + 5 * 60 }] }],
    'TEST-ICON-STOP',
    {
      nowMs,
      fetchImpl: async (url, options) => {
        requestedUrl = url;
        assert.equal(options.method, 'GET');
        return {
          ok: true,
          json: async () => ({ status: 'ok', routes: proxyRoutes })
        };
      }
    }
  );
  assert.match(requestedUrl, /sft-proxy\.onrender\.com\/virtual-board\?stop_code=TEST-ICON-STOP/);
  assert.deepEqual(fetched[0].times[0].extras, ['1', '0', '1']);

  let metroUrl = '';
  await VehicleIcons.fetchProxyRoutes('M1234', async url => {
    metroUrl = url;
    return { ok: true, json: async () => ({ status: 'ok', routes: [] }) };
  });
  assert.match(metroUrl, /stop_code=1234&metro$/);

  console.log('Vehicle icon tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
