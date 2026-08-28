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
const { applyInlineDisableDirectives, lintHtml } = require('../out/linter');

function codeOf(diagnostic) {
  return typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
}

function resultAt(source, needle, rule = 'requireAltText', occurrence = 0) {
  let offset = -1;
  for (let index = 0; index <= occurrence; index++) {
    offset = source.indexOf(needle, offset + 1);
  }
  assert.ok(offset >= 0, `Expected ${needle} occurrence ${occurrence}`);
  const before = source.slice(0, offset).split(/\r?\n/);
  return {
    line: before.length - 1,
    column: before[before.length - 1].length,
    message: '<img> tag missing alt attribute',
    rule,
    severity: 'error',
    offset,
  };
}

(async () => {
  const options = { rules: { requireAltText: 'error' } };
  assert.strictEqual(
    lintHtml('<!-- zemdomu-disable-next --><img />', false, options).length,
    0,
    'disable-next should suppress same-line markup'
  );

  const bounded = '<img><!-- zemdomu-disable --><img><img><!-- zemdomu-enable --><img>';
  const findings = [
    resultAt(bounded, '<img>', 'requireAltText', 0),
    resultAt(bounded, '<img>', 'requireAltText', 1),
    resultAt(bounded, '<img>', 'requireHrefOnAnchors', 1),
    resultAt(bounded, '<img>', 'requireAltText', 2),
    resultAt(bounded, '<img>', 'requireAltText', 3),
  ];
  const boundedResults = applyInlineDisableDirectives(bounded, findings);
  assert.deepStrictEqual(
    boundedResults.map(result => result.offset),
    [0, bounded.lastIndexOf('<img>')],
    'block controls should respect boundaries and suppress every finding in the block'
  );

  const nextLine = '<!-- zemdomu-disable-next -->\n\n<img>\n<img>';
  const nextResults = applyInlineDisableDirectives(nextLine, [
    resultAt(nextLine, '<img>', 'requireAltText', 0),
    resultAt(nextLine, '<img>', 'requireAltText', 1),
  ]);
  assert.strictEqual(nextResults.length, 1, 'disable-next should target the next content line');
  assert.strictEqual(nextResults[0].offset, nextLine.lastIndexOf('<img>'));

  const sameLineBoundary = '<img><!-- zemdomu-disable-next requireAltText --><img>';
  const sameLineResults = applyInlineDisableDirectives(sameLineBoundary, [
    resultAt(sameLineBoundary, '<img>', 'requireAltText', 0),
    resultAt(sameLineBoundary, '<img>', 'requireAltText', 1),
  ]);
  assert.deepStrictEqual(
    sameLineResults.map(result => result.offset),
    [0],
    'disable-next must not suppress a finding before its comment'
  );

  const directiveString =
    'const marker = "<!-- zemdomu-disable requireAltText -->"; export default () => <img />;';
  assert.strictEqual(
    applyInlineDisableDirectives(directiveString, [
      resultAt(directiveString, '<img', 'requireAltText'),
    ]).length,
    1,
    'Directive-looking strings must not suppress JSX findings'
  );
  const scriptText =
    '<script>const marker = "<!-- zemdomu-disable requireAltText -->";</script><img>';
  assert.strictEqual(
    applyInlineDisableDirectives(scriptText, [
      resultAt(scriptText, '<img', 'requireAltText'),
    ]).length,
    1,
    'Directive-looking script text must not suppress HTML findings'
  );

  const targeted = '<!-- zemdomu-disable-next requireAltText --><img>';
  const targetedResults = applyInlineDisableDirectives(targeted, [
    resultAt(targeted, '<img>', 'requireAltText'),
    resultAt(targeted, '<img>', 'requireHrefOnAnchors'),
  ]);
  assert.deepStrictEqual(
    targetedResults.map(result => result.rule),
    ['requireHrefOnAnchors'],
    'Rule-qualified controls should not suppress unrelated findings'
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-inline-'));
  try {
    const files = {
      html: path.join(tmpDir, 'disabled.html'),
      jsx: path.join(tmpDir, 'Disabled.jsx'),
      tsx: path.join(tmpDir, 'Disabled.tsx'),
      vue: path.join(tmpDir, 'Disabled.vue'),
      repeated: path.join(tmpDir, 'repeated.html'),
    };
    fs.writeFileSync(
      files.html,
      '<img><!-- zemdomu-disable --><img><a></a><!-- zemdomu-enable --><img>',
      'utf8'
    );
    fs.writeFileSync(
      files.jsx,
      'export default function A(){return (<><img />{/* zemdomu-disable */}<img /><img />{/* zemdomu-enable */}<img /></>)}',
      'utf8'
    );
    fs.writeFileSync(
      files.tsx,
      'const label: string = "x"; export default function A(){return (<><img />{/* zemdomu-disable */}<img /><img />{/* zemdomu-enable */}<img /></>)}',
      'utf8'
    );
    fs.writeFileSync(
      files.vue,
      '<template><img><!-- zemdomu-disable --><img><img><!-- zemdomu-enable --><img></template>',
      'utf8'
    );
    fs.writeFileSync(files.repeated, '<img><img>', 'utf8');

    vscode.__resetAll();
    vscode.workspace.__setWorkspaceFolders([{ uri: vscode.Uri.file(tmpDir) }]);
    vscode.workspace.__setFindFiles('**/*.{html,jsx,tsx,vue}', Object.values(files));
    const extension = require('../dist/extension.js');
    extension.activate({ extensionPath: path.resolve(__dirname, '..'), subscriptions: [] });
    await vscode.commands.__execute('zemdomu.lintWorkspace');

    const collection = vscode.languages.__getCollection('zemdomu');
    for (const filePath of [files.html, files.jsx, files.tsx, files.vue]) {
      const diagnostics = collection.get(vscode.Uri.file(filePath)) ?? [];
      assert.strictEqual(
        diagnostics.filter(diag => codeOf(diag) === 'ZMD004').length,
        2,
        `Expected only the images outside the disabled block in ${path.basename(filePath)}`
      );
    }
    const htmlDiagnostics = collection.get(vscode.Uri.file(files.html)) ?? [];
    assert.ok(
      !htmlDiagnostics.some(diag => codeOf(diag) === 'ZMD007' || codeOf(diag) === 'ZMD010'),
      'Every same-line finding for the anchor inside the disabled HTML block should be suppressed'
    );
    const repeatedDiagnostics = collection.get(vscode.Uri.file(files.repeated)) ?? [];
    assert.strictEqual(
      repeatedDiagnostics.filter(diag => codeOf(diag) === 'ZMD004').length,
      2,
      'Repeated violations on one line must remain distinct'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('Inline disable tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
