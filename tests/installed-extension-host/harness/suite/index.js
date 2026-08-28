const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

function diagnosticCode(diagnostic) {
  if (diagnostic.code && typeof diagnostic.code === 'object') {
    return diagnostic.code.value;
  }
  return diagnostic.code;
}

async function waitForMissingAlt(uri) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (diagnostics.some(item => diagnosticCode(item) === 'ZMD004')) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Installed VSIX did not publish the expected missing-alt diagnostic');
}

async function run() {
  const extensionId = process.env.ZEMDOMU_EXPECTED_EXTENSION_ID;
  assert.ok(extensionId, 'Expected extension id was not provided to the smoke harness');
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, `${extensionId} must be loaded from the clean extensions directory`);
  await extension.activate();
  assert.ok(extension.isActive, 'The installed ZemDomu VSIX must activate');

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('zemdomu.lintWorkspace'), 'Installed VSIX must register its scan command');

  const fixturePath = path.resolve(__dirname, '..', '..', 'workspace', 'index.html');
  const document = await vscode.workspace.openTextDocument(fixturePath);
  await vscode.window.showTextDocument(document);
  assert.strictEqual(
    await vscode.commands.executeCommand('zemdomu.lintWorkspace'),
    'Scan complete'
  );
  await waitForMissingAlt(document.uri);
}

module.exports = { run };
