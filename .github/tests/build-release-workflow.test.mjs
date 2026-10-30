import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
const workflow = read('.github/workflows/build-release-artifact.yml');
const build = workflow.split('\n  build:\n')[1]?.split('\n  attest:\n')[0];
const attest = workflow.split('\n  attest:\n')[1];
function ordered(text, values) {
  let previous = -1;
  for (const value of values) {
    const index = text.indexOf(value);
    assert.ok(index > previous, `Missing or incorrectly ordered boundary: ${value}`);
    previous = index;
  }
}
function permissions(job) {
  return job.match(/    permissions:\n((?:      [^\n]+\n)+)/)?.[1].trim().split('\n').map(s => s.trim()).sort();
}

test('only an explicit public main manual build accepts version, commit and boolean channel', () => {
  assert.ok(build && attest);
  const events = workflow.split('\non:\n')[1].split('\npermissions:')[0];
  assert.deepEqual([...events.matchAll(/^      (\w+):$/gm)].map(m => m[1]), ['expected_commit', 'version', 'prerelease']);
  assert.match(events, /^  workflow_dispatch:/m);
  assert.doesNotMatch(events, /^  (push|pull_request|pull_request_target|repository_dispatch|workflow_run|schedule):/m);
  assert.match(events, /prerelease:\n(?:[^\n]*\n)*?        type: boolean/);
  for (const job of [build, attest]) {
    assert.match(job, /github\.repository == 'Zemdomu\/ZemDomu-extension'/);
    assert.match(job, /github\.ref == 'refs\/heads\/main'/);
    assert.match(job, /github\.event_name == 'workflow_dispatch'/);
    assert.match(job, /ref: \$\{\{ github.sha \}\}/);
    assert.match(job, /persist-credentials: false/);
    assert.match(job, /runs-on: ubuntu-latest/);
  }
  assert.doesNotMatch(workflow, /secrets\.|VSCE_PAT|MIRROR_SYNC_PAT|vsce publish|gh release|git push|npm version|continue-on-error/);
});

test('attestation privileges are isolated from dependency installation and product execution', () => {
  assert.deepEqual(permissions(build), ['actions: read', 'contents: read']);
  assert.deepEqual(permissions(attest), ['actions: read', 'attestations: write', 'contents: read', 'id-token: write']);
  assert.match(attest, /needs: build/);
  assert.doesNotMatch(attest, /npm |npx |xvfb|test:|package\.json/);
  assert.match(attest, /create-storage-record: false/);
  const pins = new Map([
    ['checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
    ['setup-node', '949feb2413d6458794dcd2491c4babbbce0c15c1'],
    ['upload-artifact', '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'],
    ['download-artifact', '9000827ccba6bdab643e8b6fd33ac0654aef8333'],
    ['attest', '1e69f48acb82d1966a394da916b4c1698aa569d6'],
  ]);
  for (const match of workflow.matchAll(/uses: actions\/([^@\s]+)@([^\s]+)/g)) assert.equal(match[2], pins.get(match[1]), `Unreviewed action reference ${match[0]}`);
  assert.equal([...workflow.matchAll(/uses:/g)].length, 8);
});

test('all mandatory checks precede binding, and immutable artifact verification precedes attestation', () => {
  ordered(build, ['Verify exact public source and all release gates', 'Install locked dependencies', 'Validate mapped TypeScript coverage', 'Build, audit, test and install final VSIX', 'Bind inspected VSIX and public metadata', 'Retain inspected public build']);
  ordered(build, ['xvfb-run -a npm run release:check', 'vsce package --pre-release', 'node tests/package-contents.test.js', 'node tests/package-size.test.js --vsix', 'xvfb-run -a npm run test:vsix-install']);
  ordered(attest, ['Download inspected build by immutable artifact ID', 'Verify inspected build identity and all release gates', 'Attest exact inspected VSIX', 'Preserve original provenance bundle and DSSE', 'Retain attested public release artifact']);
  assert.match(attest, /artifact-ids: \$\{\{ needs.build.outputs.artifact-id \}\}/);
  assert.doesNotMatch(attest, /\n          name:.*input-/);
  for (const output of ['artifact-id', 'artifact-digest', 'vsix-digest', 'candidate-digest']) assert.ok(attest.includes(`needs.build.outputs.${output}`));
  assert.match(attest, /BUILD_ARTIFACT_DIGEST: sha256:\$\{\{ needs.build.outputs.artifact-digest \}\}/);
  assert.match(attest, /subject-path: \$\{\{ env.BUILD_OUTPUT \}\}\/zemdomu.vsix/);
  assert.match(attest, /ATTESTATION_BUNDLE_PATH: \$\{\{ steps.provenance.outputs.bundle-path \}\}/);
  assert.equal([...workflow.matchAll(/overwrite: false/g)].length, 2);
  assert.equal([...workflow.matchAll(/if-no-files-found: error/g)].length, 2);
});

test('public CI runs both offline security contracts and package boundaries exclude builder metadata', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.ok(ci.includes('node --test .github/tests/build-release-artifact.test.mjs .github/tests/build-release-workflow.test.mjs'));
  ordered(ci, ['Test public build boundaries offline', 'Install locked dependencies', 'Validate source-mapped TypeScript coverage', 'Test, package, and inspect VSIX', 'Install packaged extension in a clean VS Code profile']);
  assert.match(read('.vscodeignore'), /^\.github\/$/m);
  assert.equal(JSON.parse(read('package.json')).scripts['release:check'], 'npm run audit:production && npm run audit:all && npm run package && npm run test:vsix-install');
  for (const file of ['.github/tests/build-release-artifact.test.mjs', '.github/tests/build-release-workflow.test.mjs']) assert.ok(fs.statSync(fileURLToPath(new URL(file, root))).isFile());
});
