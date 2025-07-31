const assert = require("assert");
let lintHtml;
try {
  ({ lintHtml } = require("zemdomu/out/linter"));
} catch (e) {
  console.error("Failed to require zemdomu:", e.message);
  throw e;
}

const options = {
  crossComponentAnalysis: false,
  rules: { requireAltText: true, requireMain: false },
};
const html = "<img />";
const results = lintHtml(html, false, options);
assert.ok(
  results.some((r) => r.rule === "requireAltText"),
  "Expected requireAltText warning"
);
console.log("NPM link package test passed");
