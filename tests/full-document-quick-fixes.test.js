const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { parse } = require('@babel/parser');
const parse5 = require('parse5');
const { ProjectLinter } = require(
  process.env.ZEMDOMU_CORE_ENTRY || 'zemdomu'
);

const stubsPath = path.join(__dirname, 'stubs');
process.env.NODE_PATH = process.env.NODE_PATH
  ? `${stubsPath}${path.delimiter}${process.env.NODE_PATH}`
  : stubsPath;
Module._initPaths();

const vscode = require('vscode');

function offsetAt(text, position) {
  const lines = text.split(/\r?\n/);
  const newline = text.includes('\r\n') ? 2 : 1;
  let offset = 0;
  for (let line = 0; line < position.line; line++) offset += lines[line].length + newline;
  return offset + position.character;
}

function applyEdit(text, edit) {
  const operations = edit.operations.map((operation, index) => {
    if (operation.type === 'insert') {
      const at = offsetAt(text, operation.position);
      return { start: at, end: at, value: operation.value, index };
    }
    return {
      start: offsetAt(text, operation.range.start),
      end: offsetAt(text, operation.range.end),
      value: operation.value,
      index,
    };
  }).sort((a, b) => b.start - a.start || b.end - a.end || b.index - a.index);
  return operations.reduce(
    (current, operation) => current.slice(0, operation.start) + operation.value + current.slice(operation.end),
    text
  );
}

function diagnosticFromCore(result) {
  const start = new vscode.Position(result.line, result.column);
  const diag = new vscode.Diagnostic(
    new vscode.Range(start, new vscode.Position(result.line, result.column + 1)),
    result.message
  );
  diag.code = result.code || result.rule;
  return diag;
}

function assertParseable(fileName, source) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.jsx' || ext === '.tsx') {
    const plugins = ['jsx'];
    if (ext === '.tsx') plugins.push('typescript');
    assert.doesNotThrow(
      () => parse(source, { sourceType: 'module', plugins }),
      `${fileName}: transformed JSX/TSX should parse`
    );
    return;
  }

  const markup = ext === '.vue'
    ? source.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i)?.[1]
    : source;
  assert.ok(markup !== undefined, `${fileName}: expected a Vue <template>`);
  const errors = [];
  parse5.parseFragment(markup, { onParseError: error => errors.push(error) });
  assert.deepStrictEqual(errors, [], `${fileName}: transformed markup should parse`);
}

async function assertQuickFixRoundTrip(provider, tmpDir, testCase) {
  const filePath = path.join(tmpDir, testCase.fileName);
  fs.writeFileSync(filePath, testCase.source, 'utf8');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const core = new ProjectLinter({
    rootDir: tmpDir,
    rules: {
      [testCase.rule]: 'warning',
      preventZemdomuPlaceholders: 'warning',
    },
  });
  const resultMap = await core.lintFile(filePath, testCase.source);
  const result = (resultMap.get(filePath) || []).find(item => item.rule === testCase.rule);
  assert.ok(result, `${testCase.name}: expected a real Core ${testCase.rule} diagnostic`);

  const diagnostic = diagnosticFromCore(result);
  const actions = provider.provideCodeActions(doc, diagnostic.range, { diagnostics: [diagnostic] }) || [];
  const action = actions.find(item => item.title === testCase.title);
  assert.ok(action && action.edit, `${testCase.name}: expected quick fix "${testCase.title}"`);

  const transformed = applyEdit(testCase.source, action.edit);
  assert.strictEqual(
    transformed,
    testCase.expected,
    `${testCase.name}: quick fix should only produce the audited full-document edit`
  );
  assertParseable(testCase.fileName, transformed);

  const fixedMap = await core.lintFile(filePath, transformed);
  const fixedResults = fixedMap.get(filePath) || [];
  if (!testCase.allowTargetDiagnostic) {
    assert.ok(
      !fixedResults.some(item => item.rule === testCase.rule),
      `${testCase.name}: re-linting should clear ${testCase.rule}`
    );
  }
  assert.ok(
    fixedResults.some(item => item.rule === 'preventZemdomuPlaceholders'),
    `${testCase.name}: placeholder diagnostic should keep the generated value visible for author review`
  );
}

