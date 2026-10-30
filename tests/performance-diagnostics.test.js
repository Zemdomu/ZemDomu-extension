const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const Module = require('module');

process.env.NODE_PATH = path.join(__dirname, 'stubs');
Module._initPaths();
const vscode = require('vscode');
const { PerformanceDiagnostics } = require('../out/performance-diagnostics.js');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zemdomu-performance-contract-'));
  const originalMemoryUsage = process.memoryUsage;
  const originalStat = fs.stat;
  try {
    vscode.__resetAll();
    PerformanceDiagnostics.resetMetrics();
    process.memoryUsage = () => ({ rss: 64 * 1024 * 1024 });
    const perf = new PerformanceDiagnostics(false);
    const channel = vscode.window.__getOutputChannel('ZemDomu Perf');
    const first = path.join(root, 'First.jsx');
    const second = path.join(root, 'Second.vue');
    const timings = { parse: 1.25, total: 4.5 };
    perf.log('disabled log');
    perf.record(first, timings);
    timings.total = 999;
    assert.deepStrictEqual(channel.lines, [], 'Performance output must be opt-in');
    assert.deepStrictEqual(JSON.parse(perf.getAsJSON()), {
      [first]: { parse: 1.25, total: 4.5 },
    }, 'Stored metrics must be a snapshot, not a mutable reference to the caller');

    perf.updateDevMode(true);
    perf.log('Diagnostic timings enabled');
    perf.record(first, { parse: 2, total: 6.125 });
    assert.deepStrictEqual(channel.lines, [
      'Diagnostic timings enabled',
      'First.jsx => parse:2.00ms | total:6.13ms',
      'Memory usage: 64.0 MB',
    ]);
    perf.applyDiagnostics(vscode.Uri.file(second), []);
    assert.strictEqual(channel.lines.length, 3, 'A different file must not consume pending metrics');
    perf.applyDiagnostics(vscode.Uri.file(first), []);
    assert.strictEqual(channel.lines.at(-1), '[Perf] First.jsx => parse:2.00ms | total:6.13ms');
    perf.applyDiagnostics(vscode.Uri.file(first), []);
    assert.strictEqual(channel.lines.length, 4, 'A diagnostic update must emit its pending timing only once');
    perf.updateDevMode(false);
    perf.log('disabled again');
    perf.record(second, { total: 7 });
    perf.applyDiagnostics(vscode.Uri.file(second), []);
    assert.strictEqual(channel.lines.length, 4, 'Turning dev mode off must stop timing output');
    assert.strictEqual(JSON.parse(perf.getAsJSON())[second].total, 7, 'Metrics remain available with logging disabled');

    await fs.mkdir(path.join(root, 'dist'));
    await fs.mkdir(path.join(root, 'out'));
    const dist = path.join(root, 'dist', 'extension.js');
    await fs.writeFile(dist, Buffer.alloc(2048));
    await fs.writeFile(path.join(root, 'out', 'extension.js'), Buffer.alloc(4096));
    await perf.reportBundleSize(root);
    assert.strictEqual(channel.lines.length, 4, 'Bundle metadata also respects the opt-in setting');
    perf.updateDevMode(true);
    await perf.reportBundleSize(root);
    assert.strictEqual(channel.lines.at(-1), 'Bundle size (extension.js): 2.00 KB', 'Prefer the packaged bundle over compiled output');
    await fs.unlink(dist);
    await perf.reportBundleSize(root);
    assert.strictEqual(channel.lines.at(-1), 'Bundle size (extension.js): 4.00 KB', 'Compiled output is a fallback when no bundle exists');
    await fs.unlink(path.join(root, 'out', 'extension.js'));
    const beforeMissing = channel.lines.length;
    await perf.reportBundleSize(root);
    assert.strictEqual(channel.lines.length, beforeMissing, 'A source-only checkout has no size to report');

    await fs.writeFile(dist, Buffer.alloc(1024));
    let disappeared = false;
    fs.stat = async (...args) => {
      const result = await originalStat(...args);
      if (args[0] === dist && !disappeared) {
        disappeared = true;
        await fs.unlink(dist);
      }
      return result;
    };
    await perf.reportBundleSize(root);
    assert.strictEqual(channel.lines.length, beforeMissing, 'Removing build output between reads must not fail or report a stale size');
    fs.stat = originalStat;

    const entry = require.resolve('../out/performance-diagnostics.js');
    const cached = require.cache[entry];
    const load = Module._load;
    let Headless;
    try {
      delete require.cache[entry];
      Module._load = function (name, ...args) {
        if (name === 'vscode') throw new Error('VS Code is not available in this process');
        return load.call(this, name, ...args);
      };
      Headless = require(entry).PerformanceDiagnostics;
    } finally {
      Module._load = load;
      require.cache[entry] = cached;
    }
    const headless = new Headless(true);
    headless.log('headless log');
    headless.record(first, { total: 3 });
    headless.applyDiagnostics(vscode.Uri.file(first), []);
    await fs.writeFile(dist, Buffer.alloc(512));
    await headless.reportBundleSize(root);
    assert.deepStrictEqual(JSON.parse(headless.getAsJSON()), { [first]: { total: 3 } },
      'Headless consumers must still be able to inspect timings without loading VS Code');
    Headless.resetMetrics();
    assert.strictEqual(headless.getAsJSON(), '{}');
    PerformanceDiagnostics.resetMetrics();
    assert.strictEqual(PerformanceDiagnostics.getLatestMetrics().size, 0);
    console.log('Performance diagnostics opt-in, snapshot, bundle fallback and headless contracts passed');
  } finally {
    process.memoryUsage = originalMemoryUsage;
    fs.stat = originalStat;
    PerformanceDiagnostics.resetMetrics();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
