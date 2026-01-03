const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProjectLinter } = require('zemdomu');

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-ext-cc-'));
  const buttonPath = path.join(tmpDir, 'Button.jsx');
  const pagePath = path.join(tmpDir, 'Page.jsx');

  const writeButton = (headingTag) => {
    fs.writeFileSync(
      buttonPath,
      `export default function Button(){ return (<div><${headingTag}>Button</${headingTag}></div>); }`
    );
  };

  fs.writeFileSync(
    pagePath,
    "import Button from './Button'; export default function Page(){ return (<main><h1>Page</h1><Button/></main>); }"
  );

  const linter = new ProjectLinter({ crossComponentAnalysis: true, rules: { singleH1: true } });

  // Initial state: Button introduces an extra <h1> which should trigger a cross-component warning on Page.
  writeButton('h1');
  await linter.lintFile(buttonPath);
  let resultMap = await linter.lintFile(pagePath);
  let pageIssues = resultMap.get(pagePath) || [];
  assert(
    pageIssues.some((issue) => issue.rule === 'singleH1'),
    'Expected Page.jsx to receive a cross-component singleH1 warning'
  );

  // Fix Button to use <h2>, re-lint Button, and confirm the cross-component warning clears.
  writeButton('h2');
  await linter.lintFile(buttonPath);
  resultMap = await linter.lintFile(pagePath);
  pageIssues = resultMap.get(pagePath) || [];
  assert(
    !pageIssues.some((issue) => issue.rule === 'singleH1'),
    'Expected cross-component singleH1 warning to clear after fixing Button.jsx'
  );

  console.log('Cross-component extension test passed');
})();
