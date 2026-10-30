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
