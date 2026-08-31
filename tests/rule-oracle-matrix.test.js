const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProjectLinter } = require(
  process.env.ZEMDOMU_CORE_ENTRY || 'zemdomu'
);
const { ALL_SYNTAXES, matrix } = require('./fixtures/rule-oracle-matrix');

const EXPECTED_RULES = [
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
  'noTabindexGreaterThanZero',
  'preventZemdomuPlaceholders',
  'requireDocumentTitle',
  'requireSingleMain',
  'ariaValidAttrValue',
];

const REQUIRED_EDGE_CATEGORIES = [
  'implicit-labels',
  'hidden-inputs',
  'button-like-inputs',
  'decorative-images',
  'dynamic-bound-attributes',
  'conditional-rendering',
  'slots',
  'fragments',
  'alternate-accessible-name',
  'nested-landmarks',
  'downward-heading-closure',
];

const DOCUMENT_LEVEL_CASES = new Set([
  'requireDocumentTitle/head without title',
  'requireDocumentTitle/document without head',
  'requireDocumentTitle/title outside head',
  'requireSingleMain/document without main',
  'requireSingleMain/role main without main element',
]);

const REPEATED_CASES = [
  ['requireSectionHeading', '<section></section><section></section>'],
  ['enforceHeadingOrder', '<h1>Page</h1><h3>A</h3><h5>B</h5>'],
  ['singleH1', '<h1>One</h1><h1>Two</h1><h1>Three</h1>'],
  ['requireAltText', '<img src="one.png" /><img src="two.png" />'],
  ['requireLabelForFormControls', '<input type="text" /><textarea></textarea>'],
  ['enforceListNesting', {
    html: '<li>One</li><li>Two</li>',
    jsx: '<div><li>One</li><li>Two</li></div>',
    tsx: '<div><li>One</li><li>Two</li></div>',
    vue: '<li>One</li><li>Two</li>',
  }],
  ['requireLinkText', '<a href="/one"></a><a href="/two"></a>'],
  ['requireTableCaption', '<table></table><table></table>'],
  ['preventEmptyInlineTags', '<strong></strong><em></em>'],
  ['requireHrefOnAnchors', '<a>One</a><a>Two</a>'],
  ['requireButtonText', '<button></button><button></button>'],
  ['requireIframeTitle', '<iframe src="/one"></iframe><iframe src="/two"></iframe>'],
  ['requireImageInputAlt', '<input type="image" /><input type="image" />'],
  ['requireNavLinks', '<nav></nav><nav></nav>'],
  ['uniqueIds', '<div id="dup"></div><span id="dup"></span><p id="dup"></p>'],
  ['noTabindexGreaterThanZero', '<div tabindex="1"></div><div tabindex="2"></div>'],
  ['preventZemdomuPlaceholders', '<p>TODO-ZMD</p><span>TODO-ZMD</span>'],
  ['requireSingleMain', '<html lang="en"><head><title>Page</title></head><body><main>One</main><main>Two</main><main>Three</main></body></html>'],
  ['ariaValidAttrValue', '<div aria-hidden="maybe"></div><div aria-live="loud"></div>'],
];

function markupFor(testCase, syntax) {
  const markup = testCase.markupBySyntax?.[syntax] ?? testCase.markup;
  assert.strictEqual(
    typeof markup,
    'string',
    `${testCase.name}: missing markup for applicable syntax ${syntax}`
  );
  return markup;
}

function jsxMarkup(markup) {
  return markup
    .replace(/(^|\s)for=/g, '$1htmlFor=')
    .replace(/(^|\s)tabindex=/g, '$1tabIndex=');
}

function targetFor(testCase, syntax) {
  const targets = Array.isArray(testCase.target) ? testCase.target : [testCase.target];
  const rendered =
    syntax === 'jsx' || syntax === 'tsx'
      ? targets.map((target) => jsxMarkup(target))
      : targets;
  return Array.isArray(testCase.target) ? rendered : rendered[0];
}

function renderSource(testCase, syntax) {
  const markup = markupFor(testCase, syntax);
  if (syntax === 'html') {
    return `\n<!-- rule-oracle -->\n${markup.replaceAll('<>', '').replaceAll('</>', '')}`;
  }
  if (syntax === 'vue') {
    return `<template>\n${markup.replaceAll('<>', '').replaceAll('</>', '')}\n</template>`;
  }

  const body = jsxMarkup(markup);
  if (syntax === 'tsx') {
    return `type OracleProps = Record<string, unknown>;\nexport default function Oracle(_props: OracleProps) {\n  return (<>${body}</>);\n}`;
  }
  return `export default function Oracle() {\n  return (<>${body}</>);\n}`;
}

