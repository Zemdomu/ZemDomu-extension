const assert = require('assert');
const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const files = [
  'package.json',
  'README.md',
  'docs/USER_GUIDE.md',
  'src/extension.ts',
  'src/issue-tracker.ts',
  'src/performance-diagnostics.ts',
];
const mojibake = /ΓÇ|Ã.|â(?:€|™|œ|ž|Ÿ)|ðŸ|�/u;

for (const relativePath of files) {
  const content = fs.readFileSync(path.join(packageRoot, relativePath), 'utf8');
  assert.ok(!mojibake.test(content), `Found mojibake in ${relativePath}`);
}

console.log('User-facing text encoding test passed');
