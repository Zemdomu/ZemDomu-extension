const assert = require('assert');
const { lintHtml } = require('../out/linter');

const options = { crossComponentAnalysis: false, rules: { requireAltText: true, requireMain: false } };

const html = '<!-- zemdomu-disable-next --><img />';
const res = lintHtml(html, false, options);
assert.strictEqual(res.length, 0, 'Expected no warnings for disable-next');

const block = '<!-- zemdomu-disable --><img /><!-- zemdomu-enable -->';
const res2 = lintHtml(block, false, options);
assert.strictEqual(res2.length, 0, 'Expected no warnings for disable block');
console.log('Inline disable tests passed');
