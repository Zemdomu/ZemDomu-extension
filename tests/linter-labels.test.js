const assert = require('assert');
const { lintHtml } = require('../out/linter');

const options = { crossComponentAnalysis: false, rules: { requireMain: false } };
const jsx = '<div><label htmlFor="name">Name</label><input id="name" /></div>';
const results = lintHtml(jsx, true, options);
const hasLabelWarning = results.some(r => r.message.includes('Form control'));
assert.strictEqual(hasLabelWarning, false, 'Expected no Form control warning');
console.log('Label tests passed');
