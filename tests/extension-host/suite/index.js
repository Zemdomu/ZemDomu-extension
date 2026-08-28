const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const manifest = require('../../../package.json');
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

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

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} must be installed in the Extension Host`);
  await extension.activate();
  assert.ok(extension.isActive, 'ZemDomu must activate in the real Extension Host');

  const commands = await vscode.commands.getCommands(true);
  assert.ok(
    commands.includes('zemdomu.lintWorkspace'),
    'Workspace scan command must be registered'
  );

  const fixturePath = path.resolve(__dirname, '..', 'workspace', 'index.html');
  const settingsPath = path.resolve(
    __dirname,
    '..',
    'workspace',
    '.vscode',
    'settings.json'
  );
  const document = await vscode.workspace.openTextDocument(fixturePath);
  await vscode.window.showTextDocument(document);
  const originalText = document.getText();
  const originalSettings = fs.readFileSync(settingsPath, 'utf8');
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

    const configuration = vscode.workspace.getConfiguration('zemdomu', document.uri);
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
}

module.exports = { run };
