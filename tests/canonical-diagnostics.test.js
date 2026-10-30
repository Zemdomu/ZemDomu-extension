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
const {
  canonicalDiagnosticToLintResult,
  canonicalDiagnosticToVscode,
  isCanonicalLintResult,
  lintProjectForPresentation,
} = require('../out/diagnostic-adapter.js');

const primaryFile = path.resolve('src', 'Page.jsx');
const componentFile = path.resolve('src', 'Header.jsx');
const diagnostic = {
  schemaVersion: '1.0',
  rule: 'requirePageH1',
  code: 'ZMD022',
  severity: 'error',
  message: 'The composed page has no H1 heading.',
  source: { file: primaryFile, line: 4, column: 6, offset: 42 },
  page: '/account',
  componentPath: ['Page', 'Layout', 'Header'],
  relatedLocations: [
    {
      source: { file: componentFile, line: 2, column: 3 },
      message: 'Header is composed here.',
    },
  ],
  preferredEditLocation: { file: componentFile, line: 8, column: 4 },
  suggestion: { message: 'Add one descriptive H1 to the page.' },
  provenance: { kind: 'cross-component', analyzer: 'page-model' },
  confidence: 'certain',
};

const lintResult = canonicalDiagnosticToLintResult(diagnostic);
assert.ok(isCanonicalLintResult(lintResult));
assert.strictEqual(lintResult.filePath, primaryFile);
assert.strictEqual(lintResult.offset, 42);
assert.strictEqual(lintResult.code, 'ZMD022');

const docsUri = vscode.Uri.parse('https://zemdomu.dev/docs/requirePageH1');
const mapped = canonicalDiagnosticToVscode(diagnostic, docsUri);
assert.strictEqual(mapped.severity, vscode.DiagnosticSeverity.Error);
assert.strictEqual(mapped.source, 'ZemDomu');
assert.strictEqual(mapped.code.value, 'ZMD022');
assert.strictEqual(mapped.code.target.toString(), docsUri.toString());
assert.strictEqual(mapped.range.start.line, 4);
assert.strictEqual(mapped.range.start.character, 6);
assert.match(mapped.message, /Page: \/account/);
assert.match(mapped.message, /Component path: Page → Layout → Header/);
assert.match(mapped.message, /Suggestion: Add one descriptive H1/);
assert.strictEqual(mapped.relatedInformation.length, 2);
assert.strictEqual(
  mapped.relatedInformation[0].location.uri.fsPath,
  componentFile
);
assert.strictEqual(
  mapped.relatedInformation[1].message,
  'Preferred edit location'
);

const informational = canonicalDiagnosticToVscode(
  { ...diagnostic, severity: 'info', relatedLocations: undefined, preferredEditLocation: undefined },
  null
);
assert.strictEqual(informational.severity, vscode.DiagnosticSeverity.Information);
assert.strictEqual(informational.code, 'ZMD022');

