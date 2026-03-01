const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { lint } = require('zemdomu');

const stubsPath = path.join(__dirname, 'stubs');
process.env.NODE_PATH = process.env.NODE_PATH
  ? `${stubsPath}${path.delimiter}${process.env.NODE_PATH}`
  : stubsPath;
Module._initPaths();

process.env.ZEMDOMU_SKIP_STARTUP_SCAN = '1';

const vscode = require('vscode');

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, '\n');
}

function positionAt(text, index) {
  const before = text.slice(0, index);
  const lines = before.split(/\r?\n/);
  return {
    line: lines.length - 1,
    col: lines[lines.length - 1].length,
  };
}

function offsetAt(text, pos) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < pos.line && i < lines.length; i++) {
    offset += lines[i].length + newline.length;
  }
  if (pos.line < lines.length) {
    offset += Math.min(pos.character, lines[pos.line].length);
  }
  return offset;
}

function findPosition(text, needle) {
  const idx = text.indexOf(needle);
  assert.ok(idx >= 0, `Expected to find "${needle}" in document`);
  return positionAt(text, idx);
}

function openDoc(tmpDir, fileName, content) {
  const filePath = path.join(tmpDir, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
}

function getProvider() {
  const providers = vscode.languages.__getCodeActionProviders();
  assert.ok(providers.length > 0, 'Expected code action provider to be registered');
  return providers[0].provider;
}

function createDiagnostic(doc, lintResult, anchor) {
  const text = doc.getText();
  let line = Number.isFinite(lintResult.line) ? lintResult.line : 0;
  let col = Number.isFinite(lintResult.column) ? lintResult.column : 0;

  if (anchor) {
    const anchorPos = findPosition(text, anchor);
    line = anchorPos.line;
    col = anchorPos.col;
  }

  const start = new vscode.Position(line, col);
  const end = new vscode.Position(line, col + 1);
  const diag = new vscode.Diagnostic(new vscode.Range(start, end), lintResult.message);
  diag.code = lintResult.code || lintResult.rule;
  return diag;
}

function applyOperations(text, operations) {
  if (!operations || operations.length === 0) return text;

  const normalized = operations
    .map((op, idx) => {
      if (op.type === 'insert') {
        const at = offsetAt(text, op.position);
        return { start: at, end: at, value: op.value, idx };
      }
      if (op.type === 'replace') {
        const start = offsetAt(text, op.range.start);
        const end = offsetAt(text, op.range.end);
        return { start, end, value: op.value, idx };
      }
      throw new Error(`Unsupported edit operation type: ${op.type}`);
    })
    .sort((a, b) => {
      if (a.start !== b.start) return b.start - a.start;
      if (a.end !== b.end) return b.end - a.end;
      return b.idx - a.idx;
    });

  let output = text;
  for (const op of normalized) {
    output = `${output.slice(0, op.start)}${op.value}${output.slice(op.end)}`;
  }
  return output;
}

function selectLintResult(results, quickFix) {
  const candidates = results.filter((result) => result.rule === quickFix.rule);
  assert.ok(
    candidates.length > 0,
    `Expected lint result for rule "${quickFix.rule}" before quick-fix assertion`
  );

  if (!quickFix.messageIncludes) {
    return candidates[0];
  }

  const matched = candidates.find((result) => result.message.includes(quickFix.messageIncludes));
  assert.ok(
    matched,
    `Expected message containing "${quickFix.messageIncludes}" for rule "${quickFix.rule}"`
  );
  return matched;
}

async function runCase(provider, tmpDir, fixtureName, testCase, caseIndex) {
  assert.ok(testCase.name, `Fixture ${fixtureName} case #${caseIndex + 1} is missing "name"`);
  assert.ok(testCase.fileName, `Fixture ${fixtureName}/${testCase.name} is missing "fileName"`);
  assert.ok(typeof testCase.source === 'string', `Fixture ${fixtureName}/${testCase.name} is missing "source"`);

  const lintOptions = testCase.lintOptions || {};
  const lintInputOptions = {
    ...lintOptions,
    filePath: lintOptions.filePath || testCase.fileName,
  };
  const lintResults = lint(testCase.source, lintInputOptions);

  const expectedRules = testCase.expectRules || [];
  for (const rule of expectedRules) {
    assert.ok(
      lintResults.some((result) => result.rule === rule),
      `${fixtureName}/${testCase.name}: expected rule "${rule}" to be reported`
    );
  }

  const forbiddenRules = testCase.forbidRules || [];
  for (const rule of forbiddenRules) {
    assert.ok(
      !lintResults.some((result) => result.rule === rule),
      `${fixtureName}/${testCase.name}: expected rule "${rule}" to be absent`
    );
  }

  const expectedDiagnosticCount = testCase.expectedDiagnosticCount;
  if (Number.isInteger(expectedDiagnosticCount)) {
    assert.strictEqual(
      lintResults.length,
      expectedDiagnosticCount,
      `${fixtureName}/${testCase.name}: expected ${expectedDiagnosticCount} diagnostics, got ${lintResults.length}`
    );
  }

  const doc = await openDoc(tmpDir, testCase.fileName, testCase.source);
  const originalText = doc.getText();

  for (const quickFix of testCase.quickFixes || []) {
    const lintResult = selectLintResult(lintResults, quickFix);
    const diagnostic = createDiagnostic(doc, lintResult, quickFix.anchor);
    const actions =
      provider.provideCodeActions(doc, diagnostic.range, { diagnostics: [diagnostic] }) || [];

    const action = actions.find((candidate) => candidate.title === quickFix.title);
    assert.ok(
      action,
      `${fixtureName}/${testCase.name}: expected quick fix "${quickFix.title}"`
    );
    assert.ok(action.edit, `${fixtureName}/${testCase.name}: quick fix "${quickFix.title}" has no edit`);

    const transformed = applyOperations(originalText, action.edit.operations || []);

    if (typeof quickFix.expected === 'string') {
      assert.strictEqual(
        normalizeNewlines(transformed),
        normalizeNewlines(quickFix.expected),
        `${fixtureName}/${testCase.name}: quick fix "${quickFix.title}" produced unexpected output`
      );
    }

    for (const snippet of quickFix.expectedIncludes || []) {
      assert.ok(
        transformed.includes(snippet),
        `${fixtureName}/${testCase.name}: quick fix "${quickFix.title}" missing snippet "${snippet}"`
      );
    }
  }
}

function loadFixtureFiles(fixturesDir) {
  return fs
    .readdirSync(fixturesDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

(async () => {
  const fixturesDir = path.join(__dirname, 'fixtures', 'behavior');
  const fixtureFiles = loadFixtureFiles(fixturesDir);
  assert.ok(fixtureFiles.length > 0, 'Expected at least one behavior fixture file');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-fixtures-'));
  try {
    vscode.__resetAll();
    vscode.workspace.__setWorkspaceFolders([{ uri: vscode.Uri.file(tmpDir) }]);

    const context = {
      extensionPath: path.resolve(__dirname, '..'),
      subscriptions: [],
    };

    const extension = require('../dist/extension.js');
    extension.activate(context);

    const provider = getProvider();

    for (const fixtureFile of fixtureFiles) {
      const fixturePath = path.join(fixturesDir, fixtureFile);
      const raw = fs.readFileSync(fixturePath, 'utf8');
      const parsed = JSON.parse(raw);
      const cases = Array.isArray(parsed) ? parsed : parsed.cases;
      assert.ok(Array.isArray(cases), `${fixtureFile}: expected top-level array or "cases" array`);

      for (let i = 0; i < cases.length; i++) {
        await runCase(provider, tmpDir, fixtureFile, cases[i], i);
      }
    }

    console.log('Fixture behavior tests passed');
  } catch (error) {
    console.error('Fixture behavior tests failed');
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})();
