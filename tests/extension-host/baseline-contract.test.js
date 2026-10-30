const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { test } = require('node:test');
const { SCHEMA_VERSION, PROTOCOL, fixtureFactorySource, createOriginalWorkspace, fixtureIdentity, samplePlan, controlManifest, distribution, aggregateSamples } = require('./baseline-shared');
const { executePlan } = require('./baseline-runner');

const root = path.resolve(__dirname, '..', '..');
const releaseRunner = path.join(__dirname, 'run.js');

function validManifest() {
  return {
    cell: 'linux-x64-vscode-1.144.0',
    vscodeVersion: '1.144.0',
    fixture: { sha256: 'identical-fixture' },
    source: { sha256: 'identical-source', bundleSha256: 'identical-bundle' },
    samples: samplePlan().map((sample, index) => ({
      ...sample,
      status: 'passed',
      report: {
        schemaVersion: SCHEMA_VERSION,
        status: 'passed',
        cell: 'linux-x64-vscode-1.144.0',
        sample,
        protocol: PROTOCOL,
        environment: { vscode: '1.144.0', node: 'v24.22.1', electron: '43.8.3', platform: 'linux', architecture: 'x64' },
        inputs: { fixtureSha256: 'identical-fixture', sourceSha256: 'identical-source', bundleSha256: 'identical-bundle' },
        editor: {
          typeOperations: Array.from({ length: 20 }, (_, index) => ({ index, expectedMissingAlt: index % 2 !== 0, textSha256: index % 2 ? 'original' : 'valid', cadenceMs: 200 })),
          saveOperations: Array.from({ length: 100 }, (_, index) => ({ index, expectedMissingAlt: index % 2 !== 0, textSha256: index % 2 ? 'original' : 'valid', cadenceMs: 50 })),
        },
        workspaceFileCount: 100,
        product: { proofValid: true },
        memory: { fullWindowPeakRssMiB: sample.condition === 'control' ? 200 + index : 250 + index, saveWindowPeakRssMiB: 190, milestones: [{ rssMiB: 180 }] },
      },
    })),
  };
}

test('diagnostic factory produces byte-identical original release fixture contents without executing its runner', () => {
  const releaseSource = fs.readFileSync(releaseRunner, 'utf8');
  const context = { require: createRequire(releaseRunner), __dirname, process };
  vm.createContext(context);
  vm.runInContext(releaseSource.slice(0, releaseSource.indexOf('async function main()')) + '\nthis.originalFactory=createWorkspace;', context);
  const original = context.originalFactory();
  const diagnostic = createOriginalWorkspace(releaseRunner);
  try {
    assert.deepStrictEqual(fixtureIdentity(diagnostic), fixtureIdentity(original));
    assert.strictEqual(fixtureIdentity(diagnostic).sourceFileCount, 100);
    assert.strictEqual(fs.readFileSync(path.join(diagnostic, '.vscode/settings.json'), 'utf8'), JSON.stringify({ 'zemdomu.run': 'manual' }, null, 2));
    assert.ok(fs.readFileSync(path.join(diagnostic, 'index.html'), 'utf8').includes('<img src="portrait.png">'));
    assert.ok(!fixtureFactorySource(releaseRunner).includes('runTests'));
  } finally {
    fs.rmSync(original, { recursive: true, force: true });
    fs.rmSync(diagnostic, { recursive: true, force: true });
  }
});

