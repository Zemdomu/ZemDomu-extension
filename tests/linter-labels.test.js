const assert = require('assert');
const { lint } = require('zemdomu');

const options = { rules: { requireLabelForFormControls: 'off' } };
const jsx = '<div><label htmlFor="name">Name</label><input id="name" /></div>';
const results = lint(jsx, options);
const hasLabelWarning = results.some(r => r.message.includes('Form control'));
assert.strictEqual(hasLabelWarning, false, 'Expected no Form control warning');
console.log('Label tests passed');
