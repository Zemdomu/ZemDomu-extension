const assert = require('assert');
const { lintHtml } = require('../out/linter');

const html = '<div id="dup"></div><span id="dup"></span>';
const res = lintHtml(html, false);
assert.ok(res.some(r => r.rule === 'uniqueIds'), 'Expected duplicate id warning');
console.log('Unique id test passed');
