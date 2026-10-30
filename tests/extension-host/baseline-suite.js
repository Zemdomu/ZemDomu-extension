const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const vscode = require('vscode');
const { SCHEMA_VERSION, PROTOCOL, sha256, fixtureIdentity } = require('./baseline-shared');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const mib = bytes => Number((bytes / 1024 / 1024).toFixed(4));
const normalized = file => path.resolve(file).replace(/\\/g, '/').toLowerCase();

function memorySnapshot(label) {
  const usage = process.memoryUsage();
  return { label, timestamp: new Date().toISOString(), elapsedMs: performance.now(), rssBytes: usage.rss, ...Object.fromEntries(Object.entries(usage).map(([key, value]) => [`${key}MiB`, mib(value)])) };
}

function productState(id, productRoot, mainPath) {
  const root = normalized(fs.realpathSync(productRoot));
  const main = normalized(fs.realpathSync(mainPath));
  const modules = Object.keys(require.cache);
  const bundleModules = modules.filter(file => normalized(file) === main);
  const coreModules = modules.filter(file => normalized(file).includes('/node_modules/zemdomu/'));
  const otherProductModules = modules.filter(file => {
    const name = normalized(file);
    return [root + '/src/', root + '/out/'].some(prefix => name.startsWith(prefix)) || name.startsWith(root + '/dist/');
  });
  const extension = vscode.extensions.getExtension(id);
  return {
    id,
    registered: Boolean(extension),
    isActive: extension?.isActive ?? false,
    extensionPath: extension?.extensionPath,
    bundleModules,
    coreModules,
    otherProductModules,
    expectedMain: mainPath,
    mainLoaded: bundleModules.length > 0,
  };
}

