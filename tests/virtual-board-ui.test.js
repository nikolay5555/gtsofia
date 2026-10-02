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
