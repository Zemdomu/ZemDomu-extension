import { lintHtml } from '../src/linter';

describe('lintHtml label checks', () => {
  it('does not warn when label htmlFor matches input id', () => {
    const jsx = `<label htmlFor="name">Name</label><input id="name" />`;
    const results = lintHtml(jsx, true);
    const hasLabelWarning = results.some(r => r.message.includes('Form control'));
    expect(hasLabelWarning).toBe(false);
  });
});
