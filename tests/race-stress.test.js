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
const GOOD_SOURCE = 'export default function App(){ return <img alt="Portrait" />; }';
const WORKSPACE_GLOB = '**/*.{html,jsx,tsx,vue}';
const ITERATIONS = 100;

function diagnosticCode(diagnostic) {
  if (diagnostic?.code && typeof diagnostic.code === 'object') {
    return diagnostic.code.value;
  }
  return diagnostic?.code;
}

function hasMissingAlt(collection, document) {
  return (collection.get(document.uri) ?? []).some(
    diagnostic => diagnosticCode(diagnostic) === 'ZMD004'
  );
}

function disposeContext(context) {
  for (const disposable of [...context.subscriptions].reverse()) {
    disposable?.dispose?.();
  }
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-races-'));
  const filePath = path.join(tempDir, 'App.jsx');
  const unhandledRejections = [];
  const onUnhandledRejection = reason => unhandledRejections.push(reason);
  let context;

  try {
    fs.writeFileSync(filePath, GOOD_SOURCE, 'utf8');
    vscode.__resetAll();
    vscode.workspace.__setConfiguration('run', 'onType');
    vscode.workspace.__setWorkspaceFolders([{ uri: vscode.Uri.file(tempDir) }]);
    vscode.workspace.__setFindFiles(WORKSPACE_GLOB, [filePath]);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

    const extensionPath = require.resolve('../dist/extension.js');
    delete require.cache[extensionPath];
    const extension = require(extensionPath);
    context = {
      extensionPath: path.resolve(__dirname, '..'),
      subscriptions: [],
    };
    extension.activate(context);

    const collection = vscode.languages.__getCollection('zemdomu');
    const statusBar = vscode.window.__getStatusBarItems()[0];
    assert.ok(collection, 'ZemDomu diagnostic collection must exist');
    assert.ok(statusBar, 'ZemDomu status bar must exist');
    process.on('unhandledRejection', onUnhandledRejection);

    for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
      vscode.workspace.__setConfiguration('run', 'onType');
      await vscode.workspace.__fireDidChangeConfiguration('zemdomu.run');
      document.__setText(BAD_SOURCE);
      const typeEvent = vscode.workspace.__fireDidChangeTextDocument(document);

      vscode.workspace.__setConfiguration('run', 'manual');
      const configurationEvent = vscode.workspace.__fireDidChangeConfiguration(
        'zemdomu.run'
      );
      fs.writeFileSync(filePath, BAD_SOURCE, 'utf8');
      const workspaceScan = vscode.commands.__execute('zemdomu.lintWorkspace');

      document.__setText(GOOD_SOURCE);
      fs.writeFileSync(filePath, GOOD_SOURCE, 'utf8');
      vscode.workspace.__setConfiguration('run', 'onSave');
      await vscode.workspace.__fireDidChangeConfiguration('zemdomu.run');
      const finalSave = vscode.workspace.__fireDidSaveTextDocument(document);

      const outcomes = await Promise.allSettled([
        typeEvent,
        configurationEvent,
        workspaceScan,
        finalSave,
      ]);
      const rejected = outcomes.find(outcome => outcome.status === 'rejected');
      assert.strictEqual(
        rejected,
        undefined,
        `race ${iteration}: overlapping operations must not reject`
      );
      assert.strictEqual(
        hasMissingAlt(collection, document),
        false,
        `race ${iteration}: a stale missing-alt diagnostic survived the final valid save`
      );
      assert.strictEqual(
        statusBar.text,
        'ZemDomu: all clear',
        `race ${iteration}: status bar falsely reported issues after a clean result`
      );

      document.__setText(BAD_SOURCE);
      fs.writeFileSync(filePath, BAD_SOURCE, 'utf8');
      await vscode.commands.__execute('zemdomu.lintWorkspace');
      assert.ok(
        hasMissingAlt(collection, document),
        `race ${iteration}: the final workspace scan lost a real finding`
      );
      assert.notStrictEqual(
        statusBar.text,
        'ZemDomu: all clear',
        `race ${iteration}: status bar reported all clear while Problems had a finding`
      );

      document.__setText(GOOD_SOURCE);
      fs.writeFileSync(filePath, GOOD_SOURCE, 'utf8');
      await vscode.workspace.__fireDidSaveTextDocument(document);
    }

    assert.deepStrictEqual(
      unhandledRejections,
      [],
      'race suite must not produce unhandled promise rejections'
    );
    console.log(`Race stress tests passed: ${ITERATIONS} iterations`);
  } catch (error) {
    console.error('Race stress tests failed');
    console.error(error);
    process.exitCode = 1;
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    if (context) disposeContext(context);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
