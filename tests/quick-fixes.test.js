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

function positionAt(text, index) {
  const before = text.slice(0, index);
  const lines = before.split(/\r?\n/);
  return {
    line: lines.length - 1,
    col: lines[lines.length - 1].length,
  };
}

function findPosition(text, needle, fromIndex = 0) {
  const idx = text.indexOf(needle, fromIndex);
  assert.ok(idx >= 0, `Expected to find "${needle}" in document`);
  return { ...positionAt(text, idx), index: idx };
}

async function openDoc(tmpDir, name, ext, content) {
  const filePath = path.join(tmpDir, `${name}${ext}`);
  fs.writeFileSync(filePath, content, 'utf8');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  return { doc, filePath };
}

function getProvider() {
  const providers = vscode.languages.__getCodeActionProviders();
  assert.ok(providers.length > 0, 'Expected code action provider to be registered');
  return providers[0].provider;
}

function getAction(provider, doc, diag, title) {
  const actions =
    provider.provideCodeActions(
      doc,
      diag.range,
      { diagnostics: [diag] }
    ) || [];
  const action = actions.find(a => a.title === title);
  assert.ok(action, `Expected quick fix "${title}" to be available`);
  return action;
}

function makeDiagnostic(doc, message, needle) {
  const text = doc.getText();
  const pos = findPosition(text, needle);
  const start = new vscode.Position(pos.line, pos.col);
  const range = new vscode.Range(start, new vscode.Position(pos.line, pos.col + 1));
  return new vscode.Diagnostic(range, message);
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-quickfix-'));
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

    // ZMD001 - requireSectionHeading (aria-labelledby when child exists)
    {
      const content = '<section>\n  <p>Hi</p>\n</section>';
      const { doc } = await openDoc(tmpDir, 'section', '.html', content);
      const diag = makeDiagnostic(
        doc,
        '<section> missing heading (<h1>-<h6>) or accessible label (aria-label / aria-labelledby)',
        '<section>'
      );
      const action = getAction(provider, doc, diag, 'Add aria-labelledby="TODO-ZMD"');
      const inserts = action.edit.operations.filter(op => op.type === 'insert');
      assert.ok(inserts.some(op => op.value.includes('aria-labelledby="TODO-ZMD"')));
      assert.ok(inserts.some(op => op.value.includes('id="TODO-ZMD"')));
    }

    // ZMD001 - requireSectionHeading (aria-label when empty)
    {
      const content = '<section></section>';
      const { doc } = await openDoc(tmpDir, 'section-empty', '.html', content);
      const diag = makeDiagnostic(
        doc,
        '<section> missing heading (<h1>-<h6>) or accessible label (aria-label / aria-labelledby)',
        '<section>'
      );
      const action = getAction(provider, doc, diag, 'Add aria-label="TODO-ZMD"');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('aria-label="TODO-ZMD"'));
    }

    // ZMD002 - enforceHeadingOrder
    {
      const content = '<h2>Main section</h2>\n<h4>Subpoint</h4>';
      const { doc } = await openDoc(tmpDir, 'heading-order', '.html', content);
      const diag = makeDiagnostic(
        doc,
        'Heading level skipped: <h4> after <h2>',
        '<h4>'
      );
      const action = getAction(provider, doc, diag, 'Change to <h3>');
      const replaces = action.edit.operations.filter(op => op.type === 'replace');
      assert.ok(replaces.length >= 2, 'Expected opening and closing tag replacement');
      replaces.forEach(op => assert.strictEqual(op.value, 'h3'));
    }

    // ZMD003 - singleH1
    {
      const content = '<h1>First</h1>\n<h1>Second</h1>';
      const { doc } = await openDoc(tmpDir, 'single-h1', '.html', content);
      const diag = makeDiagnostic(
        doc,
        'Only one <h1> allowed per document',
        '<h1>Second'
      );
      const action = getAction(provider, doc, diag, 'Change to <h2>');
      const replaces = action.edit.operations.filter(op => op.type === 'replace');
      assert.ok(replaces.length >= 2, 'Expected opening and closing tag replacement');
      replaces.forEach(op => assert.strictEqual(op.value, 'h2'));
    }

    // ZMD004 - requireAltText
    {
      const content = '<img src="x">';
      const { doc } = await openDoc(tmpDir, 'img-alt', '.html', content);
      const diag = makeDiagnostic(
        doc,
        '<img> tag missing or empty alt attribute',
        '<img'
      );
      const action = getAction(provider, doc, diag, 'Add alt="TODO-ZMD"');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('alt="TODO-ZMD"'));
    }

    // ZMD005 - requireLabelForFormControls
    {
      const content = '<input type="text">';
      const { doc } = await openDoc(tmpDir, 'form-label', '.html', content);
      const diag = makeDiagnostic(
        doc,
        'Form control missing id or aria-label',
        '<input'
      );
      const ariaAction = getAction(provider, doc, diag, 'Add aria-label="TODO-ZMD"');
      const ariaInsert = ariaAction.edit.operations.find(op => op.type === 'insert');
      assert.ok(ariaInsert.value.includes('aria-label="TODO-ZMD"'));

      const labelAction = getAction(provider, doc, diag, 'Add <label> and id');
      const labelInserts = labelAction.edit.operations.filter(op => op.type === 'insert');
      assert.ok(labelInserts.some(op => op.value.includes('<label') && op.value.includes('for="TODO-ZMD"')));
      assert.ok(labelInserts.some(op => op.value.includes('id="TODO-ZMD"')));
    }

    // ZMD005 - requireLabelForFormControls (existing id, missing label)
    {
      const content = '<input id="email" type="email">';
      const { doc } = await openDoc(tmpDir, 'form-label-id', '.html', content);
      const diag = makeDiagnostic(
        doc,
        'Form control with id="email" missing <label for="email">',
        '<input'
      );
      const action = getAction(provider, doc, diag, 'Insert <label> before control');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('<label'));
      assert.ok(insert.value.includes('for="email"'));
    }

    // ZMD005 - requireLabelForFormControls (label missing for)
    {
      const content = '<label>Email</label>\n<input id="email">';
      const { doc } = await openDoc(tmpDir, 'form-label-missing-for', '.html', content);
      const diag = makeDiagnostic(
        doc,
        'Form control with id="email" missing <label for="email">',
        '<input'
      );
      const action = getAction(provider, doc, diag, 'Add for to <label>');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('for="email"'));
    }

    // ZMD005 - requireLabelForFormControls (JSX uses htmlFor)
    {
      const content = '<label>Email</label>\n<input id="email" />';
      const { doc } = await openDoc(tmpDir, 'form-label-jsx', '.jsx', content);
      const diag = makeDiagnostic(
        doc,
        'Form control with id="email" missing <label for="email">',
        '<input'
      );
      const action = getAction(provider, doc, diag, 'Add htmlFor to <label>');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('htmlFor="email"'));
    }

    // ZMD006 - enforceListNesting (plain list)
    {
      const content = '<li>First</li>\n<li>Second</li>';
      const { doc } = await openDoc(tmpDir, 'list-nesting', '.html', content);
      const diag = makeDiagnostic(
        doc,
        '<li> must be inside a <ul> or <ol>',
        '<li>First'
      );
      const action = getAction(provider, doc, diag, 'Wrap with <ul>');
      const inserts = action.edit.operations.filter(op => op.type === 'insert');
      assert.ok(inserts.some(op => op.value.includes('<ul>')));
      assert.ok(inserts.some(op => op.value.includes('</ul>')));
    }

    // ZMD006 - enforceListNesting (JS block)
    {
      const content = '{items.map(item => {\n<li>{item}</li>\n})}';
      const { doc } = await openDoc(tmpDir, 'list-nesting-js', '.jsx', content);
      const diag = makeDiagnostic(
        doc,
        '<li> must be inside a <ul> or <ol>',
        '<li>'
      );
      const action = getAction(provider, doc, diag, 'Wrap with <ul>');
      const inserts = action.edit.operations.filter(op => op.type === 'insert');
      assert.ok(inserts.some(op => op.position.line === 0 && op.value.includes('<ul>')));
      assert.ok(inserts.some(op => op.value.includes('</ul>')));
    }

    // ZMD006 - enforceListNesting (multiline li)
    {
      const content = '<li>\n  <span>Item</span>\n</li>';
      const { doc } = await openDoc(tmpDir, 'list-nesting-multi', '.jsx', content);
      const diag = makeDiagnostic(
        doc,
        '<li> must be inside a <ul> or <ol>',
        '<li>'
      );
      const action = getAction(provider, doc, diag, 'Wrap with <ul>');
      const inserts = action.edit.operations.filter(op => op.type === 'insert');
      const closeInsert = inserts.find(op => op.value.includes('</ul>'));
      assert.ok(inserts.some(op => op.position.line === 0 && op.value.includes('<ul>')));
      assert.ok(closeInsert, 'Expected closing </ul> insert');
      assert.strictEqual(closeInsert.position.line, 2);
    }

    // ZMD008 - requireTableCaption
    {
      const content = '<table>\n  <tr></tr>\n</table>';
      const { doc } = await openDoc(tmpDir, 'table-caption', '.html', content);
      const diag = makeDiagnostic(
        doc,
        '<table> missing <caption>',
        '<table>'
      );
      const action = getAction(provider, doc, diag, 'Add <caption>TODO-ZMD</caption>');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('<caption>TODO-ZMD</caption>'));
    }

    // ZMD010 - requireHrefOnAnchors
    {
      const content = '<a>Link</a>';
      const { doc } = await openDoc(tmpDir, 'href', '.html', content);
      const diag = makeDiagnostic(
        doc,
        '<a> tag missing non-empty href attribute',
        '<a>'
      );
      const action = getAction(provider, doc, diag, 'Add href="TODO-ZMD"');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('href="TODO-ZMD"'));
    }

    // ZMD010 - requireHrefOnAnchors (router-style link)
    {
      const content = '<Link>Go</Link>';
      const { doc } = await openDoc(tmpDir, 'href-link', '.jsx', content);
      const diag = makeDiagnostic(
        doc,
        '<a> tag missing non-empty href attribute',
        '<Link>'
      );
      const action = getAction(provider, doc, diag, 'Add to="TODO-ZMD"');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('to="TODO-ZMD"'));
    }

    // ZMD011 - requireButtonText
    {
      const content = '<button></button>';
      const { doc } = await openDoc(tmpDir, 'button-text', '.html', content);
      const diag = makeDiagnostic(
        doc,
        '<button> missing accessible text',
        '<button>'
      );
      const action = getAction(provider, doc, diag, 'Add aria-label="TODO-ZMD"');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('aria-label="TODO-ZMD"'));
    }

    // ZMD012 - requireIframeTitle
    {
      const content = '<iframe></iframe>';
      const { doc } = await openDoc(tmpDir, 'iframe-title', '.html', content);
      const diag = makeDiagnostic(
        doc,
        '<iframe> missing title attribute',
        '<iframe>'
      );
      const action = getAction(provider, doc, diag, 'Add title="TODO-ZMD"');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('title="TODO-ZMD"'));
    }

    // ZMD013 - requireHtmlLang
    {
      const content = '<html><head></head><body></body></html>';
      const { doc } = await openDoc(tmpDir, 'html-lang', '.html', content);
      const diag = makeDiagnostic(
        doc,
        '<html> element missing lang attribute',
        '<html>'
      );
      const action = getAction(provider, doc, diag, 'Add lang="TODO-ZMD"');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('lang="TODO-ZMD"'));
    }

    // ZMD014 - requireImageInputAlt
    {
      const content = '<input type="image">';
      const { doc } = await openDoc(tmpDir, 'image-input-alt', '.html', content);
      const diag = makeDiagnostic(
        doc,
        '<input type="image"> missing alt attribute',
        '<input'
      );
      const action = getAction(provider, doc, diag, 'Add alt="TODO-ZMD"');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('alt="TODO-ZMD"'));
    }

    // ZMD015 - requireNavLinks
    {
      const content = '<nav>\n</nav>';
      const { doc } = await openDoc(tmpDir, 'nav-links', '.html', content);
      const diag = makeDiagnostic(
        doc,
        '<nav> contains no links',
        '<nav>'
      );
      const action = getAction(provider, doc, diag, 'Add <a href="TODO-ZMD"> inside <nav>');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('<a href="TODO-ZMD">TODO-ZMD</a>'));
    }

    // ZMD017 - noTabindexGreaterThanZero
    {
      const content = '<div tabindex="2"></div>';
      const { doc } = await openDoc(tmpDir, 'tabindex', '.html', content);
      const diag = makeDiagnostic(
        doc,
        'Tabindex greater than 0 should be avoided',
        '<div'
      );
      const actionZero = getAction(provider, doc, diag, 'Set tabindex to "0"');
      const replaceZero = actionZero.edit.operations.find(op => op.type === 'replace');
      assert.strictEqual(replaceZero.value, '0');

      const actionMinus = getAction(provider, doc, diag, 'Set tabindex to "-1"');
      const replaceMinus = actionMinus.edit.operations.find(op => op.type === 'replace');
      assert.strictEqual(replaceMinus.value, '-1');
    }

    console.log('Quick fix tests passed');
  } catch (error) {
    console.error('Quick fix tests failed');
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})();
