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

    // ZMD001 - requireSectionHeading
    {
      const content = '<h2>Main</h2>\n<section>\n  <p>Hi</p>\n</section>';
      const { doc } = await openDoc(tmpDir, 'section', '.html', content);
      const diag = makeDiagnostic(
        doc,
        '<section> missing heading (<h1>-<h6>)',
        '<section>'
      );
      const action = getAction(provider, doc, diag, 'Insert <h2> heading');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('<h2>New heading</h2>'));
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
      const action = getAction(provider, doc, diag, 'Add empty alt attribute');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('alt=""'));
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
      const action = getAction(provider, doc, diag, 'Add empty aria-label attribute');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('aria-label=""'));
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

    // ZMD008 - requireTableCaption
    {
      const content = '<table>\n  <tr></tr>\n</table>';
      const { doc } = await openDoc(tmpDir, 'table-caption', '.html', content);
      const diag = makeDiagnostic(
        doc,
        '<table> missing <caption>',
        '<table>'
      );
      const action = getAction(provider, doc, diag, 'Add empty <caption>');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('<caption></caption>'));
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
      const action = getAction(provider, doc, diag, 'Add empty href attribute');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('href=""'));
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
      const action = getAction(provider, doc, diag, 'Add empty to attribute');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('to=""'));
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
      const action = getAction(provider, doc, diag, 'Add empty aria-label attribute');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('aria-label=""'));
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
      const action = getAction(provider, doc, diag, 'Add empty title attribute');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('title=""'));
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
      const action = getAction(provider, doc, diag, 'Add empty lang attribute');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('lang=""'));
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
      const action = getAction(provider, doc, diag, 'Add empty alt attribute');
      const insert = action.edit.operations.find(op => op.type === 'insert');
      assert.ok(insert.value.includes('alt=""'));
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
