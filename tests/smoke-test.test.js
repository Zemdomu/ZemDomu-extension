const { lint } = require("zemdomu");
const html = "<img><h1>One</h1><h3>Two</h3><li>Orphan</li>";
const results = lint(html, {
  rules: {
    requireAltText: true,
    enforceHeadingOrder: true,
    enforceListNesting: true,
  },
});
const missingAlt = results.some((r) => r.rule === "requireAltText");
const badHeading = results.some((r) => r.rule === "enforceHeadingOrder");
const orphanList = results.some((r) => r.rule === "enforceListNesting");
if (!missingAlt || !badHeading || !orphanList) {
  console.error(results);
  throw new Error("Smoke-test failed: expected all three rules to fire");
}
console.log("Smoke-test passed");
