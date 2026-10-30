const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;
const PROTOCOL = Object.freeze({
  pairCount: 5,
  versions: ['1.105.0', '1.144.0'],
  settleMs: 1000,
  typeCount: 20,
  typeCadenceMs: 200,
  saveCount: 100,
  saveCadenceMs: 50,
  sampleIntervalMs: 5,
});
// Hash of the three original release-harness fixture declarations below.
// A release-fixture change requires explicit review of this diagnostic contract.
const FIXTURE_FACTORY_SHA256 = '996af7bcbcd6e1b9fc9c7951c7dfcf4e5702d250668773f5cd2cf44f85d7d8da';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixtureFactorySource(runnerPath) {
  // Git may check out CRLF on Windows. Normalize source line endings only;
  // fixture string values are single-line and remain byte-identical.
  const source = fs.readFileSync(runnerPath, 'utf8').replace(/\r\n/g, '\n');
  const count = source.match(/^const FILE_COUNT = 100;$/m);
  const starts = ['const fixtures = {', 'function createWorkspace() {'];
  const ends = ['\n\nfunction percentile(', '\n\nasync function main()'];
  const sections = starts.map((start, index) => {
    assert.strictEqual(source.split(start).length, 2, `Unique fixture start: ${start}`);
    assert.strictEqual(source.split(ends[index]).length, 2, `Unique fixture end: ${ends[index]}`);
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(ends[index]);
    assert.ok(endIndex > startIndex, 'Fixture declaration boundaries must be ordered');
    return source.slice(startIndex, endIndex);
  });
  assert.ok(count, 'Original fixture count must remain 100');
  const script = [count[0], ...sections].join('\n');
  assert.strictEqual(sha256(script), FIXTURE_FACTORY_SHA256, 'Release fixture factory changed; review parity before measuring');
  return script;
}

function createOriginalWorkspace(runnerPath) {
  // Only the hash-checked factory declarations are evaluated, never main(),
  // downloader setup, release assertions, or arbitrary imported modules.
  return new Function('fs', 'os', 'path', `${fixtureFactorySource(runnerPath)}\nreturn createWorkspace();`)(fs, os, path);
}

function fixtureIdentity(workspace) {
  const entries = fs.readdirSync(workspace).filter(name => /\.(html|jsx|tsx|vue)$/.test(name)).sort();
  assert.strictEqual(entries.length, 100, 'Every sample must start with the original 100 source files');
  const files = [...entries, '.vscode/settings.json'].map(name => ({
    name,
    sha256: sha256(fs.readFileSync(path.join(workspace, name))),
  }));
  return { sourceFileCount: entries.length, files, sha256: sha256(JSON.stringify(files)) };
}

function samplePlan() {
  return Array.from({ length: PROTOCOL.pairCount }, (_, index) => {
    const pairId = index + 1;
    const order = index % 2 === 0 ? ['control', 'treatment'] : ['treatment', 'control'];
    return order.map((condition, position) => ({
      pairId,
      position: position + 1,
      order: order.join('-then-'),
      condition,
      sampleId: `pair-${pairId}-${position + 1}-${condition}`,
    }));
  }).flat();
}

function controlManifest(productManifest) {
  return {
    name: 'inert-baseline-control',
    publisher: 'local-diagnostic',
    version: '0.0.0',
    engines: { vscode: productManifest.engines.vscode },
    activationEvents: [],
    contributes: { configuration: productManifest.contributes.configuration },
  };
}

