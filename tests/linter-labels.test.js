const { lintHtml } = require('../out/linter');

test('label pairs with input without warning', () => {
  const jsx = `<label htmlFor="name">Name</label><input id="name" />`;
  const results = lintHtml(jsx, true);
  const hasWarning = results.some(r => r.message.includes('Form control'));
  expect(hasWarning).toBe(false);
});
