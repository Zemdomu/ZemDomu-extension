const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readRuleCodes() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../ZemDomu-Core/src/rule-codes.ts'),
    'utf8'
  );
  const body = source.match(/const RULE_CODES = \{([\s\S]*?)\} as const/);
  assert.ok(body, 'Expected to find Core RULE_CODES');
  return [...body[1].matchAll(/\n  (\w+):/g)].map((match) => match[1]);
}

function readExtensionRuleNames() {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
  const body = source.match(/const RULE_NAMES = \[([\s\S]*?)\] as const/);
  assert.ok(body, 'Expected to find Extension RULE_NAMES');
  return [...body[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

const coreRules = readRuleCodes();
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

assert.deepStrictEqual(extensionRules, coreRules, 'Extension RULE_NAMES must match Core RULE_CODES');
assert.deepStrictEqual(configuredRules, coreRules, 'Extension rule settings must match Core RULE_CODES');
assert.deepStrictEqual(
  configuredSeverities,
  coreRules,
  'Extension severity settings must match Core RULE_CODES'
);

console.log('Rule surface tests passed');
