const assert = require("assert");
const { lintHtml } = require("zemdomu");

const html = "<img />";
const results = lintHtml(html, false, {
  rules: { requireAltText: true, requireMain: false },
});

assert.ok(
  results.some((r) => r.rule === "requireAltText"),
  "Expected requireAltText warning"
);
console.log("NPM link package test passsed");
