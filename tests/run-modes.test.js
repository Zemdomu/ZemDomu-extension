const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const stubsPath = path.join(__dirname, 'stubs');
process.env.NODE_PATH = process.env.NODE_PATH
  ? `${stubsPath}${path.delimiter}${process.env.NODE_PATH}`
  : stubsPath;
Module._initPaths();

const vscode = require('vscode');

const BAD_SOURCE = 'export default function App(){ return <img />; }';
const GOOD_SOURCE =
  'export default function App(){ return <img alt="Portrait" />; }';
const WORKSPACE_GLOB = '**/*.{html,jsx,tsx,vue}';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function diagnosticCode(diag) {
  if (diag?.code && typeof diag.code === 'object') return diag.code.value;
  return diag?.code;
}

function hasRule(collection, doc, rule, code) {
  const diagnostics = collection.get(doc.uri) ?? [];
  return diagnostics.some(diag => {
    const value = diagnosticCode(diag);
    return value === rule || value === code;
  });
}

function disposeContext(context) {
  for (const disposable of [...context.subscriptions].reverse()) {
    disposable?.dispose?.();
  }
}

async function createHarness(mode, source = BAD_SOURCE) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `zemdomu-${mode}-`));
  const filePath = path.join(tmpDir, 'App.jsx');
  fs.writeFileSync(filePath, source, 'utf8');

  vscode.__resetAll();
  vscode.workspace.__setConfiguration('run', mode);
  vscode.workspace.__setWorkspaceFolders([{ uri: vscode.Uri.file(tmpDir) }]);
  vscode.workspace.__setFindFiles(WORKSPACE_GLOB, [filePath]);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

  const extensionPath = require.resolve('../dist/extension.js');
  delete require.cache[extensionPath];
  const extension = require(extensionPath);
  const context = {
    extensionPath: path.resolve(__dirname, '..'),
    subscriptions: [],
  };
  extension.activate(context);

  return {
    tmpDir,
    filePath,
    doc,
    context,
    collection: vscode.languages.__getCollection('zemdomu'),
  };
}

async function destroyHarness(harness) {
  disposeContext(harness.context);
  fs.rmSync(harness.tmpDir, { recursive: true, force: true });
}

async function testActivationAndTriggers() {
  for (const mode of ['onSave', 'onType', 'manual', 'disabled']) {
    const source = mode === 'onType' ? GOOD_SOURCE : BAD_SOURCE;
    const harness = await createHarness(mode, source);
    try {
      await delay(825);
      assert.strictEqual(
        vscode.workspace.__getFindFilesCallCount(),
        0,
        `${mode}: activation must not start a workspace scan`
      );
      assert.strictEqual(
        hasRule(harness.collection, harness.doc, 'requireAltText', 'ZMD004'),
        false,
        `${mode}: activation must not publish automatic diagnostics`
      );

      if (mode === 'onSave') {
        await vscode.workspace.__fireDidChangeTextDocument(harness.doc);
        await delay(200);
        assert.strictEqual(
          hasRule(harness.collection, harness.doc, 'requireAltText', 'ZMD004'),
          false,
          'onSave: typing must not lint'
        );
        await vscode.workspace.__fireDidSaveTextDocument(harness.doc);
        assert.ok(
          hasRule(harness.collection, harness.doc, 'requireAltText', 'ZMD004'),
          'onSave: saving must lint the saved document'
        );
        assert.strictEqual(
          vscode.workspace.__getFindFilesCallCount(),
          0,
          'onSave: saving one document must not start a workspace scan'
        );
      } else if (mode === 'onType') {
        harness.doc.__setText(BAD_SOURCE);
        await vscode.workspace.__fireDidSaveTextDocument(harness.doc);
        assert.strictEqual(
          hasRule(harness.collection, harness.doc, 'requireAltText', 'ZMD004'),
          false,
          'onType: saving must not lint'
        );
        await vscode.workspace.__fireDidChangeTextDocument(harness.doc);
        await delay(200);
        assert.ok(
          hasRule(harness.collection, harness.doc, 'requireAltText', 'ZMD004'),
          'onType: typing must lint the current unsaved buffer'
        );
        assert.strictEqual(
          fs.readFileSync(harness.filePath, 'utf8'),
          GOOD_SOURCE,
          'onType test precondition: the saved file must remain valid'
        );
      } else {
        await vscode.workspace.__fireDidSaveTextDocument(harness.doc);
        await vscode.workspace.__fireDidChangeTextDocument(harness.doc);
        await delay(200);
        assert.strictEqual(
          hasRule(harness.collection, harness.doc, 'requireAltText', 'ZMD004'),
          false,
          `${mode}: save and type events must not lint`
        );
        assert.strictEqual(
          vscode.workspace.__getFindFilesCallCount(),
          0,
          `${mode}: save and type events must not scan the workspace`
        );

        await vscode.commands.__execute('zemdomu.lintWorkspace');
        assert.ok(
          hasRule(harness.collection, harness.doc, 'requireAltText', 'ZMD004'),
          `${mode}: the explicit workspace-scan command must still lint`
        );
      }
    } finally {
      await destroyHarness(harness);
    }
  }
}

