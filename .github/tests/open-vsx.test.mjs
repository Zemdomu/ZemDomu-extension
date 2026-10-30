import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repository, workflowPath, sha256, validateRequest, validateRelease, validateVsix, prepareOpenVsx } from '../scripts/prepare-open-vsx.mjs';

const bytes = Buffer.from('reviewed package bytes');
const request = { version: '0.1.3', digest: sha256(bytes), prerelease: true };
const env = {
  GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: `${repository}/${workflowPath}@refs/heads/main`, RELEASE_VERSION: '0.1.3',
  EXPECTED_SHA256: request.digest, RELEASE_PRERELEASE: 'true',
};
const release = () => ({ id: 10, tag_name: 'v0.1.3', draft: false, prerelease: true,
  assets: [{ id: 20, name: 'zemdomu.vsix', size: bytes.length, digest: `sha256:${request.digest}` }] });
const files = ['[Content_Types].xml', 'extension.vsixmanifest', ...[
  'dist/extension.js', 'package.json', 'readme.md', 'changelog.md', 'LICENSE.txt', 'images/icon.png',
  'images/marketplace-cross-component.png', 'images/marketplace-diagnostic.png', 'images/marketplace-vue-remediation.png',
].map(name => `extension/${name}`)];
const pkg = { name: 'zemdomu', publisher: 'ZachariasErydBerlin', version: '0.1.3' };
const manifest = '<Identity Id="zemdomu" Publisher="ZachariasErydBerlin" Version="0.1.3" /><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />';
function archive({ entries = files, metadata = pkg, xml = manifest } = {}) {
  return (command, args) => {
    assert.equal(command, 'unzip');
    if (args[0] === '-Z1') return entries.join('\n');
    if (args[2] === 'extension/package.json') return JSON.stringify(metadata);
    if (args[2] === 'extension.vsixmanifest') return xml;
    throw new Error('Unexpected archive read');
  };
}

test('manual public-main selection rejects other repositories, branches, workflows, malformed versions and channels', () => {
  assert.deepEqual(validateRequest(env), request);
  for (const [key, value] of [
    ['GITHUB_REPOSITORY', 'another/repository'], ['GITHUB_REF', 'refs/heads/fix'],
    ['GITHUB_EVENT_NAME', 'pull_request'], ['GITHUB_WORKFLOW_REF', `${repository}/other.yml@refs/heads/main`],
    ['RELEASE_VERSION', '0.1.3; command'], ['RELEASE_VERSION', 'latest'], ['EXPECTED_SHA256', 'invalid'],
    ['RELEASE_PRERELEASE', 'yes'],
  ]) assert.throws(() => validateRequest({ ...env, [key]: value }), key);
});

test('release selection fails closed on draft/channel/version/digest/size/identity/duplicate mismatches', () => {
  assert.equal(validateRelease(release(), request).assetId, 20);
  for (const patch of [{ draft: true }, { prerelease: false }, { tag_name: 'v0.1.2' }, { id: 0 }]) {
    assert.throws(() => validateRelease({ ...release(), ...patch }, request));
  }
  for (const patch of [{ digest: `sha256:${'0'.repeat(64)}` }, { size: 2 * 1024 * 1024 }, { id: -1 }, { size: 0 }]) {
    const changed = release(); Object.assign(changed.assets[0], patch);
    assert.throws(() => validateRelease(changed, request));
  }
  const duplicate = release(); duplicate.assets.push({ ...duplicate.assets[0] });
  assert.throws(() => validateRelease(duplicate, request));
});

test('archive inspection rejects extra files, duplicates, identity conflicts and channel promotion', () => {
  validateVsix('package.vsix', request, archive());
  for (const entries of [[...files, 'extension/src/internal.ts'], [...files, '../outside'], [...files, files[0]], files.slice(1)]) {
    assert.throws(() => validateVsix('package.vsix', request, archive({ entries })));
  }
  for (const metadata of [{ ...pkg, publisher: 'other' }, { ...pkg, name: 'other' }, { ...pkg, version: '0.1.4' }]) {
    assert.throws(() => validateVsix('package.vsix', request, archive({ metadata })));
  }
  for (const xml of [manifest.replace('Publisher="ZachariasErydBerlin"', 'Publisher="other"'), manifest.replace('Value="true"', 'Value="false"'), manifest.replace('<Identity', '<Other')]) {
    assert.throws(() => validateVsix('package.vsix', request, archive({ xml })));
  }
  assert.throws(() => validateVsix('package.vsix', { ...request, prerelease: false }, archive()));
});

test('download binds exact bytes, rechecks metadata, and never executes or publishes the extension', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-vsx-contract-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  function run({ downloaded = bytes, mutate = false } = {}) {
    let reads = 0;
    const exec = (command, args) => {
      if (command === 'unzip') return archive()(command, args);
      assert.equal(command, 'gh'); assert.equal(args[0], 'api');
      if (args[1].includes('/releases/assets/')) return downloaded;
      const data = release(); if (mutate && reads++ > 0) data.assets[0].id = 99;
      return Buffer.from(JSON.stringify(data));
    };
    return prepareOpenVsx({ env: { ...env, RUNNER_TEMP: temp }, exec });
  }
  const result = run(); assert.deepEqual(fs.readFileSync(path.join(result.directory, 'zemdomu.vsix')), bytes);
  assert.throws(() => run({ downloaded: Buffer.from('different bytes') }));
  assert.throws(() => run({ mutate: true }));
});

test('distribution workflow defaults to verification, uses locked tools, and grants publishing only to the gated job', () => {
  const workflow = fs.readFileSync(new URL('../workflows/publish-open-vsx.yml', import.meta.url), 'utf8');
  const verify = workflow.split('\n  verify:\n')[1].split('\n  publish:\n')[0];
  const publish = workflow.split('\n  publish:\n')[1];
  assert.match(workflow, /dry_run:\n(?:[^\n]*\n)*?        default: true/);
  assert.doesNotMatch(workflow, /\n  (push|pull_request|workflow_run|schedule):|secrets\.|OVSX_PAT|skip-duplicate|continue-on-error/);
  assert.doesNotMatch(verify, /id-token: write|npm ci|ovsx publish/);
  assert.match(publish, /!inputs.dry_run/); assert.match(publish, /environment: open-vsx/);
  assert.match(publish, /artifact-ids: \$\{\{ needs.verify.outputs.artifact_id \}\}/);
  assert.match(publish, /npm ci --ignore-scripts --prefix \.github\/open-vsx-tools/);
  assert.match(publish, /--trusted-publishing/); assert.match(publish, /--pre-release/);
  assert.doesNotMatch(publish, /vsce package|npm version|npm run (bundle|compile|package)/);
  for (const line of workflow.matchAll(/uses: ([^\n]+)/g)) assert.match(line[1], /@[a-f0-9]{40}\b/);
});