test('fixture drift is rejected before a changed workload can produce baseline numbers', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zd-fixture-contract-'));
  try {
    const changed = path.join(temporary, 'run.js');
    fs.writeFileSync(changed, fs.readFileSync(releaseRunner, 'utf8').replace('portrait.png', 'different.png'));
    assert.throws(() => fixtureFactorySource(changed), /fixture factory changed/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('Windows CRLF checkout produces the same fixture bytes and fixed normalized factory identity', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zd-fixture-crlf-'));
  let crlfWorkspace;
  const original = createOriginalWorkspace(releaseRunner);
  try {
    const crlfRunner = path.join(temporary, 'run.js');
    fs.writeFileSync(crlfRunner, fs.readFileSync(releaseRunner, 'utf8').replace(/\r?\n/g, '\r\n'));
    crlfWorkspace = createOriginalWorkspace(crlfRunner);
    assert.deepStrictEqual(fixtureIdentity(crlfWorkspace), fixtureIdentity(original));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(original, { recursive: true, force: true });
    if (crlfWorkspace) fs.rmSync(crlfWorkspace, { recursive: true, force: true });
  }
});

test('control contributes identical static schemas but no product ID, entry point, commands or activation', () => {
  const product = require(path.join(root, 'package.json'));
  const control = controlManifest(product);
  assert.deepStrictEqual(control.contributes.configuration, product.contributes.configuration);
  assert.strictEqual(control.engines.vscode, product.engines.vscode);
  assert.notStrictEqual(`${control.publisher}.${control.name}`, `${product.publisher}.${product.name}`);
  assert.strictEqual(control.main, undefined);
  assert.strictEqual(control.contributes.commands, undefined);
  assert.deepStrictEqual(control.activationEvents, []);
  assert.strictEqual(control.dependencies, undefined);
});

test('exactly five fixed alternating pairs are scheduled with no selection input', () => {
  const plan = samplePlan();
  assert.strictEqual(plan.length, 10);
  assert.deepStrictEqual(plan.map(sample => sample.condition), ['control', 'treatment', 'treatment', 'control', 'control', 'treatment', 'treatment', 'control', 'control', 'treatment']);
  assert.strictEqual(new Set(plan.map(sample => sample.sampleId)).size, 10);
});

test('raw full/save peaks and signed paired differences are retained with descriptive small-N distributions', () => {
  const manifest = validManifest();
  const summary = aggregateSamples(manifest);
  assert.strictEqual(summary.pairedDeltas.length, 5);
  assert.strictEqual(summary.pairedDeltas[0].deltaMiB, 51);
  assert.strictEqual(summary.pairedDeltas[1].deltaMiB, 49);
  manifest.samples[1].report.memory.fullWindowPeakRssMiB = 195;
  assert.strictEqual(aggregateSamples(manifest).pairedDeltas[0].deltaMiB, -5);
  assert.deepStrictEqual(distribution([3, 1, 9, 2, 4]), { count: 5, min: 1, median: 3, max: 9, range: 8, descriptiveP95SmallN: 9 });
});

test('every launch is attempted once and persisted even when the first host fails', async () => {
  const manifest = validManifest();
  const called = [];
  const snapshots = [];
  await assert.rejects(executePlan(manifest, async sample => {
    called.push(sample.sampleId);
    if (called.length === 1) throw new Error('deliberate host failure');
    return sample.report;
  }, () => snapshots.push(manifest.samples.map(sample => ({ sampleId: sample.sampleId, status: sample.status })))), /Missing\/failed sample/);
  assert.deepStrictEqual(called, samplePlan().map(sample => sample.sampleId));
  assert.strictEqual(manifest.samples[0].status, 'failed');
  assert.match(manifest.samples[0].error.message, /deliberate host failure/);
  assert.ok(manifest.samples.slice(1).every(sample => sample.status === 'passed'));
  assert.strictEqual(snapshots.length, 20);
  assert.strictEqual(snapshots.at(-1)[0].status, 'failed');
});

for (const [name, mutate, expected] of [
  ['missing sample', manifest => manifest.samples.pop(), /All ten/],
  ['duplicate/reordered sample', manifest => { manifest.samples[1] = manifest.samples[0]; }, /plan mismatch/],
  ['swapped control/treatment reports', manifest => { [manifest.samples[0].report, manifest.samples[1].report] = [manifest.samples[1].report, manifest.samples[0].report]; }, /scheduled sample/],
  ['stale matrix cell', manifest => { manifest.samples[0].report.cell = 'windows-x64-vscode-1.144.0'; }, /matrix cell/],
  ['failed result', manifest => { manifest.samples[3].report.status = 'failed'; }, /did not complete/],
  ['runtime drift', manifest => { manifest.samples[1].report.environment.node = 'v22.19.0'; }, /runtime differs/],
  ['fixture drift', manifest => { manifest.samples[1].report.inputs.fixtureSha256 = 'changed'; }, /strictly equal/],
  ['bundle drift', manifest => { manifest.samples[1].report.inputs.bundleSha256 = 'changed'; }, /strictly equal/],
  ['false product proof', manifest => { manifest.samples[1].report.product.proofValid = false; }, /proof is required/],
  ['missing editor transition', manifest => { manifest.samples[1].report.editor.saveOperations.pop(); }, /strictly equal/],
  ['different editor text', manifest => { manifest.samples[1].report.editor.typeOperations[0].textSha256 = 'different'; }, /editor operations differ/],
  ['omitted earlier high milestone', manifest => { manifest.samples[1].report.memory.milestones.push({ rssMiB: 999 }); }, /milestone must be included/],
]) {
  test(`aggregation rejects ${name} instead of selecting a subset`, () => {
    const manifest = validManifest(); mutate(manifest);
    assert.throws(() => aggregateSamples(manifest), expected);
  });
}
