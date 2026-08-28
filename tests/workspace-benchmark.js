const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { ProjectLinter } = require('zemdomu');

const FILE_COUNT = Number.parseInt(process.env.ZEMDOMU_BENCHMARK_FILES ?? '1000', 10);
const RUN_COUNT = Number.parseInt(process.env.ZEMDOMU_BENCHMARK_RUNS ?? '5', 10);
const MAX_WORKSPACE_SCAN_MS = 10000;
const MAX_RSS_MIB = 250;

const fixtures = {
  html: index => `<!doctype html><html lang="en"><head><title>Page ${index}</title></head><body><main><h1>Page ${index}</h1><img src="portrait-${index}.png" alt="Portrait ${index}"></main></body></html>`,
  jsx: index => `export default function Page${index}(){return <main><h1>Page ${index}</h1><img src="portrait-${index}.png" alt="Portrait ${index}" /></main>;}`,
  tsx: index => `export default function Page${index}(){return <main><h1>Page ${index}</h1><img src="portrait-${index}.png" alt="Portrait ${index}" /></main>;}`,
  vue: index => `<template><main><h1>Page ${index}</h1><img src="portrait-${index}.png" alt="Portrait ${index}"></main></template>`,
};

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function assertSafeTemporaryFixture(target) {
  const resolvedTarget = path.resolve(target);
  const resolvedTemp = path.resolve(os.tmpdir());
  assert.ok(
    resolvedTarget.startsWith(`${resolvedTemp}${path.sep}`) &&
      path.basename(resolvedTarget).startsWith('zemdomu-workspace-benchmark-'),
    `Refusing to remove unexpected benchmark path: ${resolvedTarget}`
  );
}

(async () => {
  assert.ok(Number.isInteger(FILE_COUNT) && FILE_COUNT > 0, 'file count must be positive');
  assert.ok(Number.isInteger(RUN_COUNT) && RUN_COUNT > 0, 'run count must be positive');

  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'zemdomu-workspace-benchmark-')
  );
  const extensions = Object.keys(fixtures);
  const filePaths = [];
  let peakRssBytes = process.memoryUsage().rss;
  const durationsMs = [];
  const findingCounts = [];

  try {
    for (let index = 0; index < FILE_COUNT; index += 1) {
      const extension = extensions[index % extensions.length];
      const filePath = path.join(fixtureRoot, `Page${index}.${extension}`);
      fs.writeFileSync(filePath, fixtures[extension](index), 'utf8');
      filePaths.push(filePath);
    }

    for (let run = 0; run < RUN_COUNT; run += 1) {
      const linter = new ProjectLinter({
        rootDir: fixtureRoot,
        crossComponentAnalysis: true,
        crossComponentDepth: 50,
      });
      const sampler = setInterval(() => {
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      }, 5);
      const startedAt = performance.now();
      const results = await linter.lintFiles(filePaths);
      const durationMs = performance.now() - startedAt;
      clearInterval(sampler);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      durationsMs.push(durationMs);
      findingCounts.push(
        Array.from(results.values()).reduce((total, findings) => total + findings.length, 0)
      );
    }

    const summary = {
      measuredAt: new Date().toISOString(),
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: os.cpus().length,
      totalMemoryMiB: Number((os.totalmem() / 1024 / 1024).toFixed(0)),
      node: process.version,
      extensionVersion: require('../package.json').version,
      fixture: {
        fileCount: FILE_COUNT,
        formats: extensions,
        shape: 'standalone valid pages/components with headings, landmarks, and named images',
      },
      runCount: RUN_COUNT,
      durationsMs: durationsMs.map(value => Number(value.toFixed(2))),
      p95Ms: Number(percentile(durationsMs, 0.95).toFixed(2)),
      peakRssMiB: Number((peakRssBytes / 1024 / 1024).toFixed(2)),
      findingCounts,
      thresholds: {
        workspaceScanP95Ms: MAX_WORKSPACE_SCAN_MS,
        peakRssMiB: MAX_RSS_MIB,
      },
    };

    console.log(JSON.stringify(summary, null, 2));
    assert.ok(
      summary.p95Ms < MAX_WORKSPACE_SCAN_MS,
      `workspace scan p95 ${summary.p95Ms}ms must stay below ${MAX_WORKSPACE_SCAN_MS}ms`
    );
    assert.ok(
      summary.peakRssMiB < MAX_RSS_MIB,
      `peak RSS ${summary.peakRssMiB} MiB must stay below ${MAX_RSS_MIB} MiB`
    );
  } catch (error) {
    console.error('Workspace benchmark failed');
    console.error(error);
    process.exitCode = 1;
  } finally {
    assertSafeTemporaryFixture(fixtureRoot);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
})();
