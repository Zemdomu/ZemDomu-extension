const assert = require('assert/strict');
const path = require('path');
const Module = require('module');
const fc = require('fast-check');

// Use the existing VS Code API boundary stub; all functions under test are the
// production diagnostic adapter and inline-directive implementation.
const stubsPath = path.join(__dirname, 'stubs');
process.env.NODE_PATH = process.env.NODE_PATH
  ? stubsPath + path.delimiter + process.env.NODE_PATH
  : stubsPath;
Module._initPaths();

const vscode = require('vscode');
const { canonicalDiagnosticToVscode } = require('../out/diagnostic-adapter.js');
const { applyInlineDisableDirectives } = require('../out/linter.js');

function integerSetting(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  assert.ok(/^-?\d+$/.test(raw) && Number.isSafeInteger(value) && value >= min && value <= max,
    name + ' must be an integer from ' + min + ' through ' + max);
  return value;
}

const numRuns = integerSetting('ZEMDOMU_FUZZ_RUNS', 250, 1, 10_000);
const seed = integerSetting('ZEMDOMU_FUZZ_SEED', 0x5eed1234, -2_147_483_648, 2_147_483_647);
const selectedProperty = process.env.ZEMDOMU_FUZZ_PROPERTY;
const replayPath = process.env.ZEMDOMU_FUZZ_PATH;
if (replayPath !== undefined) {
  assert.ok(selectedProperty && /^\d+(?::\d+)*$/.test(replayPath),
    'ZEMDOMU_FUZZ_PATH requires ZEMDOMU_FUZZ_PROPERTY and a colon-separated numeric shrink path');
}
const parameters = { numRuns, seed, ...(replayPath === undefined ? {} : { path: replayPath }) };

const rules = ['requireAltText', 'requireButtonText', 'requireHrefOnAnchors'];
const rule = fc.constantFrom(...rules);
const ending = fc.constantFrom('\n', '\r\n');
const syntax = fc.constantFrom('html', 'jsx', 'vue');
const indent = fc.array(fc.constantFrom(' ', '\t'), { maxLength: 6 }).map(chars => chars.join(''));
const ruleList = fc.array(rule, { maxLength: 12 });

function documentBuilder(language, eol) {
  let text = language === 'jsx' ? 'export default () => (<>'
    : language === 'vue' ? '<template>' : '';
  const findings = [];
  const append = value => { text += value; };
  const comment = body => append(language === 'jsx' ? '{/* ' + body + ' */}' : '<!-- ' + body + ' -->');
  function finding(name, whitespace = '') {
    append(whitespace);
    const offset = text.length;
    const lines = text.slice(0, offset).split('\n');
    const id = findings.length;
    const tag = name === 'requireAltText' ? '<img data-fuzz="' + id + '" />'
      : name === 'requireButtonText' ? '<button data-fuzz="' + id + '"></button>'
        : '<a data-fuzz="' + id + '">Go</a>';
    append(tag);
    const result = Object.freeze({
      rule: name, line: lines.length - 1, column: lines.at(-1).length,
      offset, message: 'Generated finding ' + id, severity: 'warning',
    });
    findings.push(result);
    return result;
  }
  return {
    append, comment, finding, newline: () => append(eol),
    finish() {
      append(language === 'jsx' ? '</>);' : language === 'vue' ? '</template>' : '');
      return { text, findings };
    },
  };
}

const coordinate = fc.oneof(
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.constantFrom(NaN, Infinity, -Infinity)
);
const sourceLocation = fc.record({
  file: fc.constantFrom(path.resolve('src/Page.tsx'), path.resolve('src/Header.vue')),
  line: coordinate, column: coordinate,
});
const boundedPosition = position => {
  assert.ok(Number.isInteger(position.line) && position.line >= 0);
  assert.ok(Number.isInteger(position.character) && position.character >= 0);
};
const validRange = range => {
  boundedPosition(range.start);
  boundedPosition(range.end);
  assert.equal(range.start.line, range.end.line);
  assert.equal(range.end.character, range.start.character + 1);
};

