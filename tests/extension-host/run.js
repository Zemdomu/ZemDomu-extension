const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

const FILE_COUNT = 100;
const HOST_WARMUP_RUNS = 5;
const ACTIVATION_RUNS = 20;
const IS_GITHUB_HOSTED_RUNNER = process.env.GITHUB_ACTIONS === 'true';
const MAX_ACTIVATION_P95_MS = IS_GITHUB_HOSTED_RUNNER ? 1200 : 500;

const fixtures = {
  html: index => `<!doctype html><html lang="en"><head><title>Page ${index}</title></head><body><main><h1>Page ${index}</h1><img src="portrait-${index}.png" alt="Portrait ${index}"></main></body></html>`,
  jsx: index => `export default function Page${index}(){return <main><h1>Page ${index}</h1><img src="portrait-${index}.png" alt="Portrait ${index}" /></main>;}`,
  tsx: index => `export default function Page${index}(){return <main><h1>Page ${index}</h1><img src="portrait-${index}.png" alt="Portrait ${index}" /></main>;}`,
  vue: index => `<template><main><h1>Page ${index}</h1><img src="portrait-${index}.png" alt="Portrait ${index}"></main></template>`,
};

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function assertSafeTemporaryFixture(target) {
  const resolvedTarget = path.resolve(target);
  const resolvedTemp = path.resolve(os.tmpdir());
  assert.ok(
    resolvedTarget.startsWith(`${resolvedTemp}${path.sep}`) &&
      path.basename(resolvedTarget).startsWith('zemdomu-extension-performance-'),
    `Refusing to remove unexpected performance fixture: ${resolvedTarget}`
  );
}

function createWorkspace() {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'zemdomu-extension-performance-')
  );
  fs.mkdirSync(path.join(workspacePath, '.vscode'));
  fs.writeFileSync(
    path.join(workspacePath, '.vscode', 'settings.json'),
    JSON.stringify({ 'zemdomu.run': 'manual' }, null, 2)
  );
  fs.writeFileSync(
    path.join(workspacePath, 'index.html'),
    '<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Fixture</h1><img src="portrait.png"></main></body></html>'
  );

  const extensions = Object.keys(fixtures);
  for (let index = 1; index < FILE_COUNT; index += 1) {
    const extension = extensions[index % extensions.length];
    fs.writeFileSync(
      path.join(workspacePath, `Page${String(index).padStart(3, '0')}.${extension}`),
      fixtures[extension](index)
    );
  }
  return workspacePath;
}

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
  const version = process.env.VSCODE_TEST_VERSION || 'stable';
  const workspacePath = createWorkspace();
  const resultsPath = path.join(workspacePath, 'performance-results.jsonl');
  process.env.ZEMDOMU_PERF_RESULTS_PATH = resultsPath;

  try {
    for (let run = 0; run < HOST_WARMUP_RUNS + ACTIVATION_RUNS; run += 1) {
      process.env.ZEMDOMU_PERF_MODE = run === 0 ? 'full' : 'activation';
      process.env.ZEMDOMU_MEASURE_ACTIVATION = run >= HOST_WARMUP_RUNS ? '1' : '0';
      await runTests({
        version,
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [
          workspacePath,
          '--disable-extensions',
          '--disable-workspace-trust',
          '--skip-welcome',
          '--skip-release-notes',
        ],
      });
    }

    const records = fs.readFileSync(resultsPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line));
    const activationDurationsMs = records
      .filter(record => record.type === 'activation' && record.measured)
      .map(record => record.durationMs);
    assert.strictEqual(
      activationDurationsMs.length,
      ACTIVATION_RUNS,
      'Every fresh Extension Host must record cold activation'
    );
    const activationP95Ms = Number(
      percentile(activationDurationsMs, 0.95).toFixed(2)
    );
    console.log(
      `Cold activation samples: ${activationDurationsMs.join(', ')} ms; p95=${activationP95Ms} ms`
    );
    assert.ok(
      activationP95Ms < MAX_ACTIVATION_P95_MS,
      `cold activation p95 ${activationP95Ms}ms must stay below ${MAX_ACTIVATION_P95_MS}ms`
    );

    const interactive = records.find(record => record.type === 'interactive');
    assert.ok(interactive, 'The full host run must record interactive performance');
    console.log(JSON.stringify({
      measuredAt: new Date().toISOString(),
      activation: {
        hostWarmupRuns: HOST_WARMUP_RUNS,
        runCount: ACTIVATION_RUNS,
        durationsMs: activationDurationsMs,
        p95Ms: activationP95Ms,
        budgetMs: MAX_ACTIVATION_P95_MS,
      },
      ...interactive,
    }, null, 2));
  } finally {
    delete process.env.ZEMDOMU_PERF_MODE;
    delete process.env.ZEMDOMU_PERF_RESULTS_PATH;
    delete process.env.ZEMDOMU_MEASURE_ACTIVATION;
    assertSafeTemporaryFixture(workspacePath);
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('VS Code Extension Host tests failed');
  console.error(error);
  process.exitCode = 1;
});
