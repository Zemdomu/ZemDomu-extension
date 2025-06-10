const assert = require('assert');
const { lintHtml } = require('../out/linter');

const jsx = `<label htmlFor="name">Name</label><input id="name" />`;
const results = lintHtml(jsx, true);
const hasLabelWarning = results.some(r => r.message.includes('Form control'));
assert.strictEqual(hasLabelWarning, false, 'Expected no Form control warning');
console.log('All tests passed');