async function run() {
  const config = JSON.parse(fs.readFileSync(process.env.ZEMDOMU_BASELINE_SAMPLE_CONFIG, 'utf8'));
  assert.strictEqual(config.schemaVersion, SCHEMA_VERSION);
  assert.ok(['control', 'treatment'].includes(config.sample.condition));
  const treatment = config.sample.condition === 'treatment';
  // The same imports (including this manifest and the diagnostic helper module)
  // execute in both conditions. No extension or Core runtime is imported here.
  const manifest = require(path.join(config.productRoot, 'package.json'));
  const id = `${manifest.publisher}.${manifest.name}`;
  const mainPath = path.resolve(config.productRoot, manifest.main);
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const report = {
    schemaVersion: SCHEMA_VERSION,
    status: 'running',
    sample: config.sample,
    cell: config.cell,
    environment: {
      platform: os.platform(), release: os.release(), architecture: process.arch,
      cpu: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(), node: process.version,
      electron: process.versions.electron, chrome: process.versions.chrome,
      vscode: vscode.version, pid: process.pid, execPath: process.execPath,
      execArgv: process.execArgv,
    },
    inputs: { sourceSha256: config.sourceSha256, bundleSha256: config.bundleSha256, fixtureSha256: config.fixtureSha256, executable: config.executable },
    product: { expectedId: id, expectedCondition: config.sample.condition, pre: null, postActivation: null, final: null, proofValid: false },
    phases: [],
    editor: { typeOperations: [], saveOperations: [] },
    memory: { milestones: [], fullWindowPeakRssMiB: 0, saveWindowPeakRssMiB: 0 },
    protocol: PROTOCOL,
    asymmetry: 'Control has an inert development manifest. Only treatment activates ZemDomu, scans and validates product diagnostics. Common imports/configuration/editor operations/cadence/quiet settling match; actual product work may extend phase durations.',
  };
  let fullPeakBytes = 0;
  let savePeakBytes = 0;
  let saveWindow = false;
  const started = performance.now();
  function capture(label) {
    const milestone = memorySnapshot(label);
    fullPeakBytes = Math.max(fullPeakBytes, milestone.rssBytes);
    if (saveWindow) savePeakBytes = Math.max(savePeakBytes, milestone.rssBytes);
    report.memory.milestones.push(milestone);
    fs.appendFileSync(config.eventsPath, `${JSON.stringify(milestone)}\n`);
  }
  function observe() {
    const rss = process.memoryUsage.rss();
    fullPeakBytes = Math.max(fullPeakBytes, rss);
    if (saveWindow) savePeakBytes = Math.max(savePeakBytes, rss);
  }
  async function phase(label, action) {
    const start = performance.now();
    const active = () => vscode.extensions.all.filter(extension => extension.isActive).map(extension => ({ id: extension.id, path: extension.extensionPath }));
    const record = { label, startedAt: new Date().toISOString(), operationMs: null, settleMs: PROTOCOL.settleMs, totalMs: null, activeExtensionsBefore: active() };
    report.phases.push(record);
    capture(`before-${label}`);
    try {
      await action();
      record.operationMs = performance.now() - start;
      capture(`after-${label}-operation`);
      await delay(PROTOCOL.settleMs);
      capture(`after-${label}-settled`);
      record.activeExtensionsAfterSettling = active();
    } finally {
      record.totalMs = performance.now() - start;
      record.finishedAt = new Date().toISOString();
    }
  }
  const sampler = setInterval(observe, PROTOCOL.sampleIntervalMs);
  try {
    capture('suite-entry-before-explicit-activation');
    assert.strictEqual(vscode.version, config.vscodeVersion, 'Downloaded build must match the exact matrix version');
    assert.ok(workspace, 'One fixture workspace is required');
    assert.strictEqual(fixtureIdentity(workspace).sha256, config.fixtureSha256);
    assert.strictEqual(sha256(fs.readFileSync(mainPath)), config.bundleSha256, 'Expected product bundle must be identical in both conditions');
    report.configurationSchema = {
      defaultRun: vscode.workspace.getConfiguration('zemdomu').inspect('run')?.defaultValue,
      expectedDefaultRun: manifest.contributes.configuration.properties['zemdomu.run'].default,
    };
    assert.strictEqual(report.configurationSchema.defaultRun, report.configurationSchema.expectedDefaultRun, 'Both conditions must register the identical static configuration schema');
    report.product.pre = productState(id, config.productRoot, mainPath);
    if (!treatment) {
      assert.strictEqual(report.product.pre.registered, false, 'Control must not register ZemDomu');
      assert.strictEqual(report.product.pre.mainLoaded, false, 'Control cannot load the product bundle');
      assert.deepStrictEqual(report.product.pre.coreModules, []);
      assert.deepStrictEqual(report.product.pre.otherProductModules, []);
    } else {
      assert.strictEqual(report.product.pre.registered, true, 'Treatment must register the expected product ID');
      assert.strictEqual(normalized(fs.realpathSync(report.product.pre.extensionPath)), normalized(fs.realpathSync(config.productRoot)));
    }
    await phase('activation-or-control-idle', async () => {
      if (treatment) await vscode.extensions.getExtension(id).activate();
      report.product.postActivation = productState(id, config.productRoot, mainPath);
      if (treatment) {
        assert.ok(report.product.postActivation.isActive && report.product.postActivation.mainLoaded, 'Treatment must load and activate the exact expected bundle');
      }
    });
    let document;
    let originalText;
    let validText;
    let configuration;
    let missingAlt = () => vscode.languages.getDiagnostics(document.uri).filter(item => (typeof item.code === 'object' ? item.code.value : item.code) === 'ZMD004');
    async function expectMissingAlt(expected, severity) {
      if (!treatment) return;
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const diagnostics = missingAlt();
        if ((diagnostics.length > 0) === expected && (severity === undefined || diagnostics.some(item => item.severity === severity))) return;
        await delay(10);
      }
      throw new Error(`Treatment diagnostic mismatch: missing-alt=${expected}, severity=${severity}`);
    }
    async function replace(text) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
      assert.ok(await vscode.workspace.applyEdit(edit), 'Common editor replacement must succeed');
    }
    async function scan() {
      if (treatment) assert.strictEqual(await vscode.commands.executeCommand('zemdomu.lintWorkspace'), 'Scan complete');
    }
    await phase('open-editor-and-enumerate', async () => {
      document = await vscode.workspace.openTextDocument(path.join(workspace, 'index.html'));
      await vscode.window.showTextDocument(document);
      originalText = document.getText();
      validText = originalText.replace('<img src="portrait.png">', '<img src="portrait.png" alt="Portrait">');
      assert.notStrictEqual(originalText, validText);
      configuration = vscode.workspace.getConfiguration('zemdomu', document.uri);
      report.workspaceFileCount = (await vscode.workspace.findFiles('**/*.{html,jsx,tsx,vue}', '{**/node_modules/**,**/dist/**,**/out/**,**/.git/**}')).length;
      assert.strictEqual(report.workspaceFileCount, 100);
    });
    await phase('initial-workspace-scan-or-control', async () => { await scan(); await expectMissingAlt(true); });
    await phase('error-severity-scan-or-control', async () => {
      await configuration.update('severity.requireAltText', 'error', vscode.ConfigurationTarget.Workspace);
      await scan(); await expectMissingAlt(true, vscode.DiagnosticSeverity.Error);
    });
    await phase('rule-disabled-scan-or-control', async () => {
      await configuration.update('rules.requireAltText', false, vscode.ConfigurationTarget.Workspace);
      await scan(); await expectMissingAlt(false);
    });
    await phase('rule-restored-scan-or-control', async () => {
      await configuration.update('rules.requireAltText', true, vscode.ConfigurationTarget.Workspace);
      await scan(); await expectMissingAlt(true);
    });
    await phase('common-repair-and-save', async () => {
      await replace(validText); assert.ok(await document.save()); await scan(); await expectMissingAlt(false);
    });
    await phase('common-functional-cleanup', async () => {
      await configuration.update('severity.requireAltText', undefined, vscode.ConfigurationTarget.Workspace);
      await configuration.update('rules.requireAltText', undefined, vscode.ConfigurationTarget.Workspace);
      await replace(originalText); assert.ok(await document.save()); await scan(); await expectMissingAlt(true);
    });
    await phase('select-on-type', () => configuration.update('run', 'onType', vscode.ConfigurationTarget.Workspace));
    await phase('twenty-common-typing-transitions', async () => {
      for (let index = 0; index < PROTOCOL.typeCount; index += 1) {
        const start = performance.now();
        const expected = index % 2 !== 0;
        await replace(expected ? originalText : validText);
        const editMs = performance.now() - start;
        await delay(PROTOCOL.typeCadenceMs);
        const cadenceEnd = performance.now();
        await expectMissingAlt(expected);
        report.editor.typeOperations.push({ index, expectedMissingAlt: expected, textSha256: sha256(expected ? originalText : validText), editMs, cadenceMs: PROTOCOL.typeCadenceMs, diagnosticWaitAfterCadenceMs: performance.now() - cadenceEnd, totalMs: performance.now() - start });
        observe();
      }
    });
    await phase('select-on-save', () => configuration.update('run', 'onSave', vscode.ConfigurationTarget.Workspace));
    saveWindow = true; observe(); capture('before-save-window');
    await phase('hundred-common-save-transitions', async () => {
      for (let index = 0; index < PROTOCOL.saveCount; index += 1) {
        const start = performance.now();
        const expected = index % 2 !== 0;
        await replace(expected ? originalText : validText);
        const editMs = performance.now() - start;
        const saveStart = performance.now();
        assert.ok(await document.save(), 'Common document save must succeed');
        const saveMs = performance.now() - saveStart;
        await delay(PROTOCOL.saveCadenceMs);
        const cadenceEnd = performance.now();
        await expectMissingAlt(expected);
        report.editor.saveOperations.push({ index, expectedMissingAlt: expected, textSha256: sha256(expected ? originalText : validText), editMs, saveMs, cadenceMs: PROTOCOL.saveCadenceMs, diagnosticWaitAfterCadenceMs: performance.now() - cadenceEnd, totalMs: performance.now() - start });
        observe();
      }
    });
    capture('after-save-window'); observe(); saveWindow = false;
    await phase('restore-manual', () => configuration.update('run', 'manual', vscode.ConfigurationTarget.Workspace));
    await phase('final-enumeration-and-proof', async () => {
      assert.strictEqual((await vscode.workspace.findFiles('**/*.{html,jsx,tsx,vue}', '{**/node_modules/**,**/dist/**,**/out/**,**/.git/**}')).length, 100);
      report.product.final = productState(id, config.productRoot, mainPath);
      if (treatment) assert.ok(report.product.final.registered && report.product.final.isActive && report.product.final.mainLoaded);
      else {
        assert.strictEqual(report.product.final.registered, false);
        assert.strictEqual(report.product.final.mainLoaded, false);
        assert.deepStrictEqual(report.product.final.coreModules, []);
        assert.deepStrictEqual(report.product.final.otherProductModules, []);
      }
      report.product.proofValid = true;
      report.activeExtensions = vscode.extensions.all.filter(extension => extension.isActive).map(extension => ({ id: extension.id, path: extension.extensionPath }));
    });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = { name: error.name, message: error.message, stack: error.stack };
    throw error;
  } finally {
    capture('final-before-report'); observe(); clearInterval(sampler);
    report.memory.fullWindowPeakRssMiB = mib(fullPeakBytes);
    report.memory.saveWindowPeakRssMiB = mib(savePeakBytes);
    report.memory.fullWindowPeakRssBytes = fullPeakBytes;
    report.memory.saveWindowPeakRssBytes = savePeakBytes;
    report.durationMs = performance.now() - started;
    report.finishedAt = new Date().toISOString();
    report.memory.samplingLimit = '5ms same-thread samples plus every milestone, from suite entry through final proof/settling, excluding bootstrap before entry and report serialization. Synchronous transients can be missed; not an OS high-water claim.';
    fs.writeFileSync(config.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[ZemDomu diagnostic baseline] ${JSON.stringify({ sample: report.sample, status: report.status, memory: report.memory })}`);
  }
}

module.exports = { run };
