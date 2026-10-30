const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { test } = require('node:test');

const suitePath = path.join(__dirname, 'suite', 'index.js');
const suiteRequire = createRequire(suitePath);
const suiteSource = fs.readFileSync(suitePath, 'utf8');

function budgets(version, hosted, platform) {
  const context = {
    require: name => name === 'vscode' ? { version } : suiteRequire(name),
    process: { env: { GITHUB_ACTIONS: hosted }, platform },
    module: { exports: {} },
  };
  vm.runInNewContext(`${suiteSource}\nmodule.exports = { MAX_RSS_MIB, MAX_RSS_GROWTH_PERCENT, MAX_TYPE_P95_MS, MAX_SAVE_P95_MS, TYPE_RUNS, SAVE_RUNS };`, context, { filename: suitePath });
  return context.module.exports;
}

for (const platform of ['linux', 'win32']) {
  test(`${platform}: approved hosted allowance uses the actual exact VS Code version`, () => {
    assert.strictEqual(budgets('1.144.0', 'true', platform).MAX_RSS_MIB, 300);
    for (const version of ['1.105.0', '1.143.0', '1.144.1', '1.145.0', 'stable', undefined]) {
      assert.strictEqual(budgets(version, 'true', platform).MAX_RSS_MIB, 275, `Unreviewed ${version} must retain its ceiling`);
    }
  });

  test(`${platform}: local reference and other release protections stay unchanged`, () => {
    for (const version of ['1.105.0', '1.144.0', '1.145.0']) {
      for (const hosted of [undefined, 'false', 'TRUE']) {
        assert.strictEqual(budgets(version, hosted, platform).MAX_RSS_MIB, 250);
      }
      for (const hosted of [undefined, 'true']) {
        const result = budgets(version, hosted, platform);
        assert.strictEqual(result.MAX_RSS_GROWTH_PERCENT, 20);
        assert.strictEqual(result.MAX_TYPE_P95_MS, hosted === 'true' && platform === 'win32' ? 750 : 500);
        assert.strictEqual(result.MAX_SAVE_P95_MS, 1000);
        assert.strictEqual(result.TYPE_RUNS, 20);
        assert.strictEqual(result.SAVE_RUNS, 100);
      }
    }
  });
}
