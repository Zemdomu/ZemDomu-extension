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

const RULE_CODES = {
  requireAltText: 'ZMD004',
};

function diagnosticCode(diag) {
  if (!diag) return undefined;
  if (diag.code && typeof diag.code === 'object') {
    return diag.code.value;
  }
  return diag.code;
}

function matchesRule(diag, ruleName) {
  const code = diagnosticCode(diag);
  return code === ruleName || code === RULE_CODES[ruleName];
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-vue-'));
  const appPath = path.join(tmpDir, 'App.vue');

  try {
    fs.writeFileSync(
      appPath,
      `<template>
  <div><img></div>
</template>
`,
      'utf8'
    );

    vscode.__resetAll();
    vscode.workspace.__setWorkspaceFolders([{ uri: vscode.Uri.file(tmpDir) }]);
    vscode.workspace.__setFindFiles('**/*.vue', [appPath]);

    const context = {
      extensionPath: path.resolve(__dirname, '..'),
      subscriptions: [],
    };

    const extension = require('../dist/extension.js');
    extension.activate(context);

    await vscode.commands.__execute('zemdomu.lintWorkspace');

    const collection = vscode.languages.__getCollection('zemdomu');
    assert.ok(collection, 'Expected ZemDomu diagnostic collection to be created');

    const diagnostics = collection.get(vscode.Uri.file(appPath)) ?? [];
    assert.ok(
      diagnostics.some((diag) => matchesRule(diag, 'requireAltText')),
      'Expected requireAltText diagnostic for Vue template'
    );

    console.log('Vue extension integration test passed');
  } catch (error) {
    console.error('Vue extension integration test failed');
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})();
