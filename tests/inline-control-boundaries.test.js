const assert = require('assert');
const { applyInlineDisableDirectives, lintHtml } = require('../out/linter.js');

const options = { rules: { requireAltText: 'warning' } };
function missingAlt(source) {
  return lintHtml(source, false, options).filter(result => result.rule === 'requireAltText');
}

for (const rawTag of ['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']) {
  const source = `<${rawTag} data-note='>'><!-- zemdomu-disable requireAltText --></${rawTag.toUpperCase()}><img src="portrait.png">`;
  // Check the extension's filtering boundary independently of Core's parser.
  const offset = source.lastIndexOf('<img');
  const finding = { rule: 'requireAltText', message: '<img> tag missing alt attribute',
    line: 0, column: offset, offset, severity: 'warning' };
  assert.deepStrictEqual(applyInlineDisableDirectives(source, [finding]), [finding],
    `Directive-looking text inside ${rawTag} must not disable markup after the raw-text element`);
  if (rawTag === 'script' || rawTag === 'style') assert.strictEqual(missingAlt(source).length, 1);
}
for (const source of [
  '<div data-note="<!-- zemdomu-disable requireAltText -->">Text</div><img>',
  "<div data-note='<!-- zemdomu-disable requireAltText -->'>Text</div><img>",
  '<img><!-- zemdomu-disable-next requireAltText -->',
  '<img><!-- zemdomu-disable-next requireAltText -->\r\n \t\r\n',
  '<img><!-- zemdomu-disable requireAltText',
  '<img><div title="unterminated > <!-- zemdomu-disable requireAltText -->',
  '<!-- zemdomu-disable-next unknownRule --><img>',
]) {
  assert.strictEqual(missingAlt(source).length, 1,
    'Quoted literals, incomplete/trailing comments, and unrelated rules must not hide a real preceding or following image finding');
}
assert.strictEqual(missingAlt('<!-- zemdomu-disable-next requireAltText -->\r\n\r\n<img>').length, 0,
  'A real directive must still suppress its next content line after CRLF blanks');
assert.strictEqual(missingAlt('<!-- zemdomu-disable requireAltText --><img><!-- zemdomu-enable requireAltText --><img>').length, 1,
  'An explicit enable must restore findings after a disabled block');
console.log('Inline control raw-text, quoted-attribute, EOF and CRLF boundaries passed');

// Observe the actual parser boundary, rather than retesting the marker check.
const babelParser = require('@babel/parser');
const originalParse = babelParser.parse;
let parserCalls = 0;
babelParser.parse = function (...args) {
  parserCalls += 1;
  return originalParse.apply(this, args);
};
function imageFinding(source) {
  const offset = source.lastIndexOf('<img');
  assert.ok(offset >= 0);
  return { rule: 'requireAltText', message: '<img> tag missing alt attribute',
    line: 0, column: offset, offset, severity: 'warning' };
}
try {
  for (const source of [
    '<!doctype html><html><body><main><img></main></body></html>',
    'export default function Page(){ return <main><img /></main>; }',
    'const title: string = "Page"; export default () => <main><img /></main>;',
    '<template><main><img></main></template>',
    '<!-- an ordinary comment --><main><img></main>',
  ]) {
    const findings = [imageFinding(source)];
    const before = parserCalls;
    assert.strictEqual(applyInlineDisableDirectives(source, findings), findings,
      'Marker-free filtering must preserve the exact findings array');
    assert.strictEqual(parserCalls, before,
      'Marker-free HTML, JSX, TSX and Vue must not invoke the JSX parser');
  }

  for (const source of [
    '<!-- ZEMDOMU-DISABLE-NEXT requireAltText --><img>',
    'export default () => <>{/* ZeMdOmU-DiSaBlE-NeXt requireAltText */}<img /></>;',
    '<!-- ZEMDOMU-disable requireAltText --><img><!-- ZEMDOMU-enable requireAltText --><img>',
  ]) {
    const before = parserCalls;
    const actual = applyInlineDisableDirectives(source, [imageFinding(source)]);
    assert.ok(parserCalls > before, 'Accepted case-insensitive controls must retain the existing parser path');
    assert.strictEqual(actual.length, source.includes('ZEMDOMU-enable') ? 1 : 0,
      'Existing next-line and enable behavior must survive the fast path');
  }

  for (const source of [
    '<!-- zemdomu-disabled requireAltText --><img>',
    '<!-- zemdomu-enablement requireAltText --><img>',
    'const marker = "<!-- ZEMDOMU-disable requireAltText -->"; export default () => <img />;',
    '<div data-note="<!-- ZEMDOMU-disable requireAltText -->"><img></div>',
  ]) {
    const findings = [imageFinding(source)];
    const before = parserCalls;
    assert.deepStrictEqual(applyInlineDisableDirectives(source, findings), findings,
      'Malformed controls, strings and quoted attributes must keep real findings');
    assert.ok(parserCalls > before, 'Ambiguous marker text must use the existing parser');
  }

  // Preserve the existing regex's disable-block recovery of this spelling;
  // this optimization must not change interpretation of marker-present text.
  const recovered = '<!-- zemdomu-disable-nextness requireAltText --><img>';
  assert.deepStrictEqual(applyInlineDisableDirectives(recovered, [imageFinding(recovered)]), []);

  const before = parserCalls;
  assert.deepStrictEqual(applyInlineDisableDirectives('<!-- zemdomu-disable -->', []), []);
  assert.ok(parserCalls > before, 'Marker-present empty findings retain their existing filtering path');
} finally {
  babelParser.parse = originalParse;
}
console.log('Inline control parser fast path and case-insensitive compatibility passed');