function distribution(values) {
  assert.ok(values.length > 0 && values.every(Number.isFinite), 'Distribution requires finite observations');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: values.length,
    min: sorted[0],
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted.at(-1),
    range: sorted.at(-1) - sorted[0],
    descriptiveP95SmallN: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

function aggregateSamples(manifest) {
  const expected = samplePlan();
  assert.strictEqual(manifest.samples.length, expected.length, 'All ten predetermined launches must be retained');
  const byId = new Map();
  for (const [index, sample] of manifest.samples.entries()) {
    for (const key of ['pairId', 'position', 'order', 'condition', 'sampleId']) {
      assert.strictEqual(sample[key], expected[index][key], `Sample plan mismatch: ${key}`);
    }
    assert.strictEqual(sample.status, 'passed', `Missing/failed sample: ${sample.sampleId}`);
    assert.ok(!byId.has(sample.sampleId), 'Duplicate sample cannot replace a failed launch');
    byId.set(sample.sampleId, sample);
    const report = sample.report;
    assert.strictEqual(report.schemaVersion, SCHEMA_VERSION);
    assert.strictEqual(report.status, 'passed', `Host did not complete: ${sample.sampleId}`);
    assert.deepStrictEqual(report.sample, expected[index], 'Host report must belong to the scheduled sample');
    assert.strictEqual(report.cell, manifest.cell, 'Host report must belong to this matrix cell');
    assert.deepStrictEqual(report.protocol, PROTOCOL);
    assert.strictEqual(report.environment.vscode, manifest.vscodeVersion);
    assert.strictEqual(report.inputs.fixtureSha256, manifest.fixture.sha256);
    assert.strictEqual(report.inputs.sourceSha256, manifest.source.sha256);
    assert.strictEqual(report.inputs.bundleSha256, manifest.source.bundleSha256);
    assert.strictEqual(report.editor.typeOperations.length, PROTOCOL.typeCount);
    assert.strictEqual(report.editor.saveOperations.length, PROTOCOL.saveCount);
    assert.strictEqual(report.workspaceFileCount, 100);
    assert.strictEqual(report.product.proofValid, true, 'Product presence/absence proof is required');
    assert.ok(Number.isFinite(report.memory.fullWindowPeakRssMiB));
    assert.ok(Number.isFinite(report.memory.saveWindowPeakRssMiB));
    assert.ok(report.memory.fullWindowPeakRssMiB >= report.memory.saveWindowPeakRssMiB, 'Save window is inside the full sampled window');
    assert.ok(report.memory.milestones.every(item => item.rssMiB <= report.memory.fullWindowPeakRssMiB), 'Every milestone must be included in the full sampled maximum');
  }
  const pairedDeltas = [];
  for (let pairId = 1; pairId <= PROTOCOL.pairCount; pairId += 1) {
    const pair = manifest.samples.filter(sample => sample.pairId === pairId);
    const control = pair.find(sample => sample.condition === 'control').report;
    const treatment = pair.find(sample => sample.condition === 'treatment').report;
    for (const key of ['vscode', 'node', 'electron', 'platform', 'architecture']) {
      assert.strictEqual(control.environment[key], treatment.environment[key], `Paired runtime differs: ${key}`);
    }
    for (const kind of ['typeOperations', 'saveOperations']) {
      assert.deepStrictEqual(control.editor[kind].map(item => [item.index, item.expectedMissingAlt, item.textSha256, item.cadenceMs]), treatment.editor[kind].map(item => [item.index, item.expectedMissingAlt, item.textSha256, item.cadenceMs]), `Paired common editor operations differ: ${kind}`);
    }
    pairedDeltas.push({
      pairId,
      order: pair[0].order,
      controlPeakRssMiB: control.memory.fullWindowPeakRssMiB,
      treatmentPeakRssMiB: treatment.memory.fullWindowPeakRssMiB,
      deltaMiB: treatment.memory.fullWindowPeakRssMiB - control.memory.fullWindowPeakRssMiB,
      controlSavePeakRssMiB: control.memory.saveWindowPeakRssMiB,
      treatmentSavePeakRssMiB: treatment.memory.saveWindowPeakRssMiB,
      saveDeltaMiB: treatment.memory.saveWindowPeakRssMiB - control.memory.saveWindowPeakRssMiB,
    });
  }
  return {
    interpretation: 'Matched process-workload differences; not precise extension ownership. No automatic budget or replacement threshold.',
    pairedDeltas,
    fullWindow: {
      control: distribution(pairedDeltas.map(pair => pair.controlPeakRssMiB)),
      treatment: distribution(pairedDeltas.map(pair => pair.treatmentPeakRssMiB)),
      pairedDelta: distribution(pairedDeltas.map(pair => pair.deltaMiB)),
    },
    saveWindow: {
      control: distribution(pairedDeltas.map(pair => pair.controlSavePeakRssMiB)),
      treatment: distribution(pairedDeltas.map(pair => pair.treatmentSavePeakRssMiB)),
      pairedDelta: distribution(pairedDeltas.map(pair => pair.saveDeltaMiB)),
    },
  };
}

module.exports = { SCHEMA_VERSION, PROTOCOL, FIXTURE_FACTORY_SHA256, sha256, fixtureFactorySource, createOriginalWorkspace, fixtureIdentity, samplePlan, controlManifest, distribution, aggregateSamples };
