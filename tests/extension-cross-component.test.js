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

process.env.ZEMDOMU_SKIP_STARTUP_SCAN = '1';

const vscode = require('vscode');

function diagnosticCode(diag) {
  if (!diag) return undefined;
  if (diag.code && typeof diag.code === 'object') {
    return diag.code.value;
  }
  return diag.code;
}

function writeButton(filePath, headingTag) {
  fs.writeFileSync(
    filePath,
    `export default function Button(){ return (<div><${headingTag}>Button</${headingTag}></div>); }`,
    'utf8'
  );
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-ext-ws-'));
  const buttonPath = path.join(tmpDir, 'Button.jsx');
  const pagePath = path.join(tmpDir, 'Page.jsx');

  try {
    fs.writeFileSync(
      pagePath,
      "import Button from './Button'; export default function Page(){ return (<main><h1>Page</h1><Button/></main>); }",
      'utf8'
    );
    writeButton(buttonPath, 'h1');

    vscode.__resetAll();
    vscode.workspace.__setWorkspaceFolders([{ uri: vscode.Uri.file(tmpDir) }]);
    vscode.workspace.__setFindFiles('**/*.{jsx,tsx}', [buttonPath, pagePath]);
    vscode.workspace.__setFindFiles('**/*.html', []);

    const context = {
      extensionPath: path.resolve(__dirname, '..'),
      subscriptions: [],
    };

    const extension = require('../dist/extension.js');
    extension.activate(context);

    const lintCommand = vscode.commands.__get('zemdomu.lintWorkspace');
    assert.ok(lintCommand, 'Expected zemdomu.lintWorkspace command to be registered');

    await vscode.commands.__execute('zemdomu.lintWorkspace');

    const collection = vscode.languages.__getCollection('zemdomu');
    assert.ok(collection, 'Expected ZemDomu diagnostic collection to be created');

    let pageDiagnostics = collection.get(vscode.Uri.file(pagePath)) ?? [];
    assert.ok(
      pageDiagnostics.some(diag => diagnosticCode(diag) === 'singleH1'),
      'Expected cross-component singleH1 diagnostic for Page.jsx'
    );

    writeButton(buttonPath, 'h2');

    await vscode.commands.__execute('zemdomu.lintWorkspace');

    pageDiagnostics = collection.get(vscode.Uri.file(pagePath)) ?? [];
    const hasSingleH1 = pageDiagnostics.some(
      diag => diagnosticCode(diag) === 'singleH1'
    );
    assert.strictEqual(
      hasSingleH1,
      false,
      'Expected cross-component singleH1 diagnostic to clear after fixing Button.jsx'
    );

    console.log('Extension cross-component integration test passed');
  } catch (error) {
    console.error('Extension cross-component integration test failed');
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})();
