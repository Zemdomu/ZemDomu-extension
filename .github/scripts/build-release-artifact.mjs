#!/usr/bin/env node
// This public builder never publishes or accepts Marketplace credentials.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

export const REPOSITORY = "Zemdomu/ZemDomu-extension";
export const WORKFLOW_PATH = ".github/workflows/build-release-artifact.yml";
export const FILES = Object.freeze({ vsix: "zemdomu.vsix", candidate: "public-extension-candidate.json", bundle: "zemdomu.vsix.build-provenance.sigstore.json", dsse: "zemdomu.vsix.intoto.jsonl" });
export const WORKFLOWS = Object.freeze({
  ci: { id: 400703514, path: ".github/workflows/ci.yml", event: "push" },
  codeql: { id: 400703516, path: ".github/workflows/codeql.yml", event: "push" },
  host: { id: 400712771, path: ".github/workflows/extension-host.yml", event: "workflow_dispatch" },
});
const prefix = `repos/${REPOSITORY}`;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const fail = message => { throw new Error(message); };
export const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HEADING = /^## (.+)$/;
const CATEGORY_HEADING = /^### (.+)$/;
const CATEGORIES = ["Bugfix", "Feature", "Hotfix", "Security", "Docs", "Breaking", "Chore", "Performance", "Refactor"];
function assertBlankAfter(lines, index, label) { if (lines[index + 1] !== "") fail(`${label} must be followed by a real blank line.`); }

export function parseChangelog(markdown) {
  if (markdown.includes("\\n") || /(^|\s)\/n(?=\s|$)/.test(markdown)) {
    fail("Changelog contains a literal \\n or /n escape instead of a real newline.");
  }
  if (markdown.includes("\r")) {
    fail("Changelog must use LF line endings so release notes are byte-stable.");
  }

  const lines = markdown.split("\n");
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(HEADING);
    if (!match) continue;
    const name = match[1];
    if (name !== "Unreleased" && !SEMVER.test(name)) {
      fail(`Unsupported level-two changelog heading: ${name}`);
    }
    assertBlankAfter(lines, index, `## ${name}`);
    headings.push({ name, index });
  }
  if (headings.length === 0 || headings[0].name !== "Unreleased" || headings[0].index !== 0) {
    fail("Changelog must begin with ## Unreleased.");
  }

  const seen = new Set();
  const sections = new Map();
  for (let position = 0; position < headings.length; position += 1) {
    const heading = headings[position];
    if (seen.has(heading.name)) fail(`Duplicate changelog section: ${heading.name}`);
    seen.add(heading.name);
    const end = headings[position + 1]?.index ?? lines.length;
    const bodyLines = lines.slice(heading.index + 2, end);
    while (bodyLines.at(-1) === "") bodyLines.pop();
    if (heading.name === "Unreleased") validateSectionBody(heading.name, bodyLines);
    sections.set(heading.name, {
      name: heading.name,
      start: heading.index,
      end,
      bodyLines,
      markdown: [`## ${heading.name}`, "", ...bodyLines].join("\n"),
    });
  }
  return { lines, headings, sections };
}

function validateSectionBody(name, bodyLines) {
  if (name === "Unreleased" && bodyLines.length === 0) return;
  if (bodyLines.length === 0) fail(`Changelog section ${name} is empty.`);

  let category = null;
  let categoryBullets = 0;
  const seenCategories = new Set();
  for (let index = 0; index < bodyLines.length; index += 1) {
    const line = bodyLines[index];
    const categoryMatch = line.match(CATEGORY_HEADING);
    if (categoryMatch) {
      if (category && categoryBullets === 0) fail(`Category ${category} has no entries.`);
      if (index > 0 && bodyLines[index - 1] !== "") {
        fail(`### ${categoryMatch[1]} must be preceded by one real blank line.`);
      }
      category = categoryMatch[1];
      categoryBullets = 0;
      if (!CATEGORIES.includes(category)) fail(`Unsupported changelog category: ${category}`);
      if (seenCategories.has(category)) fail(`Duplicate changelog category: ${category}`);
      seenCategories.add(category);
      assertBlankAfter(bodyLines, index, `### ${category}`);
      continue;
    }
    if (line === "") continue;
    if (!category) fail(`Content in ${name} must be under an allowed level-three category.`);
    if (/^\s{2,}\S/.test(line) && categoryBullets > 0) continue;
    if (!line.startsWith(`- ${category}: `)) {
      fail(`Entry under ${category} must start with "- ${category}: ".`);
    }
    if (line === `- ${category}: `) fail(`Entry under ${category} must not be empty.`);
    categoryBullets += 1;
  }
  if (category && categoryBullets === 0) fail(`Category ${category} has no entries.`);
}

