const assert = require('assert');
const { lint } = require('zemdomu');

const options = { rules: { uniqueIds: 'error' } };
const html = '<div id="dup"></div><span id="dup"></span>';
const res = lint(html, options);
assert.ok(res.some(r => r.rule === 'uniqueIds'), 'Expected duplicate id warning');
console.log('Unique id test passed');
