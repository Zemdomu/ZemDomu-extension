const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

// Shared order for the normal production build and mapped measurement build.
const tests = [
  ["tests/run-modes.test.js"],
  ["tests/issue-tracker.test.js"],
  ["tests/performance-diagnostics.test.js"],
  ["tests/workspace-lifecycle.test.js"],
  ["tests/race-stress.test.js"],
  ["tests/inline-disable.test.js"],
  ["tests/inline-control-boundaries.test.js"],
  ["tests/multi-root.test.js"],
  ["tests/linter-labels.test.js"],
  ["tests/all-rules.test.js"],
  ["tests/rule-surface.test.js"],
  ["tests/canonical-diagnostics.test.js"],
  ["tests/fuzz-properties.test.js"],
  ["tests/unique-ids.test.js"],
  ["tests/cross-component-extension.test.js"],
  ["tests/extension-cross-component.test.js"],
  ["tests/vue-extension.test.js"],
  ["tests/quick-fixes.test.js"],
  ["tests/full-document-quick-fixes.test.js"],
  ["tests/fixture-behavior.test.js"],
  ["tests/user-facing-text.test.js"],
  ["tests/marketplace-listing.test.js"],
  ["tests/smoke-test.test.js"],
  ["tests/npm-link.test.js"],
  ["tests/package-size.test.js","--bundle"],
  ["tests/extension-host-exit.test.js"],
];
const coverage = process.argv.slice(2);
assert.ok(coverage.length === 0 || (coverage.length === 1 && coverage[0] === '--coverage'), 'Expected only optional --coverage');
for (const test of tests) {
  if (coverage.length && test[0] === 'tests/package-size.test.js') continue;
  const result = spawnSync(process.execPath, test, {
    cwd: path.resolve(__dirname, '..'), stdio: 'inherit',
  });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0, `Functional test failed: ${test[0]}`);
}
