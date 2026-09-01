const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const vscode = require('vscode');

const manifest = require('../../../package.json');
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;
const TYPE_RUNS = 20;
const SAVE_RUNS = 100;
const MAX_TYPE_P95_MS = 500;
const MAX_SAVE_P95_MS = 1000;
const MAX_RSS_MIB = 250;
const MAX_RSS_GROWTH_PERCENT = 20;

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function appendPerformanceRecord(record) {
  const resultsPath = process.env.ZEMDOMU_PERF_RESULTS_PATH;
  assert.ok(resultsPath, 'Performance result path must be supplied by the host runner');
  fs.appendFileSync(resultsPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function diagnosticCode(diagnostic) {
  if (diagnostic.code && typeof diagnostic.code === 'object') {
    return diagnostic.code.value;
  }
  return diagnostic.code;
}

async function waitForDiagnostics(uri, predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (predicate(diagnostics)) return diagnostics;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function replaceDocument(document, text) {
  const edit = new vscode.WorkspaceEdit();
  const end = document.positionAt(document.getText().length);
  edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), end), text);
  return vscode.workspace.applyEdit(edit);
}

function waitForNextDiagnosticState(uri, expectMissingAlt, action) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      disposable.dispose();
      reject(new Error('Timed out waiting for the measured diagnostic transition'));
    }, 5000);
    const disposable = vscode.languages.onDidChangeDiagnostics(event => {
      if (!event.uris.some(changed => changed.toString() === uri.toString())) return;
      const hasMissingAlt = vscode.languages.getDiagnostics(uri)
        .some(item => diagnosticCode(item) === 'ZMD004');
      if (hasMissingAlt !== expectMissingAlt) return;
      clearTimeout(timeout);
      disposable.dispose();
      resolve(performance.now());
    });
    Promise.resolve(action()).catch(error => {
      clearTimeout(timeout);
      disposable.dispose();
      reject(error);
    });
  });
}

