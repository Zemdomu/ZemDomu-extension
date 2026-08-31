const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readCoreRuleSurface() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../ZemDomu-Core/src/rule-codes.ts'),
    'utf8'
  );
  const body = source.match(/const RULE_CODES = \{([\s\S]*?)\} as const/);
  assert.ok(body, 'Expected to find Core RULE_CODES');
  const pageOnlyBody = source.match(
    /export const PAGE_ONLY_RULES = \[([\s\S]*?)\] as const/
  );
  assert.ok(pageOnlyBody, 'Expected to find Core PAGE_ONLY_RULES');
  const allRules = [...body[1].matchAll(/\n  (\w+):/g)].map((match) => match[1]);
  const pageOnlyRules = [
    ...pageOnlyBody[1].matchAll(/["']([^"']+)["']/g),
  ].map((match) => match[1]);
  const pageOnlySet = new Set(pageOnlyRules);
  return {
    allRules,
    pageOnlyRules,
    extensionRules: allRules.filter((rule) => !pageOnlySet.has(rule)),
  };
}

function readExtensionRuleNames() {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
  const body = source.match(/const RULE_NAMES = \[([\s\S]*?)\] as const/);
  assert.ok(body, 'Expected to find Extension RULE_NAMES');
  return [...body[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function readDocumentedRules(relativePath) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
  const heading = /^#{2,3} Supported Rules\s*$/m.exec(source);
  assert.ok(heading, `${relativePath} must contain a Supported Rules section`);
  const afterHeading = source.slice(heading.index + heading[0].length);
  const nextHeading = /^#{2,3}\s/m.exec(afterHeading);
  const section = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
  return [...section.matchAll(/^- `([^`]+)`\s*$/gm)].map(match => match[1]);
}

const coreRuleSurface = readCoreRuleSurface();
const extensionEligibleRules = coreRuleSurface.extensionRules;
const extensionRules = readExtensionRuleNames();
const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')
);
const properties = packageJson.contributes.configuration.properties;
const configuredRules = Object.keys(properties)
  .filter((key) => key.startsWith('zemdomu.rules.'))
  .map((key) => key.replace('zemdomu.rules.', ''));
const configuredSeverities = Object.keys(properties)
  .filter((key) => key.startsWith('zemdomu.severity.'))
  .map((key) => key.replace('zemdomu.severity.', ''));
const readmeRules = readDocumentedRules('README.md');
const marketplaceRules = readDocumentedRules('docs/USER_GUIDE.md');

assert.deepStrictEqual(
  extensionRules,
  extensionEligibleRules,
  'Extension RULE_NAMES must match Core non-page-only RULE_CODES'
);
assert.deepStrictEqual(
  configuredRules,
  extensionEligibleRules,
  'Extension rule settings must match Core non-page-only RULE_CODES'
);
assert.deepStrictEqual(
  configuredSeverities,
  extensionEligibleRules,
  'Extension severity settings must match Core non-page-only RULE_CODES'
);
assert.deepStrictEqual(
  readmeRules,
  extensionEligibleRules,
  'README supported rules must match Core non-page-only RULE_CODES'
);
assert.strictEqual(
  packageJson.readme,
  'docs/USER_GUIDE.md',
  'Marketplace copy must use the tested user guide'
);
assert.deepStrictEqual(
  marketplaceRules,
  extensionEligibleRules,
  'User guide and Marketplace supported rules must match Core non-page-only RULE_CODES'
);
for (const pageOnlyRule of coreRuleSurface.pageOnlyRules) {
  assert.ok(
    coreRuleSurface.allRules.includes(pageOnlyRule),
    `Core page-only rule ${pageOnlyRule} must have a canonical rule code`
  );
  assert.ok(
    !extensionRules.includes(pageOnlyRule),
    `Extension must not advertise page-only rule ${pageOnlyRule} before adopting page diagnostics`
  );
}

console.log('Rule surface tests passed');