export function extractReleaseNotes(markdown, version) {
  if (!SEMVER.test(version)) fail(`Invalid release version: ${version}`);
  const parsed = parseChangelog(markdown);
  const section = parsed.sections.get(version);
  if (!section) fail(`Missing changelog section for ${version}.`);
  validateSectionBody(version, section.bodyLines);
  return `${section.markdown}\n`;
}


export function validateInputs({ expectedCommit, version, prerelease }) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? "")) fail("Expected an exact lowercase 40-character public commit SHA.");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "") ||
      !version.split(".").every(part => Number.isSafeInteger(Number(part)))) fail("Expected a numeric stable version such as 0.1.3.");
  if (typeof prerelease !== "boolean") fail("prerelease must be a boolean.");
}


function assertWorkflow(workflow, spec) {
  if (workflow?.id !== spec.id || workflow.path !== spec.path || workflow.state !== "active") fail(`Public workflow identity changed: ${spec.path}.`);
}

function assertRun(run, spec, expectedCommit, requireSuccess = true) {
  if (!positiveId(run?.id) || !positiveId(run.run_number) || !positiveId(run.run_attempt) ||
      run.workflow_id !== spec.id || run.path !== spec.path || run.event !== spec.event ||
      run.head_branch !== "main" || run.head_sha !== expectedCommit ||
      run.repository?.full_name !== REPOSITORY || run.head_repository?.full_name !== REPOSITORY ||
      run.html_url !== `https://github.com/${REPOSITORY}/actions/runs/${run.id}`) fail(`Run does not match exact public main/workflow identity: ${spec.path}.`);
  if (requireSuccess && (run.status !== "completed" || run.conclusion !== "success")) fail(`Latest exact-source workflow is not successful: ${run.html_url}.`);
}

function sameAttempt(a, b) {
  if (a.id !== b.id || a.run_number !== b.run_number || a.run_attempt !== b.run_attempt) fail("Latest public workflow run or attempt changed during verification.");
}

async function latestRun(github, spec, expectedCommit) {
  const response = await github(`${prefix}/actions/workflows/${spec.id}/runs?branch=main&event=${spec.event}&head_sha=${expectedCommit}&per_page=100`);
  if (!Number.isSafeInteger(response?.total_count) || response.total_count < 1 || response.total_count > 100 ||
      !Array.isArray(response.workflow_runs) || response.workflow_runs.length !== response.total_count) fail("Workflow history is missing, incomplete or exceeds the bounded release gate.");
  const ids = new Set();
  const numbers = new Set();
  for (const run of response.workflow_runs) {
    if (!positiveId(run?.id) || !positiveId(run.run_number) || ids.has(run.id) || numbers.has(run.run_number)) fail("Ambiguous public workflow history.");
    assertRun(run, spec, expectedCommit, false);
    ids.add(run.id); numbers.add(run.run_number);
  }
  const run = response.workflow_runs.reduce((latest, item) => item.run_number > latest.run_number ? item : latest);
  assertRun(run, spec, expectedCommit);
  return run;
}

function successfulStep(job, name) {
  const steps = job.steps?.filter(step => step.name === name) ?? [];
  if (steps.length !== 1 || steps[0].status !== "completed" || steps[0].conclusion !== "success") fail(`Required test step was not executed successfully: ${name}.`);
}

