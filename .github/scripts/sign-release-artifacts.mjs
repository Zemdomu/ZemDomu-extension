#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPOSITORIES = new Set(["Zemdomu/ZemDomu-core", "Zemdomu/ZemDomu-extension", "Zemdomu/ZemDomu-action"]);
const WORKFLOW = ".github/workflows/sign-release-artifacts.yml";
const ISSUER = "https://token.actions.githubusercontent.com";
const OID = /^[a-f0-9]{40}$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_ASSET_SIZE = 64 * 1024 * 1024;
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = message => { throw new Error(message); };
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

function defaultExec(command, args, options = {}) {
  try {
    return execFileSync(command, args, { maxBuffer: MAX_ASSET_SIZE, stdio: ["pipe", "pipe", "pipe"], ...options });
  } catch { fail(`${command} failed while processing release signatures; no existing assets were overwritten.`); }
}

function validateRelease(release, tag, repository) {
  if (!positiveInteger(release?.id) || release.tag_name !== tag || release.draft !== false || !Array.isArray(release.assets)) {
    fail("Expected a published, non-draft release with the exact requested tag.");
  }
  const assets = new Map();
  const ids = new Set();
  for (const asset of release.assets) {
    if (typeof asset?.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,220}$/.test(asset.name) ||
        !positiveInteger(asset.id) || ids.has(asset.id) || assets.has(asset.name) ||
        !positiveInteger(asset.size) || asset.size > MAX_ASSET_SIZE || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
      fail("Release asset has an unsafe name, duplicate identity, missing SHA-256 digest, or invalid size.");
    }
    assets.set(asset.name, { id: asset.id, name: asset.name, size: asset.size, digest: asset.digest });
    ids.add(asset.id);
  }
  const version = tag.slice(1);
  const names = repository.endsWith("-core") ? [`zemdomu-${version}.tgz`]
    : repository.endsWith("-extension") ? ["zemdomu.vsix"]
      : [`zemdomu-action-${version}.tgz`, "zemdomu-action.tgz"];
  const artifacts = names.filter(name => assets.has(name)).map(name => assets.get(name));
  if (artifacts.length === 0) fail("Release has no matching product artifact; nothing can be signed.");
  return { id: release.id, assets, artifacts };
}

function fingerprint(release) {
  return JSON.stringify({ id: release.id, assets: [...release.assets.values()].sort((a, b) => a.name.localeCompare(b.name)) });
}

