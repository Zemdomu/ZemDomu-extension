const assert = require('assert');
const path = require('path');
const Module = require('module');

const stubsPath = path.join(__dirname, 'stubs');
process.env.NODE_PATH = process.env.NODE_PATH
  ? `${stubsPath}${path.delimiter}${process.env.NODE_PATH}`
  : stubsPath;
Module._initPaths();

const vscode = require('vscode');
const { IssueTracker } = require('../out/issue-tracker.js');

function createStatusBar() {
  return {
    name: '',
    command: undefined,
    text: '',
    tooltip: '',
    visible: false,
    disposed: false,
    show() {
      this.visible = true;
    },
    dispose() {
      this.disposed = true;
      this.visible = false;
    },
  };
}

function diagnostic(message) {
  return new vscode.Diagnostic(
    new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
    message,
    vscode.DiagnosticSeverity.Warning
  );
}

(() => {
  try {
    const statusBar = createStatusBar();
    const tracker = new IssueTracker(statusBar);
    const first = vscode.Uri.file(path.join('workspace', 'index.html'));
    const second = vscode.Uri.file(path.join('workspace', 'App.jsx'));

    assert.strictEqual(statusBar.name, 'ZemDomu Issues');
    assert.strictEqual(statusBar.command, 'zemdomu.lintWorkspace');
    assert.strictEqual(statusBar.text, 'ZemDomu: ready');
    assert.ok(statusBar.visible, 'status bar must be visible after activation');

    tracker.beginScan('Scanning launch fixture...');
    assert.strictEqual(statusBar.text, 'ZemDomu: scanning...');
    assert.strictEqual(statusBar.tooltip, 'Scanning launch fixture...');

    tracker.updateFile(first, [diagnostic('Missing alt')]);
    tracker.updateFile(second, [diagnostic('Missing title'), diagnostic('Missing main')]);
    assert.strictEqual(statusBar.text, 'ZemDomu: scanning... (3)');
    assert.ok(statusBar.tooltip.includes('3 issues'));
    assert.ok(statusBar.tooltip.includes('App.jsx: 2'));
    assert.ok(statusBar.tooltip.includes('index.html: 1'));

    tracker.finishScan();
    assert.strictEqual(statusBar.text, 'ZemDomu: 3 issues');

    tracker.removeFile(second);
    assert.strictEqual(statusBar.text, 'ZemDomu: 1 issue');

    tracker.updateFile(first, []);
    assert.strictEqual(statusBar.text, 'ZemDomu: all clear');
    assert.strictEqual(statusBar.tooltip, 'No ZemDomu issues in this workspace.');

    tracker.beginScan();
    tracker.clear();
    assert.strictEqual(statusBar.text, 'ZemDomu: scanning...');
    tracker.finishScan();
    assert.strictEqual(statusBar.text, 'ZemDomu: all clear');

    tracker.dispose();
    assert.ok(statusBar.disposed, 'disposing the tracker must dispose the status bar');
    console.log('Issue tracker status-bar tests passed');
  } catch (error) {
    console.error('Issue tracker status-bar tests failed');
    console.error(error);
    process.exitCode = 1;
  }
})();
