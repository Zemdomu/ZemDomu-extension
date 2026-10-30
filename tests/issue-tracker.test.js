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

    assert.strictEqual(statusBar.name, 'ZemDomu Findings');
    assert.strictEqual(statusBar.command, 'zemdomu.lintWorkspace');
    assert.strictEqual(statusBar.text, 'ZemDomu: ready');
    assert.ok(statusBar.accessibilityInformation.label.includes('ready'));
    assert.strictEqual(statusBar.accessibilityInformation.role, 'button');
    assert.ok(statusBar.visible, 'status bar must be visible after activation');

    tracker.beginScan('Scanning launch fixture...');
    assert.strictEqual(statusBar.text, 'ZemDomu: scanning...');
    assert.strictEqual(statusBar.tooltip, 'Scanning launch fixture...');
    assert.ok(statusBar.accessibilityInformation.label.includes('in progress'));

    tracker.updateScanPhase('Analyzing 2 files...');
    assert.strictEqual(statusBar.tooltip, 'Analyzing 2 files...');

    tracker.updateFile(first, [diagnostic('Missing alt')]);
    tracker.updateFile(second, [diagnostic('Missing title'), diagnostic('Missing main')]);
    assert.strictEqual(statusBar.text, 'ZemDomu: scanning... (3)');
    assert.ok(statusBar.tooltip.includes('3 findings'));
    assert.ok(statusBar.tooltip.includes('App.jsx: 2'));
    assert.ok(statusBar.tooltip.includes('index.html: 1'));

    tracker.finishScan();
    assert.strictEqual(statusBar.text, 'ZemDomu: 3 findings');
    assert.ok(statusBar.accessibilityInformation.label.includes('3 findings found'));

    tracker.removeFile(second);
    assert.strictEqual(statusBar.text, 'ZemDomu: 1 finding');

    tracker.updateFile(first, []);
    assert.strictEqual(statusBar.text, 'ZemDomu: all clear');
    assert.strictEqual(statusBar.tooltip, 'No ZemDomu findings in this workspace.');

    tracker.beginScan();
    tracker.clear();
    assert.strictEqual(statusBar.text, 'ZemDomu: scanning...');
    tracker.finishScan();
    assert.strictEqual(statusBar.text, 'ZemDomu: all clear');

    tracker.beginScan('Discovering files...');
    tracker.failScan('The scan did not complete.');
    assert.strictEqual(statusBar.text, 'ZemDomu: scan failed');
    assert.ok(statusBar.accessibilityInformation.label.includes('scan failed'));

    const failedTooltip = statusBar.tooltip;
    tracker.updateScanPhase('An unrelated late progress update');
    assert.strictEqual(statusBar.tooltip, failedTooltip, 'Late progress must not replace a terminal failure');
    tracker.updateFile(first, [diagnostic('Missing alt')]);
    tracker.supersedeScan();
    assert.strictEqual(statusBar.text, 'ZemDomu: 1 finding');
    assert.ok(statusBar.accessibilityInformation.label.includes('1 finding currently reported'));
    tracker.updateFile(second, [diagnostic('Missing title')]);
    tracker.supersedeScan();
    assert.strictEqual(statusBar.text, 'ZemDomu: 2 findings');
    assert.ok(statusBar.accessibilityInformation.label.includes('2 findings currently reported'));
    tracker.clear();
    assert.strictEqual(statusBar.text, 'ZemDomu: all clear');
    assert.strictEqual(tracker.getTotalCount(), 0);

    for (let count = 1; count <= 7; count++) {
      tracker.updateFile(vscode.Uri.file(path.join('workspace', `Page${count}.html`)),
        Array.from({ length: count }, () => diagnostic('Missing alt')));
    }
    assert.strictEqual(statusBar.text, 'ZemDomu: 28 findings');
    assert.deepStrictEqual(statusBar.tooltip.split('\n').slice(1), [
      'Page7.html: 7', 'Page6.html: 6', 'Page5.html: 5', 'Page4.html: 4', 'Page3.html: 3',
    ], 'The tooltip must summarize the five files with the most findings');

    tracker.dispose();
    assert.ok(statusBar.disposed, 'disposing the tracker must dispose the status bar');
    console.log('Issue tracker status-bar tests passed');
  } catch (error) {
    console.error('Issue tracker status-bar tests failed');
    console.error(error);
    process.exitCode = 1;
  }
})();
