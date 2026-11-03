const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'virtual-boards.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const context = {
  console,
  Math,
  Intl,
  URLSearchParams,
  localStorage: { getItem: () => '[]', setItem() {} },
  sessionStorage: { getItem: () => '[]', setItem() {} },
  document: { addEventListener() {} },
  window: {},
  Date
};
context.globalThis = context;

vm.runInNewContext(source, context, { filename: sourcePath });
const {
  formatArrivalCountdown,
  getRealtimeDelaySeconds,
  formatRealtimeDelay,
  realtimeDelayBadgeHtml
} = context.__gtsofiaVirtualBoardTestInternals;

const now = 1_000;
const cases = [
  [60, '1 мин.', 'exactly 60 seconds remaining'],
  [60.001, '1 мин.', 'a little over one minute remaining'],
  [59.999, '1 мин.', 'just under one minute remaining'],
  [59.9, '1 мин.', '59.9 seconds remaining'],
  [29.9, '0 мин.', 'less than 30 seconds remaining'],
  [30, '1 мин.', 'exactly 30 seconds remaining'],
  [0, '0 мин.', 'at the arrival timestamp'],
  [119, '2 мин.', '1 minute 59 seconds remaining'],
  [120, '2 мин.', 'exactly two minutes remaining'],
  [89.9, '1 мин.', '1 minute 29.9 seconds remaining'],
  [90, '2 мин.', '1 minute 30 seconds remaining'],
  [-30, '0 мин.', 'an arrival that has already passed'],
  [149.9, '2 мин.', '2 minutes 29.9 seconds remaining'],
  [150, '3 мин.', '2 minutes 30 seconds remaining'],
  [179, '3 мин.', '2 minutes 59 seconds remaining'],
  [541, '9 мин.', '9 minutes 1 second remaining'],
  [569, '9 мин.', '9 minutes 29 seconds remaining'],
  [570, '10 мин.', '9 minutes 30 seconds remaining']
];

for (const [offset, expected, label] of cases) {
  assert.equal(
    formatArrivalCountdown(now + offset, now),
    expected,
    `${label} should round to ${expected}`
  );
}

assert.equal(formatArrivalCountdown('not-a-timestamp', now), '', 'invalid timestamps should render as an empty label');

const delayCases = [
  [15 * 60, '+15 мин.', 'positive delay should use a red-badge label'],
  [-4 * 60, '-4 мин.', 'negative delay should use a yellow-badge label'],
  [30, '+1 мин.', '30 seconds late should round to one minute'],
  [-30, '-1 мин.', '30 seconds early should round to one minute'],
  [29, '±0 мин.', 'a positive delay that rounds to zero should show ±0'],
  [-29, '±0 мин.', 'a negative delay that rounds to zero should show ±0'],
  [0, '±0 мин.', 'an on-time realtime arrival should show ±0'],
  [null, '', 'a missing delay should not show a badge']
];

for (const [delaySeconds, expected, label] of delayCases) {
  assert.equal(
    formatRealtimeDelay(delaySeconds),
    expected,
    label
  );
}

assert.equal(
  getRealtimeDelaySeconds({ delay: null, timestamp: 1_120, scheduled_time: 1_000 }),
  120,
  'delay should be derived from predicted and scheduled timestamps when delay is absent'
);
assert.equal(
  getRealtimeDelaySeconds({ delay: null, timestamp: 1_120, scheduled_time: 0 }),
  null,
  'a zero scheduled_time must not be treated as a Unix timestamp'
);
assert.equal(
  getRealtimeDelaySeconds({ delay: -180, timestamp: 1_120, scheduled_time: 1_000 }),
  -180,
  'an explicit realtime delay should take precedence over timestamp difference'
);


const onTimeBadge = realtimeDelayBadgeHtml({ delay: 0 });
assert.match(onTimeBadge, /vb-arrival-delay-on-time/, 'zero-minute delay should use the green style');
assert.match(onTimeBadge, /±0 мин\./, 'zero-minute delay should display ±0');
assert.match(
  realtimeDelayBadgeHtml({ delay: 60 }),
  /\+1 мин\./,
  'positive delay badge should include the minutes unit'
);
assert.match(
  realtimeDelayBadgeHtml({ delay: 60 }),
  /vb-arrival-delay-late/,
  'positive delay should keep the red style'
);
assert.match(
  realtimeDelayBadgeHtml({ delay: -60 }),
  /vb-arrival-delay-early/,
  'negative delay should keep the yellow style'
);

console.log('virtual-board-arrivals: presentation tests passed');
