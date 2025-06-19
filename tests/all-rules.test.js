const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lintHtml } = require('../out/linter');
const { ProjectLinter } = require('../../ZemDomu-Core/out/index');

// HTML snippet triggering all built-in rules
const html = `
<html>
<body>
<section></section>
<h1>One</h1>
<h1>Two</h1>
<h3>Three</h3>
<li>Item</li>
<img>
<input id="name">
<table></table>
<strong></strong>
<a href="#"></a>
<a>link</a>
<button></button>
<iframe></iframe>
<input type="image">
<nav></nav>
<div id="dup"></div>
<div id="dup"></div>
</body>
</html>
`;

const options = {
  crossComponentAnalysis: false,
  rules: {
    requireSectionHeading: true,
    enforceHeadingOrder: true,
    singleH1: true,
    requireAltText: true,
    requireLabelForFormControls: true,
    enforceListNesting: true,
    requireLinkText: true,
    requireTableCaption: true,
    preventEmptyInlineTags: true,
    requireHrefOnAnchors: true,
    requireButtonText: true,
    requireIframeTitle: true,
    requireHtmlLang: true,
    requireImageInputAlt: true,
    requireNavLinks: true,
    uniqueIds: true,
  },
};

const results = lintHtml(html, false, options);
const expected = [
  'requireSectionHeading',
  'enforceHeadingOrder',
  'singleH1',
  'requireAltText',
  'requireLabelForFormControls',
  'enforceListNesting',
  'requireLinkText',
  'requireTableCaption',
  'preventEmptyInlineTags',
  'requireHrefOnAnchors',
  'requireButtonText',
  'requireIframeTitle',
  'requireHtmlLang',
  'requireImageInputAlt',
  'requireNavLinks',
  'uniqueIds',
];
for (const rule of expected) {
  assert.ok(results.some(r => r.rule === rule), `Expected ${rule} warning`);
}

// Cross component analysis using core library
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zdtest-'));
  const a = path.join(tmp, 'A.jsx');
  const b = path.join(tmp, 'B.jsx');
  fs.writeFileSync(a, "import B from './B'; export default function A(){ return (<div><h1>A</h1><B/></div>); }");
  fs.writeFileSync(b, "export default function B(){ return (<div><h3>B</h3><h1>Extra</h1></div>); }");
  const linter = new ProjectLinter({
    crossComponentAnalysis: true,
    rules: { singleH1: true, enforceHeadingOrder: true },
  });
  await linter.lintFile(b);
  const map = await linter.lintFile(a);
  const cross = Array.from(map.values()).flat();
  assert.ok(cross.some(r => r.rule === 'singleH1'), 'Expected cross-component singleH1');
  assert.ok(cross.some(r => r.rule === 'enforceHeadingOrder'), 'Expected cross-component heading order');
  console.log('All rule tests passed');
})();
