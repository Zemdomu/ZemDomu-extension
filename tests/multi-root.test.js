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

function codeOf(diag) {
  return diag.code && typeof diag.code === 'object' ? diag.code.value : diag.code;
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-multiroot-'));
  try {
    const rootA = path.join(tmpDir, 'workspace-a');
    const rootB = path.join(tmpDir, 'workspace-b');
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);

    const pageA = path.join(rootA, 'Page.jsx');
    const headingA = path.join(rootA, 'Heading.jsx');
    const pageB = path.join(rootB, 'Page.jsx');
    const headingB = path.join(rootB, 'Heading.jsx');
    fs.writeFileSync(pageA, "import Heading from './Heading'; export default function Page(){return <main><h1>A</h1><Heading /></main>}");
    fs.writeFileSync(headingA, 'export default function Heading(){return <h1>Nested A</h1>}');
    fs.writeFileSync(pageB, "import Heading from './Heading'; export default function Page(){return <main><h1>B</h1><Heading /></main>}");
    fs.writeFileSync(headingB, 'export default function Heading(){return <h2>Nested B</h2>}');

    vscode.__resetAll();
    vscode.workspace.__setWorkspaceFolders([
      { uri: vscode.Uri.file(rootA), name: 'workspace-a' },
      { uri: vscode.Uri.file(rootB), name: 'workspace-b' },
    ]);
    vscode.workspace.__setFindFiles('**/*.{html,jsx,tsx,vue}', [pageA, headingA, pageB, headingB]);

    const extension = require('../dist/extension.js');
    extension.activate({ extensionPath: path.resolve(__dirname, '..'), subscriptions: [] });
    await vscode.commands.__execute('zemdomu.lintWorkspace');

    const collection = vscode.languages.__getCollection('zemdomu');
    const aDiagnostics = collection.get(vscode.Uri.file(pageA)) ?? [];
    const bDiagnostics = collection.get(vscode.Uri.file(pageB)) ?? [];
    assert.ok(aDiagnostics.some(diag => codeOf(diag) === 'ZMD003'), 'Root A should report its nested h1');
    assert.ok(!bDiagnostics.some(diag => codeOf(diag) === 'ZMD003'), 'Root B should stay independent from Root A');

    const log = vscode.window.__getOutputChannel('ZemDomu');
    assert.ok(log.lines.some(line => line.includes(`rootDir=${rootA}`)), 'Expected Root A analysis root');
    assert.ok(log.lines.some(line => line.includes(`rootDir=${rootB}`)), 'Expected Root B analysis root');

    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir);
    const outsidePath = path.join(outsideDir, 'Outside.jsx');
    fs.writeFileSync(outsidePath, 'export default function Outside(){return <img />}');
    const outsideDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(outsidePath));
    await vscode.workspace.__fireDidSaveTextDocument(outsideDoc);
    assert.ok(
      log.lines.some(line => line.includes('cross=false') && line.includes(`rootDir=${outsideDir}`)),
      'Files outside workspace folders should use their directory and disable cross-component analysis'
    );

    console.log('Multi-root workspace tests passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
