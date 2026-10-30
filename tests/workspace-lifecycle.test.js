const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

process.env.NODE_PATH = path.join(__dirname, 'stubs');
Module._initPaths();
const vscode = require('vscode');
const GLOB = '**/*.{html,jsx,tsx,vue}';
const BAD = 'export default function App(){return <img src="portrait.png" />}';
const codeOf = diagnostic => typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;

async function withWorkspace(mode, check, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-workspace-contract-'));
  const filename = path.join(root, 'App.jsx');
  fs.writeFileSync(filename, BAD);
  vscode.__resetAll();
  vscode.workspace.__setConfiguration('run', mode);
  for (const [key, value] of Object.entries(settings)) vscode.workspace.__setConfiguration(key, value);
  vscode.workspace.__setWorkspaceFolders([{ uri: vscode.Uri.file(root) }]);
  vscode.workspace.__setFindFiles(GLOB, [filename]);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
  const entry = require.resolve('../dist/extension.js');
  delete require.cache[entry];
  const extension = require(entry);
  const context = { extensionPath: path.resolve(__dirname, '..'), subscriptions: [] };
  extension.activate(context);
  const collection = vscode.languages.__getCollection('zemdomu');
  const log = vscode.window.__getOutputChannel('ZemDomu');
  const dispose = () => {
    for (const disposable of [...context.subscriptions].reverse()) disposable?.dispose?.();
  };
  try {
    await check({ root, filename, doc, collection, log, dispose });
  } finally {
    dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function verbose(log) {
  return log.lines.filter(line => line.startsWith('[verbose] ')).map(line => JSON.parse(line.slice(10)));
}

async function verifyEmptyDiagnosticReadContracts() {
  const promises = require('fs/promises');
  const { ProjectLinter } = require('zemdomu');
  const { canonicalDiagnosticToVscode } = require('../out/diagnostic-adapter.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-empty-read-contract-'));
  const badFile = path.join(root, 'index.html');
  const validHtml = '<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Fixture</h1><img src="portrait.png" alt="Portrait"></main></body></html>';
  const badHtml = validHtml.replace(' alt="Portrait"', '');
  const files = [badFile];
  fs.writeFileSync(badFile, badHtml);
  for (let index = 1; index < 100; index++) {
    const format = ['html', 'jsx', 'tsx', 'vue'][index % 4];
    const filename = path.join(root, `Page${index}.${format}`);
    const markup = `<main><h1>Page ${index}</h1><img src="portrait.png" alt="Portrait"/></main>`;
    const source = format === 'html' ? validHtml
      : format === 'vue' ? `<template>${markup}</template>`
      : `export default function Page${index}(){ return ${markup}; }`;
    fs.writeFileSync(filename, source);
    files.push(filename);
  }
  const rules = Object.fromEntries(Object.keys(require('../package.json').contributes.configuration.properties)
    .filter(name => name.startsWith('zemdomu.rules.')).map(name => [name.slice('zemdomu.rules.'.length), 'warning']));
  const expectedForFiles = async () => new ProjectLinter({
    rootDir: root, rules, crossComponentAnalysis: true, crossComponentDepth: 50,
  }).lintFileDiagnostics(files);
  const originalRead = promises.readFile;
  const context = { extensionPath: path.resolve(__dirname, '..'), subscriptions: [] };
  let reads = [];
  let readErrors = 0;
  let failingPaths = new Set();
  let errorCode = 'EACCES';
  const records = [];
  try {
    // Only intercept the Extension's additional filtering read. Actual Core
    // analysis reads the real fixtures and computes every diagnostic normally.
    promises.readFile = async function (filename, ...args) {
      if (new Error().stack.includes('sourceForFile')) {
        reads.push(filename);
        if (failingPaths.has(filename)) {
          readErrors += 1;
          const error = new Error('Filtering source is unavailable');
          error.code = errorCode;
          throw error;
        }
      }
      return originalRead.call(this, filename, ...args);
    };
    vscode.__resetAll();
    vscode.workspace.__setConfiguration('run', 'manual');
    vscode.workspace.__setWorkspaceFolders([{ uri: vscode.Uri.file(root) }]);
    vscode.workspace.__setFindFiles(GLOB, files);
    const entry = require.resolve('../out/extension.js');
    delete require.cache[entry];
    require(entry).activate(context);
    const collection = vscode.languages.__getCollection('zemdomu');
    const serialized = values => values.map(value => JSON.stringify(value)).sort();
    const assertDisplayed = expected => {
      for (const filename of files) {
        const values = expected.filter(item => item.source.file === filename)
          .map(item => canonicalDiagnosticToVscode(item,
            vscode.Uri.parse(`https://zemdomu.dev/docs/${encodeURIComponent(item.rule)}`)));
        assert.deepStrictEqual(serialized(collection.get(vscode.Uri.file(filename)) ?? []), serialized(values),
          'All displayed diagnostic fields must match actual Core output');
        assert.ok(collection.__entries().has(filename), 'Every empty file key must remain published');
      }
    };
    const scan = async label => {
      reads = []; readErrors = 0;
      assert.strictEqual(await vscode.commands.__execute('zemdomu.lintWorkspace'), 'Scan complete');
      assert.deepStrictEqual(vscode.window.__getErrorMessages(), [],
        'Filtering read errors are not scan-failure barriers');
      records.push({ label, reads: reads.length, readErrors });
    };

    // Empty filtering reads were historically best-effort, not an I/O barrier.
    failingPaths = new Set(files.slice(1));
    const initialExpected = await expectedForFiles();
    assert.strictEqual(initialExpected.length, 1);
    await scan('mixed-100-files');
    assertDisplayed(initialExpected);

    fs.writeFileSync(badFile, validHtml);
    failingPaths = new Set(files);
    await scan('all-empty-clears-stale');
    assertDisplayed([]);
    assert.deepStrictEqual(collection.get(vscode.Uri.file(badFile)), [],
      'An empty result must clear its previous diagnostic even when filtering source is unavailable');

    const directiveHtml = badHtml.replace('<img', '<!-- ZEMDOMU-DISABLE-NEXT requireAltText --><img');
    fs.writeFileSync(badFile, directiveHtml);
    const nonemptyExpected = await expectedForFiles();
    assert.strictEqual(nonemptyExpected.length, 1);
    failingPaths = new Set([badFile]);
    for (const failure of ['EACCES', 'ENOENT']) {
      errorCode = failure;
      await scan(`nonempty-read-${failure}`);
      assertDisplayed(nonemptyExpected);
      assert.strictEqual(readErrors, 1, 'Nonempty source-read failures must retain the existing fallback');
    }
    failingPaths.clear();
    await scan('nonempty-inline-control');
    assertDisplayed([]);
    console.log('[Empty diagnostic read checks]', JSON.stringify(records));
    assert.strictEqual(records[0].reads, 1, 'Only the one nonempty file needs a filtering source read');
    assert.strictEqual(records[1].reads, 0, 'Empty findings need no source reads or I/O barrier');
    assert.deepStrictEqual(records.slice(2).map(record => record.reads), [1, 1, 1],
      'All nonempty missing/read failures and normal inline filtering must still read source');
  } finally {
    promises.readFile = originalRead;
    for (const disposable of [...context.subscriptions].reverse()) disposable?.dispose?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  await withWorkspace('onSave', async ({ doc, filename, collection, log }) => {
    await vscode.workspace.__fireDidSaveTextDocument(doc);
    const first = collection.get(doc.uri);
    assert.strictEqual(first.length, 1);
    assert.strictEqual(codeOf(first[0]), 'ZMD004');
    await vscode.workspace.__fireDidSaveTextDocument(doc);
    assert.strictEqual(collection.get(doc.uri), first, 'Identical results must not republish or flicker diagnostics');
    const published = verbose(log).filter(event => event.event === 'diagnosticsPublished');
    assert.deepStrictEqual(published.map(event => event.updated), [true, false]);
    assert.ok(verbose(log).some(event => event.event === 'lintRunComplete' && event.ruleCounts.requireAltText === 1));

    const manyImages = 'export default function App(){return <>' + '<img />'.repeat(8) + '</>}';
    fs.writeFileSync(filename, manyImages);
    doc.__setText(manyImages);
    await vscode.workspace.__fireDidSaveTextDocument(doc);
    assert.strictEqual(collection.get(doc.uri).length, 8, 'Repeated findings must remain distinct');
    const preview = verbose(log).filter(event => event.event === 'diagnosticsPublished').at(-1).keysPreview;
    assert.strictEqual(preview.length, 7, 'Verbose output must bound large diagnostic previews');
    assert.strictEqual(preview[3], '...');

    vscode.workspace.__setConfiguration('severity.requireAltText', 'error');
    await vscode.workspace.__fireDidChangeConfiguration('zemdomu.severity.requireAltText');
    await vscode.workspace.__fireDidSaveTextDocument(doc);
    assert.strictEqual(collection.get(doc.uri)[0].severity, vscode.DiagnosticSeverity.Error);
    vscode.workspace.__setConfiguration('rules.requireAltText', false);
    await vscode.workspace.__fireDidChangeConfiguration('zemdomu.rules.requireAltText');
    await vscode.workspace.__fireDidSaveTextDocument(doc);
    assert.deepStrictEqual(collection.get(doc.uri), [], 'Disabled rules must remove their previous findings');
    vscode.workspace.__setConfiguration('rules.requireAltText', true);
    vscode.workspace.__setConfiguration('severity.requireAltText', 'warning');
    await vscode.workspace.__fireDidChangeConfiguration('zemdomu.rules.requireAltText');
    await vscode.workspace.__fireDidSaveTextDocument(doc);
    assert.strictEqual(collection.get(doc.uri)[0].severity, vscode.DiagnosticSeverity.Warning);

    vscode.workspace.__setConfiguration('enableVerboseLogging', false);
    await vscode.workspace.__fireDidChangeConfiguration('zemdomu.enableVerboseLogging');
    const before = verbose(log).length;
    await vscode.workspace.__fireDidSaveTextDocument(doc);
    assert.strictEqual(verbose(log).length, before, 'Turning verbose logging off must stop event payloads');
    assert.ok(log.lines.includes('Verbose logging disabled.'));
    await vscode.workspace.__fireDidChangeConfiguration('editor.tabSize');
    assert.strictEqual(verbose(log).length, before, 'Unrelated settings must not start a lint run');
  }, { enableVerboseLogging: true });

  await withWorkspace('manual', async ({ doc, collection, log }) => {
    await vscode.commands.__execute('zemdomu.lintWorkspace');
    assert.strictEqual(collection.get(doc.uri).length, 1);
    const previous = collection.get(doc.uri);
    vscode.workspace.__setFindFilesError('The mounted workspace is unavailable');
    await assert.rejects(vscode.commands.__execute('zemdomu.lintWorkspace'),
      error => error === 'The mounted workspace is unavailable');
    assert.strictEqual(collection.get(doc.uri), previous, 'Discovery failures must preserve last-known findings');
    assert.ok(vscode.window.__getErrorMessages().at(-1).includes('The mounted workspace is unavailable'));
    assert.ok(verbose(log).some(event => event.event === 'lintRunFailed' && event.error === 'The mounted workspace is unavailable'));
    vscode.workspace.__setFindFilesError(null);
    vscode.workspace.__setFindFiles(GLOB, []);
    assert.strictEqual(await vscode.commands.__execute('zemdomu.lintWorkspace'), 'Scan complete');
    assert.strictEqual(collection.get(doc.uri), undefined, 'An empty successful scan must remove stale findings');
    const session = vscode.window.__getProgressSessions().at(-1);
    assert.ok(session.reports.some(report => report.message.includes('No supported files found')));
    assert.strictEqual(session.options.cancellable, false, 'Atomic workspace scans remain non-cancellable');
    assert.strictEqual(session.reports.reduce((sum, report) => sum + report.increment, 0), 100);
    assert.strictEqual(vscode.window.__getStatusBarItems()[0].text, 'ZemDomu: all clear');
  }, { enableVerboseLogging: true });

  await withWorkspace('onSave', async ({ root, collection, log }) => {
    for (const relative of ['notes.txt', 'dist/Page.jsx', 'out/Page.jsx', 'node_modules/local/Page.jsx']) {
      const filename = path.join(root, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, BAD);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
      await vscode.workspace.__fireDidSaveTextDocument(doc);
      assert.strictEqual(collection.get(doc.uri), undefined, `Saving ${relative} must not publish findings`);
    }
    assert.ok(!log.lines.some(line => line.startsWith('Linted ')), 'Unsupported or generated files must not be linted on save');
  });

  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const pending = new Map();
  global.setTimeout = (callback, delay, ...args) => {
    if (delay !== 150) return originalSetTimeout(callback, delay, ...args);
    const handle = {};
    pending.set(handle, () => callback(...args));
    return handle;
  };
  global.clearTimeout = handle => {
    if (!pending.delete(handle)) originalClearTimeout(handle);
  };
  try {
    await withWorkspace('onType', async ({ doc, collection, dispose }) => {
      await vscode.workspace.__fireDidChangeTextDocument(doc);
      assert.strictEqual(pending.size, 1, 'Typing should queue one debounced analysis');
      vscode.workspace.__setConfiguration('run', 'disabled');
      await vscode.workspace.__fireDidChangeConfiguration('zemdomu.run');
      assert.strictEqual(pending.size, 0, 'Disabling automatic analysis must cancel queued typing work');
      assert.strictEqual(collection.get(doc.uri), undefined);
      vscode.workspace.__setConfiguration('run', 'onType');
      await vscode.workspace.__fireDidChangeConfiguration('zemdomu.run');
      await vscode.workspace.__fireDidChangeTextDocument(doc);
      const first = [...pending.values()][0];
      doc.__setText('export default function App(){return <img alt="Portrait" />}');
      await vscode.workspace.__fireDidChangeTextDocument(doc);
      assert.strictEqual(pending.size, 1, 'A newer edit must replace the old pending analysis');
      assert.notStrictEqual([...pending.values()][0], first);
      const [handle, execute] = [...pending.entries()][0];
      pending.delete(handle);
      await execute();
      assert.deepStrictEqual(collection.get(doc.uri), [], 'The latest valid unsaved buffer must win');
      doc.__setText(BAD);
      await vscode.workspace.__fireDidChangeTextDocument(doc);
      assert.strictEqual(pending.size, 1);
      dispose();
      assert.strictEqual(pending.size, 0, 'Disposal must cancel pending typing callbacks');
      await vscode.workspace.__fireDidChangeTextDocument(doc);
      await vscode.workspace.__fireDidSaveTextDocument(doc);
      assert.strictEqual(pending.size, 0, 'Disposed listeners must not schedule new work');
      assert.strictEqual(vscode.commands.__get('zemdomu.lintWorkspace'), undefined);
      assert.strictEqual(vscode.languages.__getCodeActionProviders().length, 0);
      assert.strictEqual(collection.__entries().size, 0);
    });
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }

  await withWorkspace('onSave', async ({ root, doc, collection, log }) => {
    const originalFolder = vscode.workspace.getWorkspaceFolder;
    try {
      vscode.workspace.getWorkspaceFolder = () => ({ uri: vscode.Uri.file(root), name: 'workspace' });
      await vscode.workspace.__fireDidSaveTextDocument(doc);
      assert.strictEqual(codeOf(collection.get(doc.uri)[0]), 'ZMD004');
      assert.ok(log.lines.some(line => line.includes(`rootDir=${root}`) && line.includes('cross=true')),
        'VS Code workspace ownership must provide the analysis root');
    } finally {
      vscode.workspace.getWorkspaceFolder = originalFolder;
    }
  });

  await withWorkspace('manual', async ({ doc }) => {
    const originalFindFiles = vscode.workspace.findFiles;
    const originalInfo = vscode.window.showInformationMessage;
    const notices = [];
    const waiting = new Map();
    const originalSet = global.setTimeout;
    const originalClear = global.clearTimeout;
    let release;
    let scan;
    try {
      vscode.workspace.findFiles = () => new Promise(resolve => { release = resolve; });
      vscode.window.showInformationMessage = message => { notices.push(message); return Promise.resolve(); };
      global.setTimeout = (callback, delay, ...args) => {
        if (delay !== 5000) return originalSet(callback, delay, ...args);
        const handle = {};
        waiting.set(handle, () => callback(...args));
        return handle;
      };
      global.clearTimeout = handle => { if (!waiting.delete(handle)) originalClear(handle); };
      scan = vscode.commands.__execute('zemdomu.lintWorkspace');
      assert.strictEqual(notices.length, 0, 'Short scans must not show a slow-scan notification');
      assert.strictEqual(waiting.size, 1);
      [...waiting.values()][0]();
      assert.deepStrictEqual(notices, ['ZemDomu is scanning the workspace...']);
      release([doc.uri]);
      assert.strictEqual(await scan, 'Scan complete');
      assert.strictEqual(waiting.size, 0, 'Completion must dispose the delayed notification');
    } finally {
      release?.([doc.uri]);
      if (scan) await scan.catch(() => {});
      vscode.workspace.findFiles = originalFindFiles;
      vscode.window.showInformationMessage = originalInfo;
      global.setTimeout = originalSet;
      global.clearTimeout = originalClear;
    }
  });

  await withWorkspace('manual', async () => {
    const perf = vscode.window.__getOutputChannel('ZemDomu Perf');
    const originalNow = Date.now;
    let clock = originalNow();
    try {
      // Advance a deterministic clock so the tiny fixture has measurable phases.
      Date.now = () => ++clock;
      await vscode.commands.__execute('zemdomu.lintWorkspace');
      assert.ok(perf.lines.some(line => /^Slowest file: App\.jsx [1-9]\d*\.\d{2}ms$/.test(line)),
        'Dev mode must identify the measured file and its duration');
      assert.ok(perf.lines.some(line => /^Slowest phase: \S+ [1-9]\d*\.\d{2}ms$/.test(line)),
        'Dev mode must identify a measured phase and its duration');
    } finally {
      Date.now = originalNow;
    }
    vscode.workspace.__setConfiguration('devMode', false);
    await vscode.workspace.__fireDidChangeConfiguration('zemdomu.devMode');
    const before = perf.lines.length;
    await vscode.commands.__execute('zemdomu.lintWorkspace');
    assert.strictEqual(perf.lines.length, before, 'Disabling dev mode must stop performance summaries');
  }, { devMode: true });

  await verifyEmptyDiagnosticReadContracts();
  console.log('Workspace settings, empty scan, recovery, debounce and disposal contracts passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