const properties = {
  'diagnostic-ranges': fc.property(
    sourceLocation,
    fc.array(sourceLocation, { maxLength: 5 }),
    fc.option(sourceLocation, { nil: undefined }),
    fc.constantFrom('error', 'warning', 'info'),
    fc.string({ unit: 'binary', maxLength: 80 }),
    (source, related, preferred, severity, message) => {
      const diagnostic = Object.freeze({
        schemaVersion: '1.0', rule: 'requireAltText', code: 'ZMD004', severity, message,
        source: Object.freeze(source),
        relatedLocations: Object.freeze(related.map(location => Object.freeze({
          source: Object.freeze(location), message: 'Related source',
        }))),
        ...(preferred === undefined ? {} : { preferredEditLocation: Object.freeze(preferred) }),
        provenance: { kind: 'local', analyzer: 'fuzz-properties' }, confidence: 'certain',
      });
      const mapped = canonicalDiagnosticToVscode(diagnostic);
      validRange(mapped.range);
      assert.equal(mapped.range.start.line, Number.isFinite(source.line) && source.line > 0 ? source.line : 0);
      assert.equal(mapped.range.start.character, Number.isFinite(source.column) && source.column > 0 ? source.column : 0);
      assert.equal(mapped.message, message);
      assert.equal(mapped.code, 'ZMD004');
      assert.equal(mapped.source, 'ZemDomu');
      assert.equal(mapped.severity, severity === 'error' ? vscode.DiagnosticSeverity.Error
        : severity === 'info' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning);
      const locations = mapped.relatedInformation ?? [];
      assert.equal(locations.length, related.length + (preferred === undefined ? 0 : 1));
      for (const [index, location] of locations.entries()) {
        validRange(location.location.range);
        const original = index < related.length ? related[index] : preferred;
        assert.equal(location.location.uri.fsPath, original.file);
        assert.equal(location.location.range.start.line,
          Number.isFinite(original.line) && original.line > 0 ? original.line : 0);
        assert.equal(location.location.range.start.character,
          Number.isFinite(original.column) && original.column > 0 ? original.column : 0);
      }
    }
  ),
  'block-directives': fc.property(
    syntax, ending, indent, ruleList, ruleList, ruleList,
    fc.subarray(rules, { minLength: 1, maxLength: 2 }),
    fc.constantFrom('qualified', 'all', 'wildcard'),
    fc.constantFrom(' ', ', ', '\t'),
    (language, eol, whitespace, before, inside, after, selected, mode, separator) => {
      const builder = documentBuilder(language, eol);
      const outside = [];
      for (const name of before) {
        outside.push(builder.finding(name, whitespace));
        builder.newline();
      }
      const suffix = mode === 'qualified' ? ' ' + selected.join(separator) : mode === 'wildcard' ? ' *' : '';
      const disabled = new Set(mode === 'qualified' ? selected : rules);
      builder.comment('zemdomu-disable' + suffix);
      builder.newline();
      const keptInside = [];
      // Every run exercises both a suppressed and an unrelated rule when
      // qualified, rather than relying on random arrays to contain a target.
      for (const name of [...rules, ...inside]) {
        const result = builder.finding(name, whitespace);
        if (!disabled.has(name)) keptInside.push(result);
        builder.newline();
      }
      builder.comment('zemdomu-enable' + suffix);
      builder.newline();
      const keptAfter = [];
      for (const name of [...rules, ...after]) {
        keptAfter.push(builder.finding(name, whitespace));
        builder.newline();
      }
      const { text, findings } = builder.finish();
      const original = findings.slice();
      const expected = [...outside, ...keptInside, ...keptAfter];
      const filtered = applyInlineDisableDirectives(text, findings);
      assert.deepEqual(filtered, expected);
      assert.deepEqual(findings, original, 'Suppression must not mutate caller findings');
      assert.deepEqual(applyInlineDisableDirectives(text, filtered), expected, 'Suppression must be idempotent');
    }
  ),
  'disable-next': fc.property(
    syntax, ending, indent, rule,
    fc.integer({ min: 0, max: 5 }), fc.boolean(),
    (language, eol, whitespace, selected, blankLines, sameLine) => {
      const builder = documentBuilder(language, eol);
      const before = builder.finding(selected, whitespace);
      builder.comment('zemdomu-disable-next ' + selected);
      if (!sameLine) {
        builder.newline();
        for (let index = 0; index < blankLines; index++) {
          builder.append(whitespace);
          builder.newline();
        }
      }
      const targetLine = rules.map(name => builder.finding(name, whitespace));
      builder.newline();
      const followingLine = rules.map(name => builder.finding(name, whitespace));
      const { text, findings } = builder.finish();
      assert.deepEqual(applyInlineDisableDirectives(text, findings),
        [before, ...targetLine.filter(result => result.rule !== selected), ...followingLine]);
    }
  ),
  'literal-directives': fc.property(
    rule, ending, fc.boolean(), fc.string({ unit: 'binary', maxLength: 40 }),
    (selected, eol, block, noise) => {
      const directive = '<!-- zemdomu-' + (block ? 'disable' : 'disable-next') + ' ' + selected + ' -->';
      const literal = JSON.stringify(noise + directive + noise);
      const text = 'const marker = ' + literal + ';' + eol + 'export default () => (<img />);';
      const offset = text.lastIndexOf('<img');
      const result = Object.freeze({
        line: 1, column: 'export default () => ('.length, offset,
        message: 'An image finding', rule: selected, severity: 'warning',
      });
      const findings = [result];
      assert.deepEqual(applyInlineDisableDirectives(text, findings), findings,
        'Directive-looking string contents must never disable diagnostics');
    }
  ),
};

assert.ok(selectedProperty === undefined || Object.hasOwn(properties, selectedProperty),
  'Unknown ZEMDOMU_FUZZ_PROPERTY: ' + selectedProperty);
for (const [name, property] of Object.entries(properties)) {
  if (selectedProperty !== undefined && selectedProperty !== name) continue;
  console.log('Property: ' + name + ' (runs=' + numRuns + ', seed=' + seed + ')');
  fc.assert(property, parameters);
}
console.log('Extension property tests passed');