function offsetAt(source, line, column) {
  const lines = source.split(/\r?\n/);
  if (line < 0 || line >= lines.length) return -1;
  let offset = 0;
  for (let index = 0; index < line; index += 1) {
    offset += lines[index].length + 1;
  }
  return offset + Math.max(0, column);
}

function allTargetRanges(source, target) {
  const ranges = [];
  let from = 0;
  while (from <= source.length) {
    const index = source.indexOf(target, from);
    if (index < 0) break;
    ranges.push({ start: index, end: index + target.length });
    from = index + Math.max(1, target.length);
  }
  return ranges;
}

function locationIsWithinTarget(source, result, target) {
  const offset = offsetAt(source, result.line, result.column);
  const targets = Array.isArray(target) ? target : [target];
  return targets.flatMap((value) => allTargetRanges(source, value)).some(
    (range) => offset >= range.start && offset < range.end
  );
}

async function lintCase(core, tempDir, ruleName, testCase, syntax) {
  const source = renderSource(testCase, syntax);
  const caseSlug = testCase.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const filePath = path.join(tempDir, `${ruleName}-${caseSlug}.${syntax}`);
  fs.writeFileSync(filePath, source, 'utf8');
  const resultMap = await core.lintFile(filePath, source);
  const results = resultMap.get(filePath) || [];
  const findings = results.filter((result) => result.rule === ruleName);
  const label = `${ruleName}/${syntax}/${testCase.name}`;

  if (testCase.outcome === 'finding') {
    if (findings.length === 0) {
      throw new Error(`[false-negative] ${label}: expected a finding`);
    }

    if (DOCUMENT_LEVEL_CASES.has(`${ruleName}/${testCase.name}`)) {
      return;
    }

    if (findings.some((finding) => finding.line === 0 && finding.column === 0)) {
      throw new Error(`[location] ${label}: element-level finding must not fall back to (0,0)`);
    }
    const expectedTarget = targetFor(testCase, syntax);
    if (!findings.every((finding) => locationIsWithinTarget(source, finding, expectedTarget))) {
      throw new Error(
        `[location] ${label}: every finding must point inside an expected node/attribute ${JSON.stringify(expectedTarget)}`
      );
    }
  } else if (testCase.outcome === 'clear') {
    if (findings.length !== 0) {
      throw new Error(`[false-positive] ${label}: expected no finding, got ${findings.length}`);
    }
  }
}

function verifyMatrixShape() {
  assert.deepStrictEqual(
    Object.keys(matrix),
    EXPECTED_RULES,
    'Rule-oracle matrix must cover the canonical 21-rule surface in order'
  );

  const observedCategories = new Set();
  const coverageCells = [];
  for (const [ruleName, definition] of Object.entries(matrix)) {
    assert.deepStrictEqual(
      definition.syntaxes,
      ALL_SYNTAXES,
      `${ruleName}: must explicitly classify every supported syntax instead of omitting a cell`
    );

    for (const syntax of definition.syntaxes) {
      const applicableCases = definition.cases.filter(
        (testCase) => testCase.markup || testCase.markupBySyntax?.[syntax]
      );
      const knownBad = applicableCases.filter((testCase) => testCase.outcome === 'finding');
      const goodOrAmbiguous = applicableCases.filter(
        (testCase) => testCase.outcome === 'clear' || testCase.outcome === 'ambiguous'
      );
      assert.ok(
        knownBad.length >= 5,
        `${ruleName}/${syntax}: requires at least 5 semantically distinct known-bad fixtures`
      );
      assert.ok(
        goodOrAmbiguous.length >= 10,
        `${ruleName}/${syntax}: requires at least 10 semantically distinct known-good or ambiguous fixtures`
      );
      coverageCells.push({
        ruleName,
        syntax,
        knownBad: knownBad.length,
        goodOrAmbiguous: goodOrAmbiguous.length,
      });
    }

    for (const testCase of definition.cases) {
      for (const category of testCase.categories || []) observedCategories.add(category);
    }
  }

  for (const category of REQUIRED_EDGE_CATEGORIES) {
    assert.ok(observedCategories.has(category), `Missing required edge-case category: ${category}`);
  }

  const expectedCellCount = EXPECTED_RULES.length * ALL_SYNTAXES.length;
  assert.strictEqual(
    coverageCells.length,
    expectedCellCount,
    'Rule-oracle topology must report every rule/syntax cell'
  );

  return {
    cellCount: coverageCells.length,
    expectedCellCount,
    minimumKnownBad: Math.min(...coverageCells.map((cell) => cell.knownBad)),
    minimumGoodOrAmbiguous: Math.min(
      ...coverageCells.map((cell) => cell.goodOrAmbiguous)
    ),
  };
}

