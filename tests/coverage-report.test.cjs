const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateCoverage } = require('../scripts/coverage-report.cjs');

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-coverage-guard-'));
try {
  for (const directory of ['src', 'out', 'dist']) {
    fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
  }
  fs.mkdirSync(path.join(fixture, 'coverage'));
  function report(name) {
    const original = JSON.parse(fs.readFileSync(path.join(root, 'coverage', name), 'utf8'));
    return Object.fromEntries(Object.entries(original).map(([key, value]) => {
      const target = key === 'total' ? key : path.join(fixture, path.relative(root, key));
      if (value.path) value.path = target;
      return [target, value];
    }));
  }
  const coverage = report('coverage-final.json');
  const summary = report('coverage-summary.json');
  function write(data = coverage, metrics = summary) {
    fs.writeFileSync(path.join(fixture, 'coverage', 'coverage-final.json'), JSON.stringify(data));
    fs.writeFileSync(path.join(fixture, 'coverage', 'coverage-summary.json'), JSON.stringify(metrics));
  }
  write();
  validateCoverage(fixture);

  const missing = path.join(fixture, 'out', 'linter.js.map');
  fs.renameSync(missing, `${missing}.saved`);
  assert.throws(() => validateCoverage(fixture), /ENOENT/, 'Missing source maps must fail');
  fs.renameSync(`${missing}.saved`, missing);

  const broken = path.join(fixture, 'dist', 'extension.js.map');
  const originalMap = fs.readFileSync(broken);
  fs.writeFileSync(broken, '{broken');
  assert.throws(() => validateCoverage(fixture), SyntaxError, 'Broken source maps must fail');
  fs.writeFileSync(broken, originalMap);

  const entrypoint = path.join(fixture, 'src', 'extension.ts');
  for (const category of ['functions', 'branches']) {
    const empty = structuredClone(coverage);
    if (category === 'functions') {
      empty[entrypoint].fnMap = {};
      empty[entrypoint].f = {};
    } else {
      empty[entrypoint].branchMap = {};
      empty[entrypoint].b = {};
    }
    write(empty);
    assert.throws(() => validateCoverage(fixture), /entrypoint must have/,
      `Zero-total entrypoint ${category} must fail`);

    const unexecuted = structuredClone(coverage);
    const counter = category === 'functions' ? 'f' : 'b';
    for (const key of Object.keys(unexecuted[entrypoint][counter])) {
      unexecuted[entrypoint][counter][key] = counter === 'b'
        ? unexecuted[entrypoint][counter][key].map(() => 0) : 0;
    }
    write(unexecuted);
    assert.throws(() => validateCoverage(fixture), /entrypoint must have/,
      `Unexecuted entrypoint ${category} must fail`);
  }

  const generated = structuredClone(coverage);
  generated[path.join(fixture, 'dist', 'extension.js')] = generated[entrypoint];
  write(generated);
  assert.throws(() => validateCoverage(fixture), /exactly the TypeScript source inventory/);

  const incomplete = structuredClone(coverage);
  delete incomplete[path.join(fixture, 'src', 'linter.ts')];
  write(incomplete);
  assert.throws(() => validateCoverage(fixture), /exactly the TypeScript source inventory/);

  const invalidSummary = structuredClone(summary);
  invalidSummary[entrypoint].lines.pct = null;
  write(coverage, invalidSummary);
  assert.throws(() => validateCoverage(fixture), /Non-finite lines coverage/);

  const inflatedSummary = structuredClone(summary);
  inflatedSummary[entrypoint].branches.pct = 100;
  write(coverage, inflatedSummary);
  assert.throws(() => validateCoverage(fixture), /Incorrect branches percentage/);

  const incorrectTotal = structuredClone(summary);
  incorrectTotal.total.functions.covered = 0;
  write(coverage, incorrectTotal);
  assert.throws(() => validateCoverage(fixture), /Incorrect functions covered count/);

  const fractionalCounter = structuredClone(coverage);
  fractionalCounter[entrypoint].f[Object.keys(fractionalCounter[entrypoint].f)[0]] = 0.5;
  write(fractionalCounter);
  assert.throws(() => validateCoverage(fixture), /Invalid f coverage counters/);

  const missingBranch = structuredClone(coverage);
  missingBranch[entrypoint].b[Object.keys(missingBranch[entrypoint].b)[0]] = [];
  write(missingBranch);
  assert.throws(() => validateCoverage(fixture), /must match branch locations/);

  write();
  validateCoverage(fixture);
  console.log('Mapped coverage guards reject missing/broken maps, empty/unexecuted counters, invalid rows and non-finite summaries');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