async function assertNoQuickFix(provider, tmpDir, testCase) {
  const filePath = path.join(tmpDir, testCase.fileName);
  fs.writeFileSync(filePath, testCase.source, 'utf8');
  assertParseable(testCase.fileName, testCase.source);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const core = new ProjectLinter({
    rootDir: tmpDir,
    rules: { [testCase.rule]: 'warning' },
  });
  const resultMap = await core.lintFile(filePath, testCase.source);
  const targetResults = (resultMap.get(filePath) || []).filter(
    item => item.rule === testCase.rule
  );
  const result = targetResults[0];
  assert.ok(result, `${testCase.name}: expected a real Core ${testCase.rule} diagnostic`);
  const diagnostics = testCase.useAllTargetDiagnostics
    ? targetResults.map(diagnosticFromCore)
    : [diagnosticFromCore(result)];
  if (testCase.forceIndistinguishableDiagnostics) {
    for (const diagnostic of diagnostics) {
      diagnostic.range = diagnostics[0].range;
    }
  }
  const actions = provider.provideCodeActions(
    doc,
    diagnostics[0].range,
    { diagnostics }
  ) || [];
  assert.deepStrictEqual(
    actions.map(action => action.title),
    [],
    `${testCase.name}: semantic intent or an ambiguous target must not be guessed`
  );
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-real-quickfix-'));
  try {
    vscode.__resetAll();
    vscode.workspace.__setWorkspaceFolders([{ uri: vscode.Uri.file(tmpDir) }]);
    const extension = require(
      process.env.ZEMDOMU_EXTENSION_ENTRY || '../dist/extension.js'
    );
    extension.activate({ extensionPath: path.resolve(__dirname, '..'), subscriptions: [] });
    const provider = vscode.languages.__getCodeActionProviders()[0].provider;

    const source = [
      '<!doctype html>',
      '<html lang="en">',
      '<head><title>Report</title></head>',
      '<body>',
      '  <main>',
      '    <table class="results">',
      '      <tr><td>One</td></tr>',
      '    </table>',
      '  </main>',
      '</body>',
      '</html>',
    ].join('\r\n');
    const filePath = path.join(tmpDir, 'report.html');
    fs.writeFileSync(filePath, source, 'utf8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const core = new ProjectLinter({
      rootDir: tmpDir,
      rules: { requireTableCaption: 'warning' },
    });
    const resultMap = await core.lintFile(filePath, source);
    const result = (resultMap.get(filePath) || []).find(item => item.rule === 'requireTableCaption');
    assert.ok(result, 'Expected a real Core table-caption diagnostic');

    const diagnostic = diagnosticFromCore(result);
    const actions = provider.provideCodeActions(doc, diagnostic.range, { diagnostics: [diagnostic] }) || [];
    const action = actions.find(item => item.title === 'Add <caption>TODO-ZMD</caption>');
    assert.ok(action && action.edit, 'Expected table-caption quick fix from the Core diagnostic');

    const transformed = applyEdit(source, action.edit);
    assert.strictEqual(
      transformed,
      source.replace(
        '    <table class="results">',
        '    <table class="results">\r\n      <caption>TODO-ZMD</caption>'
      ),
      'The full-document edit should use the absolute table tag offset with CRLF positions'
    );

    const fixedMap = await core.lintFile(filePath, transformed);
    assert.ok(
      !(fixedMap.get(filePath) || []).some(item => item.rule === 'requireTableCaption'),
      'Re-linting the edited full document should clear requireTableCaption'
    );

    const emptyAttributeCases = [
      {
        name: 'empty href',
        fileName: 'empty-href.html',
        source: '<a href="">Link</a>',
        rule: 'requireHrefOnAnchors',
        title: 'Add href="TODO-ZMD"',
        expected: '<a href="TODO-ZMD">Link</a>',
      },
      {
        name: 'empty iframe title',
        fileName: 'empty-iframe-title.html',
        source: '<iframe title=""></iframe>',
        rule: 'requireIframeTitle',
        title: 'Add title="TODO-ZMD"',
        expected: '<iframe title="TODO-ZMD"></iframe>',
      },
      {
        name: 'empty document language',
        fileName: 'empty-lang.html',
        source: '<html lang=""><head><title>Page</title></head><body><main>Body</main></body></html>',
        rule: 'requireHtmlLang',
        title: 'Add lang="TODO-ZMD"',
        expected: '<html lang="TODO-ZMD"><head><title>Page</title></head><body><main>Body</main></body></html>',
      },
      {
        name: 'empty button aria-label',
        fileName: 'empty-button-label.html',
        source: '<button aria-label=""></button>',
        rule: 'requireButtonText',
        title: 'Add aria-label="TODO-ZMD"',
        expected: '<button aria-label="TODO-ZMD"></button>',
      },
      {
        name: 'empty image-input alt',
        fileName: 'empty-image-input-alt.html',
        source: '<input type="image" alt="">',
        rule: 'requireImageInputAlt',
        title: 'Add alt="TODO-ZMD"',
        expected: '<input type="image" alt="TODO-ZMD">',
      },
    ];

    for (const testCase of emptyAttributeCases) {
      await assertQuickFixRoundTrip(provider, tmpDir, testCase);
    }

    const safetyContractCases = [
      {
        name: 'section with non-heading child',
        fileName: 'section-label.html',
        source: '<section><p id="overview">Overview</p></section>',
        rule: 'requireSectionHeading',
        title: 'Add aria-label="TODO-ZMD"',
        expected: '<section aria-label="TODO-ZMD"><p id="overview">Overview</p></section>',
      },
      {
        name: 'Vue list wrapper carries review marker',
        fileName: 'list.vue',
        source: '<template>\n  <li>Item</li>\n</template>',
        rule: 'enforceListNesting',
        title: 'Wrap with <ul> and TODO-ZMD review marker',
        expected: '<template>\n  <ul data-zemdomu-todo="TODO-ZMD">\n  <li>Item</li>\n  </ul>\n</template>',
      },
      {
        name: 'TSX nav link placeholder',
        fileName: 'navigation.tsx',
        source: 'const View = () => <nav></nav>;',
        rule: 'requireNavLinks',
        title: 'Add <a href="TODO-ZMD"> inside <nav>',
        expected: 'const View = () => <nav>\n  <a href="TODO-ZMD">TODO-ZMD</a></nav>;',
      },
      {
        name: 'missing document title',
        fileName: 'missing-title.html',
        source: '<html lang="en">\n<head></head>\n<body><main>Body</main></body>\n</html>',
        rule: 'requireDocumentTitle',
        title: 'Add <title>TODO-ZMD</title>',
        expected: '<html lang="en">\n<head>\n  <title>TODO-ZMD</title></head>\n<body><main>Body</main></body>\n</html>',
      },
      {
        name: 'empty document title',
        fileName: 'empty-title.html',
        source: '<html lang="en"><head><title> </title></head><body><main>Body</main></body></html>',
        rule: 'requireDocumentTitle',
        title: 'Fill <title> with "TODO-ZMD"',
        expected: '<html lang="en"><head><title>TODO-ZMD</title></head><body><main>Body</main></body></html>',
      },
      {
        name: 'missing main landmark',
        fileName: 'missing-main.html',
        source: '<html lang="en"><head><title>Page</title></head><body><section>Body</section></body></html>',
        rule: 'requireSingleMain',
        title: 'Add <main>TODO-ZMD</main>',
        expected: '<html lang="en"><head><title>Page</title></head><body>\n  <main>TODO-ZMD</main><section>Body</section></body></html>',
      },
      {
        name: 'invalid ARIA state requires author review',
        fileName: 'aria-state.jsx',
        source: 'const View = () => <div aria-hidden="maybe" />;',
        rule: 'ariaValidAttrValue',
        title: 'Replace aria-hidden with "TODO-ZMD" for review',
        expected: 'const View = () => <div aria-hidden="TODO-ZMD" />;',
        allowTargetDiagnostic: true,
      },
      {
        name: 'TSX form control placeholder',
        fileName: 'control.tsx',
        source: 'const View = () => <input type="number" onChange={(event) => setPrice(event.currentTarget.value)} />;',
        rule: 'requireLabelForFormControls',
        title: 'Add aria-label="TODO-ZMD"',
        expected: 'const View = () => <input type="number" onChange={(event) => setPrice(event.currentTarget.value)} aria-label="TODO-ZMD" />;',
      },
      {
        name: 'JSX image placeholder',
        fileName: 'image.jsx',
        source: 'const View = () => <img src="x" />;',
        rule: 'requireAltText',
        title: 'Add alt="TODO-ZMD"',
        expected: 'const View = () => <img src="x" alt="TODO-ZMD" />;',
      },
      {
        name: 'Vue link accessible-name placeholder',
        fileName: 'link.vue',
        source: '<template><a href="/home"></a></template>',
        rule: 'requireLinkText',
        title: 'Add aria-label="TODO-ZMD"',
        expected: '<template><a href="/home" aria-label="TODO-ZMD"></a></template>',
      },
      {
        name: 'Vue iframe title placeholder',
        fileName: 'frame.vue',
        source: '<template><iframe></iframe></template>',
        rule: 'requireIframeTitle',
        title: 'Add title="TODO-ZMD"',
        expected: '<template><iframe title="TODO-ZMD"></iframe></template>',
      },
    ];

    for (const testCase of safetyContractCases) {
      await assertQuickFixRoundTrip(provider, tmpDir, testCase);
    }

    const manualRemediationCases = [
      {
        name: 'heading order',
        fileName: 'manual-heading-order.html',
        source: '<h2>Section</h2><h4>Detail</h4>',
        rule: 'enforceHeadingOrder',
      },
      {
        name: 'duplicate h1',
        fileName: 'manual-single-h1.html',
        source: '<h1>First</h1><h1>Second</h1>',
        rule: 'singleH1',
      },
      {
        name: 'positive tabindex',
        fileName: 'manual-tabindex.html',
        source: '<button tabindex="2">Continue</button>',
        rule: 'noTabindexGreaterThanZero',
      },
      {
        name: 'duplicate main landmark',
        fileName: 'manual-main.html',
        source: '<html lang="en"><head><title>Page</title></head><body><main>One</main><main>Two</main></body></html>',
        rule: 'requireSingleMain',
      },
      {
        name: 'ambiguous table target',
        fileName: 'manual-table-target.html',
        source: '<table><tr><td>One</td></tr></table><table><tr><td>Two</td></tr></table>',
        rule: 'requireTableCaption',
        useAllTargetDiagnostics: true,
        forceIndistinguishableDiagnostics: true,
      },
    ];

    for (const testCase of manualRemediationCases) {
      await assertNoQuickFix(provider, tmpDir, testCase);
    }

    const inlineListSource = 'const App = () => { return <div><li>Item</li></div>; };';
    assert.doesNotThrow(
      () => parse(inlineListSource, { sourceType: 'module', plugins: ['jsx'] }),
      'Inline JSX list regression source should be parseable before requesting quick fixes'
    );
    assert.throws(
      () => parse(`<ul>\n${inlineListSource}\n</ul>`, { sourceType: 'module', plugins: ['jsx'] }),
      'Wrapping the complete JavaScript line in <ul> should be recognized as invalid JSX'
    );

    const inlineListPath = path.join(tmpDir, 'inline-list.jsx');
    fs.writeFileSync(inlineListPath, inlineListSource, 'utf8');
    const inlineListDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(inlineListPath));
    const listCore = new ProjectLinter({
      rootDir: tmpDir,
      rules: { enforceListNesting: 'warning' },
    });
    const listMap = await listCore.lintFile(inlineListPath, inlineListSource);
    const listResult = (listMap.get(inlineListPath) || []).find(
      item => item.rule === 'enforceListNesting'
    );
    assert.ok(listResult, 'Expected a real Core inline JSX list-nesting diagnostic');
    const listDiagnostic = diagnosticFromCore(listResult);
    const listActions =
      provider.provideCodeActions(
        inlineListDoc,
        listDiagnostic.range,
        { diagnostics: [listDiagnostic] }
      ) || [];
    assert.ok(
      !listActions.some(item => item.title.startsWith('Wrap with <ul>')),
      'Unsafe line-based <ul> wrapping should not be offered for inline JSX'
    );

    console.log('Full-document quick-fix regressions passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