async function verifyRepeatedFindings(core, tempDir, failures) {
  for (const [ruleName, fixture] of REPEATED_CASES) {
    for (const syntax of matrix[ruleName].syntaxes) {
      const repeatedCase = typeof fixture === 'string'
        ? { name: 'repeated violations', markup: fixture }
        : { name: 'repeated violations', markupBySyntax: fixture };
      const source = renderSource(repeatedCase, syntax);
      const filePath = path.join(tempDir, `repeated-${ruleName}.${syntax}`);
      fs.writeFileSync(filePath, source, 'utf8');
      const resultMap = await core.lintFile(filePath, source);
      const findings = (resultMap.get(filePath) || []).filter(
        (result) => result.rule === ruleName
      );
      const locations = new Set(
        findings.map((finding) => `${finding.line}:${finding.column}`)
      );
      if (findings.length < 2) {
        failures.push(
          `[repeated] ${ruleName}/${syntax}: expected repeated violations to remain independently reportable, got ${findings.length}`
        );
      }
      if (findings.some((finding) => finding.line === 0 && finding.column === 0)) {
        failures.push(
          `[repeated] ${ruleName}/${syntax}: repeated element-level findings must not fall back to (0,0)`
        );
      }
      if (locations.size < 2) {
        failures.push(
          `[repeated] ${ruleName}/${syntax}: expected at least 2 unique finding locations, got ${locations.size}`
        );
      }
    }
  }
}

(async () => {
  const topology = verifyMatrixShape();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-rule-oracle-'));
  const core = new ProjectLinter({ crossComponentAnalysis: false });
  const failures = [];
  try {
    for (const [ruleName, definition] of Object.entries(matrix)) {
      for (const syntax of definition.syntaxes) {
        for (const testCase of definition.cases) {
          if (testCase.markup || testCase.markupBySyntax?.[syntax]) {
            try {
              await lintCase(core, tempDir, ruleName, testCase, syntax);
            } catch (error) {
              failures.push(error instanceof Error ? error.message : String(error));
            }
          }
        }
      }
    }

    await verifyRepeatedFindings(core, tempDir, failures);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const failuresByGate = new Map();
  const failuresByRule = new Map();
  for (const failure of failures) {
    const gate = /^\[([^\]]+)\]/.exec(failure)?.[1] || 'harness';
    const ruleName = /^\[[^\]]+\]\s+([^/]+)/.exec(failure)?.[1] || 'harness';
    failuresByGate.set(gate, (failuresByGate.get(gate) || 0) + 1);
    failuresByRule.set(ruleName, (failuresByRule.get(ruleName) || 0) + 1);
  }
  const summary = (counts) =>
    [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([name, count]) => `${name}=${count}`)
      .join(', ');
  const samples = [...failuresByGate.keys()].flatMap((gate) =>
    failures.filter((failure) => failure.startsWith(`[${gate}]`)).slice(0, 8)
  );

  if (failures.length > 0 && process.env.ZEMDOMU_ORACLE_VERBOSE === '1') {
    console.error(`All rule-oracle failures:\n- ${failures.join('\n- ')}`);
  }

  assert.strictEqual(
    failures.length,
    0,
    `Rule oracle found ${failures.length} accuracy gate failure(s).\n` +
      `By gate: ${summary(failuresByGate)}\n` +
      `By rule: ${summary(failuresByRule)}\n` +
      `Representative failures:\n- ${samples.join('\n- ')}`
  );

  console.log(
    `Rule oracle matrix tests passed: ${topology.cellCount}/${topology.expectedCellCount} ` +
      `rule/syntax cells; minimum density ${topology.minimumKnownBad} known-bad and ` +
      `${topology.minimumGoodOrAmbiguous} known-good/ambiguous fixtures per cell`
  );
})().catch((error) => {
  console.error('Rule oracle matrix tests failed');
  console.error(error);
  process.exitCode = 1;
});