async function verifyJobs(github, spec, run, expectedCommit) {
  const response = await github(`${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  const jobs = response?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0 || response.total_count !== jobs.length || jobs.length > 100) fail("Job history is missing or incomplete.");
  const names = new Set();
  const ids = new Set();
  for (const job of jobs) {
    if (!positiveId(job?.id) || ids.has(job.id) || names.has(job.name) || job.run_id !== run.id ||
        job.run_attempt !== run.run_attempt || job.head_sha !== expectedCommit ||
        job.status !== "completed" || job.conclusion !== "success") fail("A required public job is missing, duplicated, pending, skipped or failed.");
    ids.add(job.id); names.add(job.name);
  }
  if (spec === WORKFLOWS.ci) {
    if (jobs.length !== 1) fail("Unexpected public CI job inventory.");
    for (const name of ["Install locked dependencies", "Validate source-mapped TypeScript coverage", "Test, package, and inspect VSIX", "Install packaged extension in a clean VS Code profile"]) successfulStep(jobs[0], name);
  } else if (spec === WORKFLOWS.codeql) {
    const expected = ["Analyze (actions)", "Analyze (javascript-typescript)"];
    if (jobs.length !== expected.length || expected.some(name => !names.has(name))) fail("Both exact-source CodeQL language jobs must pass.");
    for (const job of jobs) successfulStep(job, "Analyze source");
  } else {
    const expected = ["ubuntu-latest", "windows-latest"].flatMap(os => ["1.105.0", "stable"].map(version => `Extension Host (${os}, VS Code ${version})`));
    if (jobs.length !== 4 || expected.some(name => !names.has(name))) fail("The complete Ubuntu/Windows × VS Code1.105.0/stable matrix is required.");
    for (const job of jobs) {
      const os = job.name.includes("ubuntu-latest") ? "ubuntu-latest" : "windows-latest";
      if (!Array.isArray(job.labels) || !job.labels.includes(os)) fail("Host matrix runner labels do not match the required operating system.");
      successfulStep(job, "Install locked dependencies");
      successfulStep(job, "Test, package, and inspect VSIX");
      successfulStep(job, `Measure real VS Code Extension Host performance on ${job.name.includes("ubuntu-latest") ? "Linux" : "Windows"}`);
    }
  }
  return jobs.map(job => ({ id: job.id, name: job.name }));
}


function xmlAttribute(tag, name) {
  const values = [...tag.matchAll(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, "g"))];
  if (values.length !== 1) fail(`VSIX has missing or duplicate ${name} metadata.`);
  return values[0][1] ?? values[0][2];
}

export function verifyVsixMetadata({ packageJson, vsixManifest, version, prerelease }) {
  if (packageJson?.name !== "zemdomu" || packageJson.publisher !== "ZachariasErydBerlin" || packageJson.version !== version) fail("Packed VSIX package identity/version mismatch.");
  const identities = vsixManifest.match(/<Identity\b[^>]*>/g) ?? [];
  if (identities.length !== 1 || xmlAttribute(identities[0], "Id") !== "zemdomu" ||
      xmlAttribute(identities[0], "Publisher") !== "ZachariasErydBerlin" || xmlAttribute(identities[0], "Version") !== version) fail("VSIX Identity does not match the release.");
  const markers = (vsixManifest.match(/<Property\b[^>]*>/g) ?? []).filter(tag => /\bId=["']Microsoft\.VisualStudio\.Code\.PreRelease["']/.test(tag));
  if (markers.length > 1 || (markers.length === 1 && xmlAttribute(markers[0], "Value") !== "true") || (markers.length === 1) !== prerelease) fail("VSIX pre-release channel does not match the requested channel.");
}


export function inputsFromEnvironment(env) {
  if (!["true", "false"].includes(env.RELEASE_PRERELEASE)) fail("Expected a boolean channel input.");
  const input = { expectedCommit: env.EXPECTED_COMMIT, version: env.RELEASE_VERSION, prerelease: env.RELEASE_PRERELEASE === "true" };
  validateInputs(input);
  return input;
}

export function assertBuilderContext(input, env) {
  validateInputs(input);
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main` ||
      env.GITHUB_SHA !== input.expectedCommit || !shaPattern.test(env.GITHUB_SHA ?? "") ||
      !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") || !positiveId(Number(env.GITHUB_RUN_ID)) ||
      !/^[1-9]\d*$/.test(env.GITHUB_REPOSITORY_ID ?? "") || !positiveId(Number(env.GITHUB_REPOSITORY_ID))) {
    fail("Build requires the exact public manual main workflow and reviewed source identity.");
  }
  // Artifact API metadata identifies a run, but cannot prove which rerun attempt
  // uploaded a named artifact. Never attribute an earlier upload to a rerun.
  if (env.GITHUB_RUN_ATTEMPT !== "1") fail("Only original build attempt 1 is accepted.");
  return { workflowPath: WORKFLOW_PATH, runId: Number(env.GITHUB_RUN_ID), runAttempt: 1, repositoryId: Number(env.GITHUB_REPOSITORY_ID) };
}