/** Sign existing release bytes. This is an artifact signature, not build provenance. */
export async function signReleaseArtifacts({ tag, env = process.env, exec = defaultExec } = {}) {
  const repository = env.GITHUB_REPOSITORY;
  if (!REPOSITORIES.has(repository)) fail("Signing is restricted to the three public product repositories.");
  if (typeof tag !== "string" || !TAG.test(tag)) fail("A stable vMAJOR.MINOR.PATCH release tag is required.");
  if (env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_WORKFLOW_REF !== `${repository}/${WORKFLOW}@refs/heads/main`) {
    fail("Signing must run from this repository's reviewed workflow on main.");
  }
  if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP) || !fs.statSync(env.RUNNER_TEMP).isDirectory()) {
    fail("An existing absolute RUNNER_TEMP directory is required.");
  }
  if (env.GITHUB_SHA !== undefined && !OID.test(env.GITHUB_SHA)) fail("The signing workflow commit must be a full SHA-1.");
  const endpoint = `repos/${repository}`;
  const api = (suffix, binary = false) => {
    const args = ["api", `${endpoint}/${suffix}`];
    if (binary) args.push("-H", "Accept: application/octet-stream");
    const output = exec("gh", args, binary ? {} : { encoding: "utf8" });
    if (binary) {
      if (!Buffer.isBuffer(output)) fail("Artifact download did not return binary bytes.");
      return output;
    }
    try { return JSON.parse(output.toString()); } catch { fail("GitHub returned malformed release or tag metadata."); }
  };
  const readRelease = () => validateRelease(api(`releases/tags/${encodeURIComponent(tag)}`), tag, repository);
  const readTag = () => {
    const ref = api(`git/ref/tags/${encodeURIComponent(tag)}`);
    if (ref?.ref !== `refs/tags/${tag}` || !OID.test(ref.object?.sha)) fail("Unexpected release tag identity.");
    const direct = ref.object.sha;
    let object = ref.object;
    const seen = new Set();
    while (object.type === "tag") {
      if (!OID.test(object.sha) || seen.has(object.sha) || seen.size >= 4) fail("Invalid annotated release tag chain.");
      seen.add(object.sha);
      object = api(`git/tags/${object.sha}`)?.object;
      if (!object || !OID.test(object.sha)) fail("Malformed annotated release tag.");
    }
    if (object.type !== "commit") fail("Release tag must resolve to a commit.");
    return `${direct}:${object.sha}`;
  };
  const original = readRelease();
  const originalTag = readTag();
  const temporary = fs.mkdtempSync(path.join(env.RUNNER_TEMP, "release-signatures-"));
  const identity = `https://github.com/${repository}/${WORKFLOW}@refs/heads/main`;
  const download = asset => {
    const bytes = api(`releases/assets/${asset.id}`, true);
    if (bytes.length !== asset.size || digest(bytes) !== asset.digest) fail(`Asset ${asset.name} does not match its release digest and size.`);
    const file = path.join(temporary, asset.name);
    fs.writeFileSync(file, bytes, { flag: "wx" });
    return file;
  };
  const verify = (artifact, bundle, currentWorkflow = false) => {
    const args = ["verify-blob", "--bundle", bundle, "--certificate-identity", identity, "--certificate-oidc-issuer", ISSUER];
    if (currentWorkflow && env.GITHUB_SHA) args.push("--certificate-github-workflow-sha", env.GITHUB_SHA);
    args.push(artifact);
    exec("cosign", args, { encoding: "utf8" });
  };
  const pending = [];
  let reused = 0;
  try {
    for (const asset of original.artifacts) {
      const artifact = download(asset);
      const bundleName = `${asset.name}.sigstore.json`;
      const existing = original.assets.get(bundleName);
      if (existing) {
        verify(artifact, download(existing));
        reused += 1;
      } else {
        const bundle = path.join(temporary, bundleName);
        exec("cosign", ["sign-blob", "--yes", "--bundle", bundle, artifact], { encoding: "utf8" });
        const bytes = fs.readFileSync(bundle);
        if (bytes.length === 0 || bytes.length > MAX_ASSET_SIZE) fail("Signing produced an invalid signature bundle size.");
        verify(artifact, bundle, true);
        pending.push({ name: bundleName, path: bundle, digest: digest(bytes), size: bytes.length, artifact });
      }
    }
    if (fingerprint(readRelease()) !== fingerprint(original) || readTag() !== originalTag) {
      fail("Release assets or tag changed while signing; no new bundles were uploaded.");
    }
    if (pending.length > 0) {
      // No --clobber: a concurrent upload must fail rather than replace a bundle.
      exec("gh", ["release", "upload", tag, ...pending.map(bundle => bundle.path), "--repo", repository], { encoding: "utf8" });
      const uploaded = readRelease();
      if (readTag() !== originalTag) fail("Release tag changed during signature upload.");
      const expectedNames = [...original.assets.keys(), ...pending.map(bundle => bundle.name)].sort();
      if (uploaded.id !== original.id || JSON.stringify([...uploaded.assets.keys()].sort()) !== JSON.stringify(expectedNames)) {
        fail("Release identity or asset set changed during signature upload.");
      }
      for (const [name, asset] of original.assets) {
        if (JSON.stringify(uploaded.assets.get(name)) !== JSON.stringify(asset)) fail("An existing release asset changed during signature upload.");
      }
      for (const bundle of pending) {
        const remote = uploaded.assets.get(bundle.name);
        if (!remote || remote.size !== bundle.size || remote.digest !== bundle.digest) fail("Uploaded signature bundle differs from the verified local bundle.");
        // Download independently and verify the bytes users will receive.
        fs.unlinkSync(bundle.path);
        verify(bundle.artifact, download(remote));
      }
    }
    return { repository, tag, artifacts: original.artifacts.length, signed: pending.length, reused };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    process.stderr.write("Usage: sign-release-artifacts.mjs vMAJOR.MINOR.PATCH\n");
    process.exitCode = 1;
  } else {
    signReleaseArtifacts({ tag: process.argv[2] }).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
      process.stderr.write(`release-signing: ${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
