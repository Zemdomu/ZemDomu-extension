const assert = require("assert");
let lint;
try {
  ({ lint } = require("zemdomu"));
} catch (e) {
  console.error("Failed to require zemdomu:", e.message);
  throw e;
}

const options = { rules: { requireAltText: 'error' } };
const html = "<img />";
const results = lint(html, options);
assert.ok(
  results.some((r) => r.rule === "requireAltText"),
  "Expected requireAltText warning"
);
console.log("NPM link package test passed");