(async () => {
  let canonicalCalls = 0;
  const canonicalMap = await lintProjectForPresentation(
    {
      async lintPageDiagnostics(filePaths) {
        canonicalCalls += 1;
        assert.deepStrictEqual(filePaths, [primaryFile]);
        return [diagnostic];
      },
    },
    [primaryFile]
  );
  assert.strictEqual(canonicalCalls, 1);
  assert.ok(isCanonicalLintResult(canonicalMap.get(primaryFile)[0]));

  const dependencyDiagnostic = {
    ...diagnostic,
    severity: 'info',
    source: { file: componentFile, line: 1, column: 2 },
    relatedLocations: [{ source: { file: primaryFile, line: 0, column: 0 } }],
  };
  const dependencyMap = await lintProjectForPresentation({
    async lintPageDiagnostics() { return [dependencyDiagnostic]; },
  }, [primaryFile]);
  assert.deepStrictEqual(dependencyMap.get(primaryFile), [], 'Entries without findings must remain represented');
  const dependencyResult = dependencyMap.get(componentFile)[0];
  assert.strictEqual(dependencyResult.filePath, componentFile, 'Imported-file findings must be grouped under their actual file');
  assert.strictEqual(dependencyResult.severity, 'warning', 'Legacy presentation must retain an informational finding as a warning');
  assert.deepStrictEqual(dependencyResult.related, [{ filePath: primaryFile, line: 0, column: 0 }]);
  const dependencyVscode = canonicalDiagnosticToVscode(dependencyDiagnostic);
  assert.strictEqual(dependencyVscode.relatedInformation[0].message, 'Related location');
  assert.strictEqual(dependencyVscode.relatedInformation[0].location.uri.fsPath, primaryFile);

  // Generic callers retain the page-aware API. Only a fresh, explicitly
  // unconfigured instance may use Core's file-only canonical API.
  const localDiagnostic = {
    schemaVersion: '1.0', rule: 'requireAltText', code: 'ZMD004', severity: 'error',
    message: '<img> tag missing alt attribute',
    source: { file: componentFile, line: 3, column: 4, offset: 24 },
  };
  let pageCalls = 0;
  let fileCalls = 0;
  const dualApi = {
    async lintPageDiagnostics(paths) {
      pageCalls += 1;
      assert.deepStrictEqual(paths, [primaryFile]);
      return [diagnostic];
    },
    async lintFileDiagnostics(paths) {
      fileCalls += 1;
      assert.deepStrictEqual(paths, [primaryFile]);
      return [localDiagnostic];
    },
  };
  const defaultMap = await lintProjectForPresentation(dualApi, [primaryFile]);
  assert.strictEqual(pageCalls, 1);
  assert.strictEqual(fileCalls, 0);
  assert.strictEqual(defaultMap.get(primaryFile)[0].canonicalDiagnostic, diagnostic,
    'Default callers must retain complete page-aware canonical context');

  const fileMap = await lintProjectForPresentation(dualApi, [primaryFile], {
    freshInstance: true, options: { rules: { requireAltText: 'error' }, crossComponentAnalysis: true },
  });
  assert.strictEqual(pageCalls, 1);
  assert.strictEqual(fileCalls, 1);
  assert.deepStrictEqual(fileMap.get(primaryFile), []);
  assert.strictEqual(fileMap.get(componentFile)[0].canonicalDiagnostic, localDiagnostic);
  assert.strictEqual(fileMap.get(componentFile)[0].offset, 24);

  for (const context of [
    { freshInstance: false, options: {} },
    { freshInstance: true },
    { freshInstance: true, options: { pages: [{ id: 'configured' }] } },
    { freshInstance: true, options: { routeAdapters: [{}] } },
    { freshInstance: true, options: { customRules: [{ name: 'custom', analyzePage() {} }] } },
    { freshInstance: true, options: { customRules: [{ name: 'custom', init() {} }] } },
  ]) {
    const beforePages = pageCalls;
    const beforeFiles = fileCalls;
    const map = await lintProjectForPresentation(dualApi, [primaryFile], context);
    assert.strictEqual(pageCalls, beforePages + 1, 'Configured/custom/uncertain callers must retain page API');
    assert.strictEqual(fileCalls, beforeFiles);
    assert.strictEqual(map.get(primaryFile)[0].canonicalDiagnostic, diagnostic);
  }

  const beforeEmptyOptions = fileCalls;
  await lintProjectForPresentation(dualApi, [primaryFile], {
    freshInstance: true, options: { pages: [], routeAdapters: [], customRules: [] },
  });
  assert.strictEqual(fileCalls, beforeEmptyOptions + 1, 'Empty configuration arrays remain unconfigured');

  let compatibleCalls = 0;
  await lintProjectForPresentation({
    async lintPageDiagnostics() { compatibleCalls += 1; return [diagnostic]; },
  }, [primaryFile], { freshInstance: true, options: {} });
  assert.strictEqual(compatibleCalls, 1, 'Older Core-compatible linter implementations retain page API');

  const failure = new Error('File scan failed');
  let fallbackCalls = 0;
  await assert.rejects(lintProjectForPresentation({
    async lintFileDiagnostics() { throw failure; },
    async lintPageDiagnostics() { fallbackCalls += 1; return []; },
  }, [primaryFile], { freshInstance: true, options: {} }), error => error === failure);
  assert.strictEqual(fallbackCalls, 0, 'Do not retry failures through another API or hide recovery errors');

  const { ProjectLinter } = require('zemdomu');
  assert.strictEqual(typeof ProjectLinter.prototype.lintFileDiagnostics, 'function',
    'The release candidate must include the tested canonical file API');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-canonical-file-flow-'));
  const pageFile = path.join(workspace, 'Page.jsx');
  const childFile = path.join(workspace, 'Child.jsx');
  fs.writeFileSync(pageFile, "import Child from './Child'; export default () => <main><h1>Page</h1><Child/></main>;");
  fs.writeFileSync(childFile, 'export default () => <><h1>Child</h1><img src="portrait.png"/></>;');
  const ruleNames = Object.keys(require('../package.json').contributes.configuration.properties)
    .filter(name => name.startsWith('zemdomu.rules.')).map(name => name.slice('zemdomu.rules.'.length));
  const rules = Object.fromEntries(ruleNames.map(name => [name, 'warning']));
  const expected = await new ProjectLinter({
    rootDir: workspace, rules, crossComponentAnalysis: true, crossComponentDepth: 50,
  }).lintPageDiagnostics([pageFile, childFile]);
  const oldPageApi = ProjectLinter.prototype.lintPageDiagnostics;
  const oldFileApi = ProjectLinter.prototype.lintFileDiagnostics;
  let workspaceFileCalls = 0;
  let failNextFileScan = false;
  const scanFailure = new Error('Canonical file scan failed');
  const context = { extensionPath: path.resolve(__dirname, '..'), subscriptions: [] };
  try {
    ProjectLinter.prototype.lintPageDiagnostics = async function () {
      throw new Error('Disposable unconfigured workspace must not compose pages');
    };
    ProjectLinter.prototype.lintFileDiagnostics = async function (...args) {
      workspaceFileCalls += 1;
      if (failNextFileScan) { failNextFileScan = false; throw scanFailure; }
      return oldFileApi.apply(this, args);
    };
    vscode.__resetAll();
    vscode.workspace.__setWorkspaceFolders([{ uri: vscode.Uri.file(workspace) }]);
    vscode.workspace.__setFindFiles('**/*.{html,jsx,tsx,vue}', [pageFile, childFile]);
    // The unbundled production source shares the actual Core instance above,
    // allowing the test to observe which public API the workspace calls.
    const extension = require('../out/extension.js');
    extension.activate(context);
    assert.strictEqual(await vscode.commands.__execute('zemdomu.lintWorkspace'), 'Scan complete');
    assert.strictEqual(workspaceFileCalls, 1);
    const collection = vscode.languages.__getCollection('zemdomu');
    const serialized = diagnostics => diagnostics.map(item => JSON.stringify(item)).sort();
    for (const filename of [pageFile, childFile]) {
      const expectedForFile = expected.filter(item => item.source.file === filename)
        .map(item => canonicalDiagnosticToVscode(item,
          vscode.Uri.parse(`https://zemdomu.dev/docs/${encodeURIComponent(item.rule)}`)));
      assert.deepStrictEqual(serialized(collection.get(vscode.Uri.file(filename)) ?? []),
        serialized(expectedForFile), 'All published fields must equal the existing page API for unconfigured scans');
    }

    const previous = collection.get(vscode.Uri.file(childFile));
    failNextFileScan = true;
    await assert.rejects(vscode.commands.__execute('zemdomu.lintWorkspace'), error => error === scanFailure);
    assert.strictEqual(collection.get(vscode.Uri.file(childFile)), previous,
      'A file-API failure must preserve last-known diagnostics');
    assert.strictEqual(await vscode.commands.__execute('zemdomu.lintWorkspace'), 'Scan complete');
    assert.strictEqual(workspaceFileCalls, 3, 'The same command must recover after a file-API failure');

    vscode.workspace.__setConfiguration('severity.requireAltText', 'error');
    await vscode.workspace.__fireDidChangeConfiguration('zemdomu.severity.requireAltText');
    await vscode.commands.__execute('zemdomu.lintWorkspace');
    const missingAlt = (collection.get(vscode.Uri.file(childFile)) ?? [])
      .find(item => item.code?.value === 'ZMD004');
    assert.strictEqual(missingAlt.severity, vscode.DiagnosticSeverity.Error);
    vscode.workspace.__setConfiguration('rules.requireAltText', false);
    await vscode.workspace.__fireDidChangeConfiguration('zemdomu.rules.requireAltText');
    await vscode.commands.__execute('zemdomu.lintWorkspace');
    assert.ok(!(collection.get(vscode.Uri.file(childFile)) ?? []).some(item => item.code?.value === 'ZMD004'),
      'Disabling a rule must clear its stale finding through the file API');
  } finally {
    ProjectLinter.prototype.lintPageDiagnostics = oldPageApi;
    ProjectLinter.prototype.lintFileDiagnostics = oldFileApi;
    for (const disposable of [...context.subscriptions].reverse()) disposable?.dispose?.();
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  console.log('Canonical diagnostic adapter tests passed');
})().catch((error) => {
  console.error('Canonical diagnostic adapter tests failed');
  console.error(error);
  process.exitCode = 1;
});