function regularBytes(file, limit) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || fs.realpathSync(resolved) !== resolved || stat.size < 1 || stat.size > limit) fail("Expected a bounded regular file without symlinks.");
  const bytes = fs.readFileSync(resolved);
  if (bytes.length !== stat.size) fail("File changed while being read.");
  return bytes;
}

export function inspectSource({ rootDirectory, input, env = process.env, exec = execFileSync }) {
  const builder = assertBuilderContext(input, env);
  const root = fs.realpathSync(rootDirectory);
  const git = args => exec("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }).trim();
  if (git(["rev-parse", "HEAD"]) !== input.expectedCommit || git(["status", "--porcelain", "--untracked-files=normal"])) fail("Build checkout must be the exact clean reviewed source, including untracked files.");
  const sourceTree = git(["rev-parse", "HEAD^{tree}"]);
  if (!shaPattern.test(sourceTree)) fail("Invalid tracked source tree identity.");
  const pkg = JSON.parse(regularBytes(path.join(root, "package.json"), 1024 * 1024));
  const lock = JSON.parse(regularBytes(path.join(root, "package-lock.json"), 8 * 1024 * 1024));
  if (pkg.name !== "zemdomu" || pkg.publisher !== "ZachariasErydBerlin" || pkg.license !== "MIT" || pkg.version !== input.version || lock.name !== "zemdomu" || lock.version !== input.version || lock.packages?.[""]?.version !== input.version || lock.packages?.[""]?.name !== "zemdomu") fail("Source package/lock identity or version differs from the build inputs.");
  const changelog = regularBytes(path.join(root, "CHANGELOG.md"), 1024 * 1024).toString("utf8");
  if (parseChangelog(changelog).sections.get("Unreleased").bodyLines.length) fail("Promote Unreleased notes before preparing a release build.");
  return { root, sourceTree, notes: extractReleaseNotes(changelog, input.version), builder };
}

export function createGithubApi({ env = process.env, spawn = spawnSync } = {}) {
  return async endpoint => {
    if (!endpoint.startsWith(`${prefix}/`)) fail("Build evidence is restricted to the public product repository.");
    const childEnv = { ...env };
    delete childEnv.VSCE_PAT;
    delete childEnv.MIRROR_SYNC_PAT;
    delete childEnv.GH_READ_TOKEN;
    const result = spawn("gh", ["api", "--hostname", "github.com", "--method", "GET", endpoint], { env: childEnv, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) fail("Public build evidence request failed; subprocess output was not printed.");
    try { return JSON.parse(result.stdout); } catch { fail("Public evidence response is not valid JSON."); }
  };
}

export async function verifyReleaseGates({ input, rootDirectory, env = process.env, github = createGithubApi({ env }) }) {
  const source = inspectSource({ rootDirectory, input, env });
  const main = async () => {
    const branch = await github(`${prefix}/branches/main`);
    if (branch?.name !== "main" || branch.protected !== true || branch.commit?.sha !== input.expectedCommit) fail("Protected public main differs from the exact build source.");
  };
  await main();
  const evidence = {};
  for (const [name, spec] of Object.entries(WORKFLOWS)) {
    assertWorkflow(await github(`${prefix}/actions/workflows/${spec.id}`), spec);
    const first = await latestRun(github, spec, input.expectedCommit);
    const jobs = await verifyJobs(github, spec, first, input.expectedCommit);
    const current = await github(`${prefix}/actions/runs/${first.id}`);
    assertRun(current, spec, input.expectedCommit);
    sameAttempt(first, current);
    sameAttempt(current, await latestRun(github, spec, input.expectedCommit));
    assertWorkflow(await github(`${prefix}/actions/workflows/${spec.id}`), spec);
    evidence[name] = { runId: first.id, attempt: first.run_attempt, jobs };
  }
  await main();
  if (!isDeepStrictEqual(inspectSource({ rootDirectory, input, env }), source)) fail("Source identity changed during gate verification.");
  return evidence;
}

function inspectedVsix(file, input, exec = execFileSync) {
  const bytes = regularBytes(file, 2 * 1024 * 1024);
  const packed = JSON.parse(exec("unzip", ["-p", file, "extension/package.json"], { encoding: "utf8", maxBuffer: 1024 * 1024 }));
  const xml = exec("unzip", ["-p", file, "extension.vsixmanifest"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  verifyVsixMetadata({ packageJson: packed, vsixManifest: xml, ...input });
  return { bytes, size: bytes.length, digest: digest(bytes) };
}

export function artifactName(input, intermediate = false) {
  validateInputs(input);
  return `public-extension-build-${intermediate ? "input-" : ""}${input.version}-${input.expectedCommit}-${input.prerelease ? "prerelease" : "stable"}`;
}

function candidateFor(source, input, vsix) {
  return { format: 1, kind: "public-extension-build", repository: REPOSITORY, expectedCommit: input.expectedCommit, sourceTree: source.sourceTree, version: input.version, prerelease: input.prerelease, notes: source.notes, size: vsix.size, digest: vsix.digest, builder: source.builder };
}

function outputDirectory(directory, env) {
  const temp = fs.realpathSync(env.RUNNER_TEMP);
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== temp || path.basename(resolved) !== "public-extension-build") fail("Build artifacts must be directly under RUNNER_TEMP/public-extension-build.");
  if (fs.existsSync(resolved) && fs.realpathSync(resolved) !== resolved) fail("Build output cannot be a symlink.");
  return resolved;
}

function members(directory, expected) {
  const names = fs.readdirSync(directory).sort();
  if (!isDeepStrictEqual(names, [...expected].sort())) fail("Build artifact has missing, extra or unexpected members.");
  for (const name of names) regularBytes(path.join(directory, name), 2 * 1024 * 1024);
}

export function prepareCandidate({ input, rootDirectory, directory, env = process.env }) {
  const source = inspectSource({ rootDirectory, input, env });
  const vsix = inspectedVsix(path.join(source.root, "dist", FILES.vsix), input);
  const output = outputDirectory(directory, env);
  if (fs.existsSync(output)) fail("Build output already exists; never overwrite candidate bytes.");
  fs.mkdirSync(output);
  const candidate = candidateFor(source, input, vsix);
  fs.writeFileSync(path.join(output, FILES.vsix), vsix.bytes, { flag: "wx" });
  fs.writeFileSync(path.join(output, FILES.candidate), `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx" });
  verifyCandidate({ input, rootDirectory, directory: output, env });
  return { candidate, artifactName: artifactName(input), intermediateArtifactName: artifactName(input, true), candidateDigest: digest(regularBytes(path.join(output, FILES.candidate), 64 * 1024)) };
}

export function verifyCandidate({ input, rootDirectory, directory, env = process.env, expectedVsixDigest, expectedCandidateDigest, complete = false }) {
  const source = inspectSource({ rootDirectory, input, env });
  const output = outputDirectory(directory, env);
  members(output, complete ? Object.values(FILES) : [FILES.vsix, FILES.candidate]);
  const recordBytes = regularBytes(path.join(output, FILES.candidate), 64 * 1024);
  const candidate = JSON.parse(recordBytes);
  const vsix = inspectedVsix(path.join(output, FILES.vsix), input);
  if (!isDeepStrictEqual(candidate, candidateFor(source, input, vsix))) fail("Candidate source, run, metadata or exact VSIX bytes differ from the inspected build.");
  if (expectedVsixDigest !== undefined && (!digestPattern.test(expectedVsixDigest) || candidate.digest !== expectedVsixDigest)) fail("Downloaded VSIX differs from the build job's bound digest.");
  if (expectedCandidateDigest !== undefined && (!digestPattern.test(expectedCandidateDigest) || digest(recordBytes) !== expectedCandidateDigest)) fail("Downloaded candidate differs from the build job's bound digest.");
  return candidate;
}

export async function verifyIntermediateArtifact({ input, env = process.env, github = createGithubApi({ env }) }) {
  const context = assertBuilderContext(input, env);
  if (!/^[1-9]\d*$/.test(env.BUILD_ARTIFACT_ID ?? "") || !positiveId(Number(env.BUILD_ARTIFACT_ID)) || !digestPattern.test(env.BUILD_ARTIFACT_DIGEST ?? "")) fail("Missing immutable intermediate artifact ID/digest.");
  const artifact = await github(`${prefix}/actions/artifacts/${env.BUILD_ARTIFACT_ID}`);
  const owner = artifact?.workflow_run;
  if (artifact?.id !== Number(env.BUILD_ARTIFACT_ID) || artifact.name !== artifactName(input, true) || artifact.digest !== env.BUILD_ARTIFACT_DIGEST || artifact.expired !== false || !positiveId(artifact.size_in_bytes) || artifact.size_in_bytes > 8 * 1024 * 1024 || !Number.isFinite(Date.parse(artifact.expires_at)) || Date.parse(artifact.expires_at) <= Date.now() || owner?.id !== context.runId || owner.head_sha !== input.expectedCommit || owner.head_branch !== "main" || owner.repository_id !== context.repositoryId || owner.head_repository_id !== context.repositoryId) fail("Intermediate artifact does not match the original public source/run/digest.");
  return artifact;
}

export function inspectProvenance(bundleBytes, candidate) {
  if (!Buffer.isBuffer(bundleBytes) || !bundleBytes.length || bundleBytes.length > 2 * 1024 * 1024) fail("Invalid bounded provenance bundle.");
  const bundle = JSON.parse(bundleBytes.toString("utf8"));
  const envelope = bundle?.dsseEnvelope;
  if (envelope?.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string" || !envelope.payload || Buffer.from(envelope.payload, "base64").toString("base64") !== envelope.payload || !Array.isArray(envelope.signatures) || envelope.signatures.length !== 1 || !bundle.verificationMaterial || !/^application\/vnd\.dev\.sigstore\.bundle\.v0\.[23]\+json$/.test(bundle.mediaType ?? "") || envelope.signatures.some(s => typeof s.sig !== "string" || !s.sig)) fail("Invalid original DSSE envelope.");
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  const definition = statement?.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const expectedUri = `git+https://github.com/${REPOSITORY}@refs/heads/main`;
  if (statement?._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== "https://slsa.dev/provenance/v1" || !isDeepStrictEqual(statement.subject, [{ name: FILES.vsix, digest: { sha256: candidate.digest.slice(7) } }]) || definition?.buildType !== "https://actions.github.io/buildtypes/workflow/v1" || !isDeepStrictEqual(workflow, { repository: `https://github.com/${REPOSITORY}`, path: WORKFLOW_PATH, ref: "refs/heads/main" }) || !isDeepStrictEqual(definition.resolvedDependencies, [{ uri: expectedUri, digest: { gitCommit: candidate.expectedCommit } }]) || definition.internalParameters?.github?.repository_id !== String(candidate.builder.repositoryId) || definition.internalParameters?.github?.event_name !== "workflow_dispatch" || definition.internalParameters?.github?.runner_environment !== "github-hosted" || statement.predicate?.runDetails?.builder?.id !== `https://github.com/${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main` || statement.predicate?.runDetails?.metadata?.invocationId !== `https://github.com/${REPOSITORY}/actions/runs/${candidate.builder.runId}/attempts/1`) fail("Original provenance does not bind the exact VSIX, public source, workflow and original invocation.");
  return envelope;
}

export function verifyAttestation(file, candidate, { env = process.env, bundlePath, spawn = spawnSync } = {}) {
  if (typeof bundlePath !== "string" || !bundlePath) fail("Original attestation bundle path is required.");
  const args = ["attestation", "verify", file, "--bundle", bundlePath, "--repo", REPOSITORY, "--signer-workflow", `${REPOSITORY}/${WORKFLOW_PATH}`, "--signer-digest", candidate.expectedCommit, "--source-digest", candidate.expectedCommit, "--source-ref", "refs/heads/main", "--deny-self-hosted-runners", "--predicate-type", "https://slsa.dev/provenance/v1", "--format", "json"];
  const childEnv = { ...env };
  delete childEnv.VSCE_PAT;
  delete childEnv.MIRROR_SYNC_PAT;
  const result = spawn("gh", args, { env: childEnv, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail("Cryptographic public build-attestation verification failed; subprocess output was not printed.");
  let verified;
  try { verified = JSON.parse(result.stdout); } catch { fail("Attestation verifier returned malformed JSON."); }
  if (!Array.isArray(verified) || verified.length < 1) fail("Attestation verifier returned no verified statements.");
}

export function preserveProvenance({ input, rootDirectory, directory, bundlePath, env = process.env, verify = verifyAttestation }) {
  if (!digestPattern.test(env.BUILD_VSIX_DIGEST ?? "") || !digestPattern.test(env.BUILD_CANDIDATE_DIGEST ?? "")) fail("Attestation job requires the original build-job digests.");
  const candidate = verifyCandidate({ input, rootDirectory, directory, env, expectedVsixDigest: env.BUILD_VSIX_DIGEST, expectedCandidateDigest: env.BUILD_CANDIDATE_DIGEST });
  const bundleBytes = regularBytes(bundlePath, 2 * 1024 * 1024);
  const envelope = inspectProvenance(bundleBytes, candidate);
  verify(path.join(directory, FILES.vsix), candidate, { env, bundlePath });
  // Preserve the action's complete bundle bytes and original signed envelope.
  // Do not reconstruct or re-encode its base64 payload, signatures or predicate.
  fs.writeFileSync(path.join(directory, FILES.bundle), bundleBytes, { flag: "wx" });
  fs.writeFileSync(path.join(directory, FILES.dsse), `${JSON.stringify(envelope)}\n`, { flag: "wx" });
  verifyCandidate({ input, rootDirectory, directory, env, complete: true, expectedVsixDigest: env.BUILD_VSIX_DIGEST, expectedCandidateDigest: env.BUILD_CANDIDATE_DIGEST });
  return candidate;
}

async function cli() {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length || !["gate", "prepare", "verify", "provenance"].includes(command)) fail("Expected gate, prepare, verify or provenance without positional inputs.");
  const env = process.env;
  const input = inputsFromEnvironment(env);
  const rootDirectory = process.cwd();
  const directory = env.BUILD_OUTPUT;
  if (command === "gate") {
    await verifyReleaseGates({ input, rootDirectory, env });
    console.log("Exact protected public source and every latest release gate verified.");
  } else if (command === "prepare") {
    const result = prepareCandidate({ input, rootDirectory, directory, env });
    fs.appendFileSync(env.GITHUB_OUTPUT, `artifact_name=${result.artifactName}\ninput_artifact_name=${result.intermediateArtifactName}\nvsix_digest=${result.candidate.digest}\ncandidate_digest=${result.candidateDigest}\n`);
    console.log(`Bound inspected VSIX: ${result.candidate.digest}`);
  } else if (command === "verify") {
    if (!digestPattern.test(env.BUILD_VSIX_DIGEST ?? "") || !digestPattern.test(env.BUILD_CANDIDATE_DIGEST ?? "")) fail("Missing original build-job digests.");
    await verifyIntermediateArtifact({ input, env });
    verifyCandidate({ input, rootDirectory, directory, env, expectedVsixDigest: env.BUILD_VSIX_DIGEST, expectedCandidateDigest: env.BUILD_CANDIDATE_DIGEST });
    await verifyReleaseGates({ input, rootDirectory, env });
    console.log("Immutable inspected build and every latest release gate verified before attestation.");
  } else {
    preserveProvenance({ input, rootDirectory, directory, bundlePath: env.ATTESTATION_BUNDLE_PATH, env });
    console.log("Original SLSA bundle and unchanged DSSE envelope retained.");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) cli().catch(error => { console.error(`Public VSIX build: ${error.message}`); process.exitCode = 1; });
