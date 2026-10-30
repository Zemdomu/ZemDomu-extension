import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireTool = createRequire(new URL('../open-vsx-tools/package.json', import.meta.url));
const { SaxesParser } = requireTool('saxes');

export const repository = 'Zemdomu/ZemDomu-extension';
export const workflowPath = '.github/workflows/publish-open-vsx.yml';
const maxSize = 2 * 1024 * 1024;
const runtimeFiles = [
  'dist/extension.js', 'package.json', 'readme.md', 'changelog.md', 'LICENSE.txt',
  'images/icon.png', 'images/marketplace-cross-component.png',
  'images/marketplace-diagnostic.png', 'images/marketplace-vue-remediation.png',
];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateRequest(env) {
  assert.equal(env.GITHUB_REPOSITORY, repository, 'Only the public Extension repository may distribute this artifact.');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Run the reviewed workflow on main.');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Publishing requires an explicit manual dispatch.');
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/${workflowPath}@refs/heads/main`, 'Unexpected publishing workflow.');
  assert.match(env.RELEASE_VERSION ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Supply an exact published version.');
  assert.match(env.EXPECTED_SHA256 ?? '', /^[a-f0-9]{64}$/, 'Supply the reviewed VSIX SHA-256 digest.');
  assert.ok(['true', 'false'].includes(env.RELEASE_PRERELEASE), 'Specify the release channel explicitly.');
  return { version: env.RELEASE_VERSION, digest: env.EXPECTED_SHA256, prerelease: env.RELEASE_PRERELEASE === 'true' };
}

export function validateRelease(release, request) {
  assert.equal(release?.tag_name, `v${request.version}`, 'Release tag differs from the selected version.');
  assert.equal(release.draft, false, 'Draft releases cannot be distributed.');
  assert.equal(release.prerelease, request.prerelease, 'Preserve the existing release channel; do not promote a pre-release.');
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'Invalid release identity.');
  const assets = release.assets?.filter(asset => asset.name === 'zemdomu.vsix');
  assert.equal(assets?.length, 1, 'The release must contain exactly one zemdomu.vsix.');
  const asset = assets[0];
  assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0, 'Invalid asset identity.');
  assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size < maxSize, 'VSIX must stay below the existing 2 MiB budget.');
  assert.equal(asset.digest, `sha256:${request.digest}`, 'GitHub asset digest differs from the reviewed digest.');
  return { releaseId: release.id, assetId: asset.id, size: asset.size, digest: asset.digest };
}

export function validateVsix(file, request, exec = execFileSync) {
  const options = { encoding: 'utf8', maxBuffer: maxSize };
  const files = exec('unzip', ['-Z1', file], options).trim().split(/\r?\n/).filter(name => !name.endsWith('/'));
  assert.equal(new Set(files).size, files.length, 'Duplicate archive entries are not allowed.');
  assert.deepEqual([...files].sort(), ['[Content_Types].xml', 'extension.vsixmanifest', ...runtimeFiles.map(name => `extension/${name}`)].sort(), 'Archive differs from the inspected runtime-only package.');
  const pkg = JSON.parse(exec('unzip', ['-p', file, 'extension/package.json'], options));
  assert.equal(pkg.publisher, 'ZachariasErydBerlin', 'Unexpected publisher namespace.');
  assert.equal(pkg.name, 'zemdomu', 'Unexpected extension name.');
  assert.equal(pkg.version, request.version, 'Packaged version differs from the release.');
  const manifest = exec('unzip', ['-p', file, 'extension.vsixmanifest'], options);
  const identities = [], flags = [];
  const attribute = (tag, name) => {
    const values = Object.values(tag.attributes).filter(value => value.local === name);
    assert.equal(values.length, 1, `Missing or duplicate ${name} attribute.`);
    assert.ok(values[0].name === name && values[0].uri === '', `Namespaced ${name} attribute is not accepted.`);
    return values[0].value;
  };
  const parser = new SaxesParser({ xmlns: true });
  let rootSeen = false;
  const namespace = 'http://schemas.microsoft.com/developer/vsx-schema/2011';
  parser.on('error', error => { throw error; });
  parser.on('doctype', () => { throw new Error('DTD declarations are not allowed in the release manifest.'); });
  parser.on('opentag', tag => {
    if (!rootSeen) {
      assert.equal(tag.name, 'PackageManifest', 'Unexpected manifest root.');
      assert.equal(tag.uri, namespace, 'Unexpected manifest namespace.');
      rootSeen = true;
    }
    if (tag.local === 'Identity' || tag.local === 'Property') {
      assert.equal(tag.name, tag.local, 'Prefixed metadata is not accepted by this distribution policy.');
      assert.equal(tag.uri, namespace, 'Metadata namespace differs from the VSIX schema.');
    }
    if (tag.local === 'Identity') identities.push(tag);
    if (tag.local === 'Property' && attribute(tag, 'Id') === 'Microsoft.VisualStudio.Code.PreRelease') flags.push(attribute(tag, 'Value'));
  });
  parser.write(manifest).close();
  assert.equal(identities.length, 1, 'VSIX must have exactly one manifest identity.');
  assert.equal(attribute(identities[0], 'Id'), pkg.name, 'Manifest extension name differs from package metadata.');
  assert.equal(attribute(identities[0], 'Publisher'), pkg.publisher, 'Manifest publisher differs from package metadata.');
  assert.equal(attribute(identities[0], 'Version'), pkg.version, 'Manifest version differs from package metadata.');
  assert.ok(flags.length <= 1 && flags.every(value => value === 'true'), 'Ambiguous pre-release marker.');
  assert.equal(flags.length === 1, request.prerelease, 'The packaged channel differs from GitHub.');
}

export function prepareOpenVsx({ env = process.env, exec = execFileSync } = {}) {
  const request = validateRequest(env);
  assert.ok(env.RUNNER_TEMP && path.isAbsolute(env.RUNNER_TEMP), 'Use an isolated runner temporary directory.');
  const options = { maxBuffer: maxSize, stdio: ['pipe', 'pipe', 'pipe'] };
  const api = suffix => exec('gh', ['api', `repos/${repository}/${suffix}`], options);
  const readRelease = () => validateRelease(JSON.parse(api(`releases/tags/v${request.version}`).toString()), request);
  const before = readRelease();
  const bytes = exec('gh', ['api', `repos/${repository}/releases/assets/${before.assetId}`, '-H', 'Accept: application/octet-stream'], options);
  assert.ok(Buffer.isBuffer(bytes), 'Download must return bytes, not a path or URL.');
  assert.equal(bytes.length, before.size, 'Downloaded size differs from release metadata.');
  assert.equal(sha256(bytes), request.digest, 'Downloaded bytes differ from the reviewed VSIX.');
  const directory = fs.mkdtempSync(path.join(env.RUNNER_TEMP, 'open-vsx-'));
  const file = path.join(directory, 'zemdomu.vsix');
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  validateVsix(file, request, exec);
  assert.deepEqual(readRelease(), before, 'Release asset changed while downloading; stop and review again.');
  fs.writeFileSync(path.join(directory, 'distribution.json'), JSON.stringify({ repository, ...request, ...before }, null, 2) + '\n');
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `directory=${directory}\n`);
  return { directory, ...request, ...before };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(prepareOpenVsx())); }
  catch { console.error('Open VSX verification failed. No registry upload was attempted. Check the selected release, digest, channel and archive.'); process.exitCode = 1; }
}
