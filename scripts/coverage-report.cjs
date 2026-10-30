const assert = require('assert');
const fs = require('fs');
const path = require('path');

function sourceFiles(root, directory = path.join(root, 'src')) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(root, filename)
      : entry.name.endsWith('.ts') ? [filename] : [];
  }).sort();
}

function validateMap(filename, sources) {
  const code = fs.readFileSync(filename, 'utf8');
  const reference = [...code.matchAll(/^\/\/# sourceMappingURL=(.+)$/gm)].at(-1);
  assert.ok(reference, `Missing source map reference: ${filename}`);
  const mapPath = path.resolve(path.dirname(filename), reference[1].trim());
  assert.strictEqual(mapPath, `${filename}.map`, `Unexpected source map reference: ${filename}`);
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  assert.strictEqual(map.version, 3, `Invalid source map version: ${mapPath}`);
  assert.ok(typeof map.mappings === 'string' && map.mappings.length > 0 &&
    /^[A-Za-z0-9+/,;]+$/.test(map.mappings), `Invalid source map mappings: ${mapPath}`);
  assert.ok(Array.isArray(map.sources) && Array.isArray(map.sourcesContent),
    `Missing source map contents: ${mapPath}`);
  const resolved = map.sources.map(source =>
    path.resolve(path.dirname(mapPath), map.sourceRoot || '', source));
  for (const source of sources) {
    const index = resolved.indexOf(source);
    assert.ok(index >= 0, `Source map does not reference ${source}`);
    // TypeScript and esbuild may strip the UTF-8 BOM from embedded sources.
    assert.ok(typeof map.sourcesContent[index] === 'string' &&
      map.sourcesContent[index].replace(/^\uFEFF/, '') === fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''),
      `Source map content differs from ${source}`);
  }
}

function validateSourceMaps(root) {
  const sources = sourceFiles(root);
  assert.ok(sources.length > 0, 'No TypeScript sources found');
  for (const source of sources) {
    const emitted = path.relative(path.join(root, 'src'), source).replace(/\.ts$/, '.js');
    validateMap(path.join(root, 'out', emitted), [source]);
  }
  validateMap(path.join(root, 'dist', 'extension.js'), [path.join(root, 'src', 'extension.ts')]);
  return sources;
}

function counts(row, mapName, counterName) {
  const map = row[mapName];
  const values = row[counterName];
  assert.ok(map && values && typeof map === 'object' && typeof values === 'object' &&
    !Array.isArray(map) && !Array.isArray(values),
    `Missing ${counterName} coverage counters: ${row.path}`);
  assert.deepStrictEqual(Object.keys(values).sort(), Object.keys(map).sort(),
    `Incomplete ${counterName} coverage counters: ${row.path}`);
  for (const [id, value] of Object.entries(values)) {
    if (counterName === 'b') {
      assert.ok(Array.isArray(value) && value.length > 0 &&
        (!map[id].locations || value.length === map[id].locations.length),
        `Coverage counters must match branch locations: ${row.path}`);
    } else {
      assert.ok(!Array.isArray(value), `Expected scalar ${counterName} counter: ${row.path}`);
    }
  }
  const counters = Object.values(values).flatMap(value => Array.isArray(value) ? value : [value]);
  assert.ok(counters.every(value => Number.isSafeInteger(value) && value >= 0),
    `Invalid ${counterName} coverage counters: ${row.path}`);
  return { total: counters.length, covered: counters.filter(value => value > 0).length };
}

function validateCoverage(root) {
  const sources = validateSourceMaps(root);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'coverage', 'coverage-final.json'), 'utf8'));
  const summary = JSON.parse(fs.readFileSync(path.join(root, 'coverage', 'coverage-summary.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(report).sort(), sources,
    'Coverage must contain exactly the TypeScript source inventory, with no generated or external rows');
  assert.deepStrictEqual(Object.keys(summary).filter(key => key !== 'total').sort(), sources,
    'Coverage summary must contain exactly the TypeScript source inventory');
  const detailed = {};
  for (const [filename, row] of Object.entries(report)) {
    assert.strictEqual(row.path, filename, 'Coverage row path must match its source');
    const statements = counts(row, 'statementMap', 's');
    const functions = counts(row, 'fnMap', 'f');
    const branches = counts(row, 'branchMap', 'b');
    if (filename === path.join(root, 'src', 'extension.ts')) {
      assert.ok(functions.total > 0 && functions.covered > 0,
        'Extension entrypoint must have function counters and executed functions');
      assert.ok(branches.total > 0 && branches.covered > 0,
        'Extension entrypoint must have branch counters and executed branches');
    }
    // Istanbul line counters use the maximum hit count for statements that
    // start on the same source line.
    const lineHits = new Map();
    for (const [id, location] of Object.entries(row.statementMap)) {
      const line = location.start.line;
      assert.ok(Number.isSafeInteger(line) && line > 0, `Invalid source line: ${filename}`);
      lineHits.set(line, Math.max(lineHits.get(line) || 0, row.s[id]));
    }
    detailed[filename] = {
      statements, functions, branches,
      lines: { total: lineHits.size, covered: [...lineHits.values()].filter(value => value > 0).length },
    };
  }
  assert.ok(summary.total, 'Missing total coverage summary');
  for (const [filename, metrics] of Object.entries(summary)) {
    for (const metric of ['lines', 'statements', 'functions', 'branches']) {
      const value = metrics[metric];
      assert.ok(value && Number.isFinite(value.pct) &&
        ['total', 'covered', 'skipped'].every(key => Number.isSafeInteger(value[key])),
        `Non-finite ${metric} coverage: ${filename}`);
      assert.ok(value.total >= 0 && value.covered >= 0 && value.covered <= value.total &&
        value.skipped >= 0 && value.skipped <= value.total &&
        value.pct >= 0 && value.pct <= 100, `Invalid ${metric} coverage: ${filename}`);
      const expected = filename === 'total'
        ? Object.values(detailed).reduce((sum, item) => ({
          total: sum.total + item[metric].total, covered: sum.covered + item[metric].covered,
        }), { total: 0, covered: 0 })
        : detailed[filename][metric];
      assert.strictEqual(value.total, expected.total, `Incorrect ${metric} total: ${filename}`);
      assert.strictEqual(value.covered, expected.covered, `Incorrect ${metric} covered count: ${filename}`);
      const percent = value.total === 0 ? 100 : value.covered / value.total * 100;
      assert.ok(Math.abs(value.pct - percent) < 0.011, `Incorrect ${metric} percentage: ${filename}`);
    }
  }
  return summary;
}

module.exports = { sourceFiles, validateSourceMaps, validateCoverage };
