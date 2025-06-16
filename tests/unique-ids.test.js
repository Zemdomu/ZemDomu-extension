const assert = require('assert');
const { lintHtml } = require('../out/linter');

const options = { crossComponentAnalysis: false, rules: { uniqueIds: true, requireMain: false } };
const html = '<div id="dup"></div><span id="dup"></span>';
const res = lintHtml(html, false, options);
assert.ok(res.some(r => r.rule === 'uniqueIds'), 'Expected duplicate id warning');
console.log('Unique id test passed');