async function testSettingsChanges() {
  const harness = await createHarness('onSave');
  try {
    await vscode.workspace.__fireDidChangeConfiguration('zemdomu.run');
    assert.strictEqual(
      vscode.workspace.__getFindFilesCallCount(),
      0,
      'onSave: a settings change must not start a workspace scan'
    );
    await vscode.workspace.__fireDidSaveTextDocument(harness.doc);
    assert.ok(
      hasRule(harness.collection, harness.doc, 'requireAltText', 'ZMD004'),
      'onSave: the save listener must remain active after settings change'
    );

    fs.writeFileSync(harness.filePath, GOOD_SOURCE, 'utf8');
    harness.doc.__setText(GOOD_SOURCE);
    vscode.workspace.__setConfiguration('run', 'disabled');
    await vscode.workspace.__fireDidChangeConfiguration('zemdomu.run');
    await vscode.workspace.__fireDidSaveTextDocument(harness.doc);
    await vscode.workspace.__fireDidChangeTextDocument(harness.doc);
    await delay(200);
    assert.ok(
      hasRule(harness.collection, harness.doc, 'requireAltText', 'ZMD004'),
      'disabled: settings changes, saving, and typing must preserve existing diagnostics'
    );
    assert.strictEqual(
      vscode.workspace.__getFindFilesCallCount(),
      0,
      'disabled: changing settings must not start a workspace scan'
    );

    vscode.workspace.__setConfiguration('run', 'manual');
    await vscode.workspace.__fireDidChangeConfiguration('zemdomu.run');
    await vscode.workspace.__fireDidSaveTextDocument(harness.doc);
    await vscode.workspace.__fireDidChangeTextDocument(harness.doc);
    await delay(200);
    assert.strictEqual(
      vscode.workspace.__getFindFilesCallCount(),
      0,
      'manual: only the workspace-scan command may start a scan'
    );
    await vscode.commands.__execute('zemdomu.lintWorkspace');
    assert.strictEqual(
      hasRule(harness.collection, harness.doc, 'requireAltText', 'ZMD004'),
      false,
      'manual: the workspace-scan command must refresh diagnostics'
    );

    vscode.workspace.__setConfiguration('run', 'onType');
    await vscode.workspace.__fireDidChangeConfiguration('zemdomu.run');
    assert.strictEqual(
      vscode.workspace.__getFindFilesCallCount(),
      1,
      'onType: changing settings must not add a workspace scan'
    );
    harness.doc.__setText(BAD_SOURCE);
    await vscode.workspace.__fireDidChangeTextDocument(harness.doc);
    await delay(200);
    assert.ok(
      hasRule(harness.collection, harness.doc, 'requireAltText', 'ZMD004'),
      'onType: the type listener must become active after settings change'
    );
  } finally {
    await destroyHarness(harness);
  }
}

async function testWorkspaceFailureReporting() {
  const harness = await createHarness('manual');
  try {
    const success = await vscode.commands.__execute('zemdomu.lintWorkspace');
    assert.strictEqual(success, 'Scan complete');
    assert.ok(
      hasRule(harness.collection, harness.doc, 'requireAltText', 'ZMD004'),
      'failure precondition: the successful scan must publish a diagnostic'
    );
    const previousDiagnostics = harness.collection.get(harness.doc.uri);

    vscode.workspace.__setFindFilesError(
      new Error('Workspace files could not be enumerated')
    );
    await assert.rejects(
      vscode.commands.__execute('zemdomu.lintWorkspace'),
      /Workspace files could not be enumerated/,
      'a failed scan command must reject instead of reporting completion'
    );

    assert.strictEqual(
      harness.collection.get(harness.doc.uri),
      previousDiagnostics,
      'a failed scan must preserve the last-known diagnostics'
    );
    assert.ok(
      vscode.window
        .__getErrorMessages()
        .some(message => message.includes('ZemDomu scan failed')),
      'a failed scan must show a user-visible error'
    );
    const output = vscode.window.__getOutputChannel('ZemDomu');
    assert.ok(output, 'the ZemDomu output channel must exist');
    assert.ok(
      output.lines.some(
        line =>
          line.includes('Workspace scan failed') &&
          line.includes('Workspace files could not be enumerated')
      ),
      'a failed scan must write actionable error details to the output channel'
    );
  } finally {
    await destroyHarness(harness);
  }
}

(async () => {
  try {
    await testActivationAndTriggers();
    await testSettingsChanges();
    await testWorkspaceFailureReporting();
    console.log('Run mode contract tests passed');
  } catch (error) {
    console.error('Run mode contract tests failed');
    console.error(error);
    process.exitCode = 1;
  }
})();
