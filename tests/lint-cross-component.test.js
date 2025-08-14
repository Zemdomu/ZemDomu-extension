const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { remapCrossComponent } = require("../out/cross-remap");

// temp workspace
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zem-xcomp-"));
const app = path.join(tmp, "App.tsx");
const compA = path.join(tmp, "CompA.tsx");

// write files
fs.writeFileSync(
  compA,
  `export default function CompA(){ return <h1>Hi</h1>; }`
);
fs.writeFileSync(
  app,
  `
  import CompA from './CompA';
  export default function App(){ return <main><CompA/></main>; }
`
);

// fake linter output
const raw = new Map([
  [
    app,
    [
      {
        rule: "singleH1",
        message: "Multiple <h1> tags: component 'CompA' brings an extra <h1>.",
        line: 1,
        column: 10,
      },
    ],
  ],
  [compA, []], // IMPORTANT: include component so it’s discoverable
]);

const { perFile, summaries } = remapCrossComponent(raw, (p) =>
  fs.readFileSync(p, "utf8")
);

// assertions
const compResults = perFile.get(compA) || [];
assert.ok(
  compResults.length >= 1,
  "Expected a diagnostic on the component file"
);
assert.strictEqual(compResults[0].rule, "singleH1");
assert.ok(compResults[0].line >= 0);
assert.ok(compResults[0].column >= 0);

const appSummary = summaries.get(app) || [];
assert.ok(appSummary.length === 1, "Expected one summary occurrence for App");
assert.strictEqual(appSummary[0].componentPath, compA);

console.log("Cross-component remap (pure) test passed");
