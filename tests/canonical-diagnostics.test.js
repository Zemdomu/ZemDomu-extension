const assert = require('assert');
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
  let legacyCalls = 0;
  const canonicalMap = await lintProjectForPresentation(
    {
      async lintFiles() {
        legacyCalls += 1;
        return new Map();
      },
      async lintPageDiagnostics(filePaths) {
        canonicalCalls += 1;
        assert.deepStrictEqual(filePaths, [primaryFile]);
        return [diagnostic];
      },
    },
    [primaryFile]
  );
  assert.strictEqual(canonicalCalls, 1);
  assert.strictEqual(legacyCalls, 0);
  assert.ok(isCanonicalLintResult(canonicalMap.get(primaryFile)[0]));

  const legacyResult = {
    line: 0,
    column: 0,
    rule: 'requireAltText',
    message: 'Missing alt text.',
  };
  const legacyMap = await lintProjectForPresentation(
    {
      async lintFiles(filePaths) {
        legacyCalls += 1;
        return new Map([[filePaths[0], [legacyResult]]]);
      },
    },
    [primaryFile]
  );
  assert.strictEqual(legacyCalls, 1);
  assert.strictEqual(legacyMap.get(primaryFile)[0], legacyResult);

  console.log('Canonical diagnostic adapter tests passed');
})().catch((error) => {
  console.error('Canonical diagnostic adapter tests failed');
  console.error(error);
  process.exitCode = 1;
});