async function measureInteractivePerformance(document, configuration) {
  const validText = '<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Fixture</h1><img src="portrait.png" alt="Portrait"></main></body></html>';
  const invalidText = '<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Fixture</h1><img src="portrait.png"></main></body></html>';
  const typeDurationsMs = [];
  const saveDurationsMs = [];

  await configuration.update('run', 'onType', vscode.ConfigurationTarget.Workspace);
  await new Promise(resolve => setTimeout(resolve, 100));
  for (let run = 0; run < TYPE_RUNS; run += 1) {
    const expectMissingAlt = run % 2 !== 0;
    const startedAt = performance.now();
    const completedAt = await waitForNextDiagnosticState(
      document.uri,
      expectMissingAlt,
      () => replaceDocument(document, expectMissingAlt ? invalidText : validText)
    );
    typeDurationsMs.push(completedAt - startedAt);
  }

  await configuration.update('run', 'onSave', vscode.ConfigurationTarget.Workspace);
  await new Promise(resolve => setTimeout(resolve, 100));
  const baselineRssBytes = process.memoryUsage().rss;
  let peakRssBytes = baselineRssBytes;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 5);
  try {
    for (let run = 0; run < SAVE_RUNS; run += 1) {
      const expectMissingAlt = run % 2 !== 0;
      assert.ok(await replaceDocument(document, expectMissingAlt ? invalidText : validText));
      const startedAt = performance.now();
      const completedAt = await waitForNextDiagnosticState(
        document.uri,
        expectMissingAlt,
        () => document.save()
      );
      saveDurationsMs.push(completedAt - startedAt);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }
  } finally {
    clearInterval(sampler);
  }
  await configuration.update('run', 'manual', vscode.ConfigurationTarget.Workspace);
  const finalRssBytes = process.memoryUsage().rss;
  const peakRssMiB = Number((peakRssBytes / 1024 / 1024).toFixed(2));
  const rssGrowthPercent = Number((
    Math.max(0, finalRssBytes - baselineRssBytes) / baselineRssBytes * 100
  ).toFixed(2));
  const typeP95Ms = Number(percentile(typeDurationsMs, 0.95).toFixed(2));
  const saveP95Ms = Number(percentile(saveDurationsMs, 0.95).toFixed(2));

  assert.ok(
    typeP95Ms < MAX_TYPE_P95_MS,
    `on-type p95 ${typeP95Ms}ms must stay below ${MAX_TYPE_P95_MS}ms after debounce`
  );
  assert.ok(
    saveP95Ms < MAX_SAVE_P95_MS,
    `on-save p95 ${saveP95Ms}ms must stay below ${MAX_SAVE_P95_MS}ms`
  );
  assert.ok(
    peakRssMiB < MAX_RSS_MIB,
    `Extension Host peak RSS ${peakRssMiB} MiB must stay below ${MAX_RSS_MIB} MiB`
  );
  assert.ok(
    rssGrowthPercent < MAX_RSS_GROWTH_PERCENT,
    `RSS growth ${rssGrowthPercent}% must stay below ${MAX_RSS_GROWTH_PERCENT}% after ${SAVE_RUNS} scans`
  );

  const workspaceFiles = await vscode.workspace.findFiles(
    '**/*.{html,jsx,tsx,vue}',
    '{**/node_modules/**,**/dist/**,**/out/**,**/.git/**}'
  );
  assert.strictEqual(workspaceFiles.length, 100, 'Performance fixture must contain 100 files');

  return {
    type: 'interactive',
    environment: {
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: os.cpus().length,
      totalMemoryMiB: Number((os.totalmem() / 1024 / 1024).toFixed(0)),
      node: process.version,
      vscode: vscode.version,
      extensionVersion: manifest.version,
    },
    fixture: {
      fileCount: workspaceFiles.length,
      formats: ['html', 'jsx', 'tsx', 'vue'],
      shape: 'standalone valid files plus one document toggled between valid and missing-alt states',
    },
    onType: {
      runCount: TYPE_RUNS,
      p95Ms: typeP95Ms,
      budgetMs: MAX_TYPE_P95_MS,
    },
    onSave: {
      runCount: SAVE_RUNS,
      p95Ms: saveP95Ms,
      budgetMs: MAX_SAVE_P95_MS,
    },
    memory: {
      scanCount: SAVE_RUNS,
      scanMode: 'onSave',
      baselineRssMiB: Number((baselineRssBytes / 1024 / 1024).toFixed(2)),
      finalRssMiB: Number((finalRssBytes / 1024 / 1024).toFixed(2)),
      peakRssMiB,
      growthPercent: rssGrowthPercent,
      peakBudgetMiB: MAX_RSS_MIB,
      growthBudgetPercent: MAX_RSS_GROWTH_PERCENT,
    },
  };
}

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} must be installed in the Extension Host`);
  assert.ok(!extension.isActive, 'Cold activation must begin before ZemDomu is active');
  const activationStartedAt = performance.now();
  await extension.activate();
  const activationDurationMs = Number((performance.now() - activationStartedAt).toFixed(2));
  assert.ok(extension.isActive, 'ZemDomu must activate in the real Extension Host');
  appendPerformanceRecord({
    type: 'activation',
    durationMs: activationDurationMs,
    measured: process.env.ZEMDOMU_MEASURE_ACTIVATION === '1',
    vscode: vscode.version,
  });
  if (process.env.ZEMDOMU_PERF_MODE === 'activation') return;

  const commands = await vscode.commands.getCommands(true);
  assert.ok(
    commands.includes('zemdomu.lintWorkspace'),
    'Workspace scan command must be registered'
  );

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspaceRoot, 'Performance tests require one workspace folder');
  const fixturePath = path.join(workspaceRoot, 'index.html');
  const settingsPath = path.join(workspaceRoot, '.vscode', 'settings.json');
  const document = await vscode.workspace.openTextDocument(fixturePath);
  await vscode.window.showTextDocument(document);
  const originalText = document.getText();
  const originalSettings = fs.readFileSync(settingsPath, 'utf8');
  const configuration = vscode.workspace.getConfiguration('zemdomu', document.uri);
  try {
    const result = await vscode.commands.executeCommand('zemdomu.lintWorkspace');
    assert.strictEqual(result, 'Scan complete');

    const diagnostics = await waitForDiagnostics(
      document.uri,
      items => items.some(item => diagnosticCode(item) === 'ZMD004'),
      'Real Extension Host did not publish the expected missing-alt diagnostic'
    );
    const missingAlt = diagnostics.find(item => diagnosticCode(item) === 'ZMD004');
    assert.ok(missingAlt, 'Missing-alt diagnostic must be visible in Problems');

    await configuration.update(
      'severity.requireAltText',
      'error',
      vscode.ConfigurationTarget.Workspace
    );
    await vscode.commands.executeCommand('zemdomu.lintWorkspace');
    const errorDiagnostics = await waitForDiagnostics(
      document.uri,
      items => items.some(
        item =>
          diagnosticCode(item) === 'ZMD004' &&
          item.severity === vscode.DiagnosticSeverity.Error
      ),
      'Changing requireAltText severity to error did not update the diagnostic'
    );
    assert.ok(
      errorDiagnostics.some(
        item =>
          diagnosticCode(item) === 'ZMD004' &&
          item.severity === vscode.DiagnosticSeverity.Error
      ),
      'Rule severity setting must be honored by a real workspace scan'
    );

    await configuration.update(
      'rules.requireAltText',
      false,
      vscode.ConfigurationTarget.Workspace
    );
    await vscode.commands.executeCommand('zemdomu.lintWorkspace');
    await waitForDiagnostics(
      document.uri,
      items => !items.some(item => diagnosticCode(item) === 'ZMD004'),
      'Disabling requireAltText did not clear its diagnostic'
    );

    await configuration.update(
      'rules.requireAltText',
      true,
      vscode.ConfigurationTarget.Workspace
    );
    await vscode.commands.executeCommand('zemdomu.lintWorkspace');
    const restoredDiagnostics = await waitForDiagnostics(
      document.uri,
      items => items.some(item => diagnosticCode(item) === 'ZMD004'),
      'Re-enabling requireAltText did not restore its diagnostic'
    );
    const restoredMissingAlt = restoredDiagnostics.find(
      item => diagnosticCode(item) === 'ZMD004'
    );

    const actions = await vscode.commands.executeCommand(
      'vscode.executeCodeActionProvider',
      document.uri,
      restoredMissingAlt.range,
      vscode.CodeActionKind.QuickFix.value
    );
    const altAction = actions.find(
      action => action.edit && /alt/i.test(action.title)
    );
    assert.ok(altAction, 'Missing-alt diagnostic must offer an alt quick fix');
    assert.ok(await vscode.workspace.applyEdit(altAction.edit));
    await document.save();
    await vscode.commands.executeCommand('zemdomu.lintWorkspace');

    await waitForDiagnostics(
      document.uri,
      items => !items.some(item => diagnosticCode(item) === 'ZMD004'),
      'Resolved missing-alt diagnostic remained stale after quick fix and rescan'
    );
  } finally {
    fs.writeFileSync(settingsPath, originalSettings, 'utf8');
    const restore = new vscode.WorkspaceEdit();
    const end = document.positionAt(document.getText().length);
    restore.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), end), originalText);
    await vscode.workspace.applyEdit(restore);
    await document.save();
  }

  const interactive = await measureInteractivePerformance(document, configuration);
  appendPerformanceRecord(interactive);
}

module.exports = { run };
