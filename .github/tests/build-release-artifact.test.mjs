import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { REPOSITORY, WORKFLOW_PATH, WORKFLOWS, FILES, digest, inputsFromEnvironment, assertBuilderContext, inspectSource, verifyReleaseGates, artifactName, prepareCandidate, verifyCandidate, verifyIntermediateArtifact, inspectProvenance, verifyAttestation, preserveProvenance, createGithubApi, extractReleaseNotes } from "../scripts/build-release-artifact.mjs";

function fixture(t, prerelease = false) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zd-public-build-")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "source"); fs.mkdirSync(root);
  const pkg = { name: "zemdomu", publisher: "ZachariasErydBerlin", license: "MIT", version: "0.1.3" };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "zemdomu", version: "0.1.3", packages: { "": { name: "zemdomu", version: "0.1.3" } } }));
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), "## Unreleased\n\n## 0.1.3\n\n### Security\n\n- Security: verify inspected downloads.\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n");
  execFileSync("git", ["init", "-q", root]); execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Offline fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const expectedCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const input = { expectedCommit, version: "0.1.3", prerelease };
  const env = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_WORKFLOW_REF: `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`, GITHUB_SHA: expectedCommit, GITHUB_RUN_ID: "8001", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY_ID: "6001", EXPECTED_COMMIT: expectedCommit, RELEASE_VERSION: "0.1.3", RELEASE_PRERELEASE: String(prerelease), RUNNER_TEMP: temp };
  const directory = path.join(temp, "public-extension-build");
  const archive = path.join(temp, "archive"); fs.mkdirSync(path.join(archive, "extension"), { recursive: true });
  fs.writeFileSync(path.join(archive, "extension/package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(archive, "extension.vsixmanifest"), `<PackageManifest><Identity Id="zemdomu" Publisher="ZachariasErydBerlin" Version="0.1.3"/>${prerelease ? '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true"/>' : ""}</PackageManifest>`);
  fs.mkdirSync(path.join(root, "dist"));
  execFileSync("zip", ["-q", path.join(root, "dist", FILES.vsix), "extension/package.json", "extension.vsixmanifest"], { cwd: archive });
  return { temp, root, input, env, directory, options: { input, rootDirectory: root, directory, env } };
}
function fakeGithub(f) {
  const state = { branch: { name: "main", protected: true, commit: { sha: f.input.expectedCommit } }, workflows: {}, histories: {}, runs: {}, jobs: {}, calls: [], afterRead: () => {} };
  let id = 100;
  for (const [name, spec] of Object.entries(WORKFLOWS)) {
    const run = { id: id++, run_number: 1, run_attempt: 1, workflow_id: spec.id, path: spec.path, event: spec.event, head_branch: "main", head_sha: f.input.expectedCommit, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, status: "completed", conclusion: "success" }; run.html_url = `https://github.com/${REPOSITORY}/actions/runs/${run.id}`;
    state.workflows[spec.id] = { id: spec.id, path: spec.path, state: "active" };state.histories[spec.id] = { total_count: 1, workflow_runs: [run] }; state.runs[run.id] = run;
    const makeJob = (jobName, steps, label) => ({ id: id++, name: jobName, run_id: run.id, run_attempt: 1, head_sha: f.input.expectedCommit, status: "completed", conclusion: "success", labels: label ? [label] : [], steps: steps.map((name, index) => ({ name, number: index + 1, status: "completed", conclusion: "success" })) });
    let jobs;
    if (name === "ci") jobs = [makeJob("test", ["Install locked dependencies", "Validate source-mapped TypeScript coverage", "Test, package, and inspect VSIX", "Install packaged extension in a clean VS Code profile"])];
    else if (name === "codeql") jobs = [makeJob("Analyze (actions)", ["Analyze source"]), makeJob("Analyze (javascript-typescript)", ["Analyze source"])];
    else jobs = ["ubuntu-latest", "windows-latest"].flatMap(os => ["1.105.0", "stable"].map(version => makeJob(`Extension Host (${os}, VS Code ${version})`, ["Install locked dependencies", "Test, package, and inspect VSIX", `Measure real VS Code Extension Host performance on ${os.startsWith("ubuntu") ? "Linux" : "Windows"}`], os)));
    state.jobs[run.id] = { total_count: jobs.length, jobs };
  }
  const github = async endpoint => {
    state.calls.push(endpoint);let value;
    if (endpoint.endsWith("/branches/main")) value = state.branch;
    else if (/\/actions\/workflows\/\d+$/.test(endpoint)) value = state.workflows[endpoint.split("/").at(-1)];
    else if (/\/actions\/workflows\/\d+\/runs\?/.test(endpoint)) value = state.histories[endpoint.match(/workflows\/(\d+)/)[1]];
    else if (/\/attempts\/\d+\/jobs\?/.test(endpoint)) value = state.jobs[endpoint.match(/runs\/(\d+)/)[1]];
    else if (/\/actions\/runs\/\d+$/.test(endpoint)) value = state.runs[endpoint.split("/").at(-1)];
    else throw new Error(`Unexpected fixture endpoint ${endpoint}`);
    const result = structuredClone(value); state.afterRead(endpoint, state); return result;
  };
  return { state, github, gates: () => verifyReleaseGates({ input: f.input, rootDirectory: f.root, env: f.env, github }) };
}
function prepared(f) {
  const p = prepareCandidate(f.options);
  f.env.BUILD_VSIX_DIGEST = p.candidate.digest; f.env.BUILD_CANDIDATE_DIGEST = p.candidateDigest;
  return p;
}
function provenance(candidate) {
  const statement = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: FILES.vsix, digest: { sha256: candidate.digest.slice(7) } }], predicateType: "https://slsa.dev/provenance/v1", predicate: { buildDefinition: { buildType: "https://actions.github.io/buildtypes/workflow/v1", externalParameters: { workflow: { repository: `https://github.com/${REPOSITORY}`, path: WORKFLOW_PATH, ref: "refs/heads/main" } }, internalParameters: { github: { repository_id: String(candidate.builder.repositoryId), event_name: "workflow_dispatch", runner_environment: "github-hosted" } }, resolvedDependencies: [{ uri: `git+https://github.com/${REPOSITORY}@refs/heads/main`, digest: { gitCommit: candidate.expectedCommit } }] }, runDetails: { builder: { id: `https://github.com/${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main` }, metadata: { invocationId: `https://github.com/${REPOSITORY}/actions/runs/${candidate.builder.runId}/attempts/1` } } } };
  // This is a structural unit fixture, never represented as a valid signature.
  return { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", verificationMaterial: { certificate: { rawBytes: "unit-fixture-not-a-certificate" } }, dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64"), signatures: [{ sig: "unit-fixture-not-a-signature" }] } };
}

test("binds a real ZIP and clean git source to exact source/version/channel/original run without archived paths", t => {
  for (const channel of [false, true]) {
    const f = fixture(t, channel); const p = prepared(f);
    assert.deepEqual(inputsFromEnvironment(f.env), f.input);
    assert.equal(verifyCandidate({ ...f.options, expectedVsixDigest: p.candidate.digest, expectedCandidateDigest: p.candidateDigest }).kind, "public-extension-build");
    assert.deepEqual(Object.keys(p.candidate), ["format", "kind", "repository", "expectedCommit", "sourceTree", "version", "prerelease", "notes", "size", "digest", "builder"]);
    assert.equal(p.candidate.builder.runAttempt, 1); assert.equal(p.candidate.builder.repositoryId, 6001);
    assert.equal(p.candidate.notes, "## 0.1.3\n\n### Security\n\n- Security: verify inspected downloads.\n");
    assert.equal(p.artifactName, `public-extension-build-0.1.3-${f.input.expectedCommit}-${channel ? "prerelease" : "stable"}`);
    assert.equal(p.intermediateArtifactName, artifactName(f.input, true));
    assert.equal(fs.readFileSync(path.join(f.directory, FILES.vsix)).equals(fs.readFileSync(path.join(f.root, "dist", FILES.vsix))), true);
    assert.throws(() => prepareCandidate(f.options), /already exists/);
  }
});

test("checks every latest CI/CodeQL/four-host job and rechecks protected source and attempts", async t => {
  const f = fixture(t); const api = fakeGithub(f); const evidence = await api.gates();
  assert.deepEqual(Object.keys(evidence), ["ci", "codeql", "host"]); assert.equal(evidence.host.jobs.length, 4);
  assert.equal(api.state.calls.filter(e => e.endsWith("/branches/main")).length, 2);
});

for (const [name, change] of [
  ["foreign repository", f => { f.env.GITHUB_REPOSITORY = "other/project"; }],
  ["non-main ref", f => { f.env.GITHUB_REF = "refs/heads/topic"; }],
  ["pull request", f => { f.env.GITHUB_EVENT_NAME = "pull_request"; }],
  ["foreign workflow", f => { f.env.GITHUB_WORKFLOW_REF = `${REPOSITORY}/.github/workflows/other.yml@refs/heads/main`; }],
  ["another source SHA", f => { f.env.GITHUB_SHA = "b".repeat(40); }],
  ["rerun attempt", f => { f.env.GITHUB_RUN_ATTEMPT = "2"; }],
  ["missing repository ID", f => { delete f.env.GITHUB_REPOSITORY_ID; }],
  ["unsafe run ID", f => { f.env.GITHUB_RUN_ID = "9007199254740992"; }],
]) test(`rejects ${name} before a gate API read`, async t => { const f = fixture(t);change(f);const api = fakeGithub(f);await assert.rejects(api.gates());assert.deepEqual(api.state.calls, []); });

for (const [name, mutate] of [
  ["unprotected main", a => { a.state.branch.protected = false; }],
  ["moved main", a => { a.state.branch.commit.sha = "c".repeat(40); }],
  ["workflow path drift", a => { a.state.workflows[WORKFLOWS.ci.id].path = ".github/workflows/other.yml"; }],
  ["missing workflow history", a => { a.state.histories[WORKFLOWS.ci.id].total_count = 0; }],
  ["incomplete workflow history", a => { a.state.histories[WORKFLOWS.ci.id].total_count = 2; }],
  ["wrong source gate", a => { a.state.runs[100].head_sha = "d".repeat(40); }],
  ["foreign gate origin", a => { a.state.runs[100].head_repository.full_name = "other/fork"; }],
  ["PR gate", a => { a.state.runs[100].event = "pull_request"; }],
  ["failed CI", a => { a.state.runs[100].conclusion = "failure"; }],
  ["missing coverage step", a => { a.state.jobs[100].jobs[0].steps.splice(1, 1); }],
  ["incomplete CodeQL", a => { const run = a.state.histories[WORKFLOWS.codeql.id].workflow_runs[0];a.state.jobs[run.id].jobs.pop();a.state.jobs[run.id].total_count -= 1; }],
  ["missing host cell", a => { const run = a.state.histories[WORKFLOWS.host.id].workflow_runs[0];a.state.jobs[run.id].jobs.pop();a.state.jobs[run.id].total_count -= 1; }],
  ["skipped applicable host step", a => { const run = a.state.histories[WORKFLOWS.host.id].workflow_runs[0];a.state.jobs[run.id].jobs[0].steps.at(-1).conclusion = "skipped"; }],
  ["wrong host runner", a => { const run = a.state.histories[WORKFLOWS.host.id].workflow_runs[0];a.state.jobs[run.id].jobs[0].labels = ["windows-latest"]; }],
  ["duplicate host job", a => { const run = a.state.histories[WORKFLOWS.host.id].workflow_runs[0];a.state.jobs[run.id].jobs[1].name = a.state.jobs[run.id].jobs[0].name; }],
]) test(`release gate rejects ${name}`, async t => { const f = fixture(t); const a = fakeGithub(f);mutate(a);await assert.rejects(a.gates()); });

for (const conclusion of ["failure", "cancelled", "", "timed_out"]) test(`latest exact-source ${conclusion || "pending"} blocks an older pass`, async t => {
  const f = fixture(t);const a = fakeGithub(f);const newer = structuredClone(a.state.runs[100]);newer.id = 900;newer.run_number = 2;newer.html_url = `https://github.com/${REPOSITORY}/actions/runs/900`;newer.conclusion = conclusion;newer.status = conclusion ? "completed" : "queued";a.state.histories[WORKFLOWS.ci.id].workflow_runs.push(newer);a.state.histories[WORKFLOWS.ci.id].total_count = 2;await assert.rejects(a.gates(), /not successful/);
});

test("a changed gate attempt or source during verification blocks attestation", async t => {
  const f = fixture(t);const a = fakeGithub(f);a.state.afterRead = endpoint => { if (endpoint.includes("/attempts/1/jobs")) a.state.runs[100].run_attempt = 2; };await assert.rejects(a.gates());
  const b = fakeGithub(f);let mainReads = 0;b.state.afterRead = endpoint => { if (endpoint.endsWith("/branches/main") && ++mainReads === 1) b.state.branch.commit.sha = "e".repeat(40); };await assert.rejects(b.gates(), /Protected public main/);
});

for (const [name, mutate] of [
  ["package version", f => { const p = path.join(f.root, "package.json");const j = JSON.parse(fs.readFileSync(p));j.version = "0.1.4";fs.writeFileSync(p, JSON.stringify(j)); }],
  ["lock version", f => { const p = path.join(f.root, "package-lock.json");const j = JSON.parse(fs.readFileSync(p));j.packages[""].version = "0.1.4";fs.writeFileSync(p, JSON.stringify(j)); }],
  ["unpromoted changelog", f => { const p = path.join(f.root, "CHANGELOG.md");fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("## Unreleased\n\n", "## Unreleased\n\n### Security\n\n- Security: pending.\n\n")); }],
  ["untracked source", f => fs.writeFileSync(path.join(f.root, "extra.js"), "unexpected")],
]) test(`source inspection rejects ${name}`, t => { const f = fixture(t);mutate(f);assert.throws(() => inspectSource({ rootDirectory: f.root, input: f.input, env: f.env })); });

for (const [name, filename, change] of [
  ["package identity", "package.json", j => { j.publisher = "otherPublisher"; }],
  ["package version", "package.json", j => { j.version = "0.1.4"; }],
  ["lock identity", "package-lock.json", j => { j.name = "other-package"; }],
  ["lock version", "package-lock.json", j => { j.version = "0.1.4"; }],
  ["root lock version", "package-lock.json", j => { j.packages[""].version = "0.1.4"; }],
  ["unpromoted notes", "CHANGELOG.md", text => text.replace("## Unreleased\n\n", "## Unreleased\n\n### Security\n\n- Security: still pending.\n\n")],
]) test(`clean committed source rejects ${name}`, t => {
  const f = fixture(t);const file = path.join(f.root, filename);const text = fs.readFileSync(file, "utf8");
  if (filename.endsWith(".json")) { const j = JSON.parse(text);change(j);fs.writeFileSync(file, JSON.stringify(j)); }
  else fs.writeFileSync(file, change(text));
  execFileSync("git", ["-C", f.root, "add", "."]);
  execFileSync("git", ["-C", f.root, "-c", "user.name=Offline fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "mismatch"]);
  f.input.expectedCommit = execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();f.env.GITHUB_SHA = f.input.expectedCommit;
  assert.throws(() => inspectSource({ rootDirectory: f.root, input: f.input, env: f.env }), /package\/lock|Promote Unreleased/);
});

test("pre-release input must match actual packed metadata", t => {
  const f = fixture(t);f.input.prerelease = true;f.env.RELEASE_PRERELEASE = "true";assert.throws(() => prepareCandidate(f.options), /channel/);
});

for (const key of ["repository", "expectedCommit", "sourceTree", "version", "prerelease", "notes", "size", "digest", "builder"]) test(`rejects forged candidate ${key}`, t => {
  const f = fixture(t);prepared(f);const p = path.join(f.directory, FILES.candidate);const j = JSON.parse(fs.readFileSync(p));j[key] = key === "size" ? 1 : key === "prerelease" ? true : "forged";fs.writeFileSync(p, JSON.stringify(j));assert.throws(() => verifyCandidate(f.options), /differ/);
});

test("rejects extra members, symlink VSIX and replacement of both candidate and artifact", t => {
  const f = fixture(t);const p = prepared(f);fs.writeFileSync(path.join(f.directory, "extra.json"), "{}");assert.throws(() => verifyCandidate(f.options), /members/);fs.unlinkSync(path.join(f.directory, "extra.json"));const archive = path.join(f.directory, FILES.vsix);fs.unlinkSync(archive);fs.symlinkSync(path.join(f.root, "dist", FILES.vsix), archive);assert.throws(() => verifyCandidate(f.options), /regular file/);fs.unlinkSync(archive);fs.copyFileSync(path.join(f.root, "dist", FILES.vsix), archive);
  const changed = Buffer.concat([fs.readFileSync(archive), Buffer.from("changed archive metadata")]);fs.writeFileSync(archive, changed);const cp = path.join(f.directory, FILES.candidate);const j = JSON.parse(fs.readFileSync(cp));j.size = changed.length;j.digest = digest(changed);fs.writeFileSync(cp, JSON.stringify(j));assert.throws(() => verifyCandidate({ ...f.options, expectedVsixDigest: p.candidate.digest }), /build job/);
});

test("intermediate artifact metadata must bind original producing run/source/repository/ID/digest", async t => {
  const f = fixture(t);f.env.BUILD_ARTIFACT_ID = "55";f.env.BUILD_ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}`;const data = { id: 55, name: artifactName(f.input, true), digest: f.env.BUILD_ARTIFACT_DIGEST, expired: false, size_in_bytes: 1234, expires_at: "2099-01-01T00:00:00Z", workflow_run: { id: 8001, head_sha: f.input.expectedCommit, head_branch: "main", repository_id: 6001, head_repository_id: 6001 } };let calls = 0;const github = async () => { calls++;return structuredClone(data); };await verifyIntermediateArtifact({ input: f.input, env: f.env, github });assert.equal(calls, 1);
  for (const change of [j => { j.id = 56; }, j => { j.digest = `sha256:${"b".repeat(64)}`; }, j => { j.expired = true; }, j => { j.workflow_run.id = 9000; }, j => { j.workflow_run.head_repository_id = 9000; }, j => { j.workflow_run.head_sha = "f".repeat(40); }]) { const altered = structuredClone(data);change(altered);await assert.rejects(verifyIntermediateArtifact({ input: f.input, env: f.env, github: async () => altered })); }
});

test("preserves original bundle bytes and identical DSSE payload/signatures without reconstruction", t => {
  const f = fixture(t);const p = prepared(f);const original = provenance(p.candidate);const bytes = Buffer.from(JSON.stringify(original, null, 2) + "\n");const bundlePath = path.join(f.temp, "action-original.json");fs.writeFileSync(bundlePath, bytes);let calls = 0;
  preserveProvenance({ ...f.options, bundlePath, verify: (file, candidate, options) => { calls++;assert.equal(file, path.join(f.directory, FILES.vsix));assert.deepEqual(candidate, p.candidate);assert.equal(options.bundlePath, bundlePath); } });
  assert.equal(calls, 1);assert.equal(fs.readFileSync(path.join(f.directory, FILES.bundle)).equals(bytes), true);const text = fs.readFileSync(path.join(f.directory, FILES.dsse), "utf8");assert.equal(text.trim().split("\n").length, 1);assert.deepEqual(JSON.parse(text), original.dsseEnvelope);assert.equal(JSON.parse(text).payload, original.dsseEnvelope.payload);assert.deepEqual(JSON.parse(text).signatures, original.dsseEnvelope.signatures);assert.deepEqual(fs.readdirSync(f.directory).sort(), Object.values(FILES).sort());
});

for (const [name, mutate] of [
  ["subject digest", s => { s.subject[0].digest.sha256 = "a".repeat(64); }],
  ["predicate type", s => { s.predicateType = "custom"; }],
  ["build type", s => { s.predicate.buildDefinition.buildType = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1"; }],
  ["trigger event", s => { s.predicate.buildDefinition.internalParameters.github.event_name = "pull_request"; }],
  ["runner environment", s => { s.predicate.buildDefinition.internalParameters.github.runner_environment = "self-hosted"; }],
  ["additional resolved source", s => { s.predicate.buildDefinition.resolvedDependencies.push(structuredClone(s.predicate.buildDefinition.resolvedDependencies[0])); }],
  ["source commit", s => { s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40); }],
  ["source repository", s => { s.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/other/fork"; }],
  ["signer workflow", s => { s.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml"; }],
  ["branch", s => { s.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/topic"; }],
  ["run invocation", s => { s.predicate.runDetails.metadata.invocationId = `https://github.com/${REPOSITORY}/actions/runs/8002/attempts/1`; }],
  ["rerun invocation", s => { s.predicate.runDetails.metadata.invocationId = `https://github.com/${REPOSITORY}/actions/runs/8001/attempts/2`; }],
  ["self-hosted builder", s => { s.predicate.runDetails.builder.id = "self-hosted"; }],
  ["repository ID", s => { s.predicate.buildDefinition.internalParameters.github.repository_id = "9999"; }],
]) test(`rejects original SLSA ${name} mismatch`, t => { const f = fixture(t);const p = prepared(f);const b = provenance(p.candidate);const s = JSON.parse(Buffer.from(b.dsseEnvelope.payload, "base64"));mutate(s);b.dsseEnvelope.payload = Buffer.from(JSON.stringify(s)).toString("base64");assert.throws(() => inspectProvenance(Buffer.from(JSON.stringify(b)), p.candidate), /provenance/); });

test("cryptographic verifier is restricted to the original bundle and exact public source/signer", t => {
  const f = fixture(t);const p = prepared(f);let captured;
  verifyAttestation("/tmp/zemdomu.vsix", p.candidate, { bundlePath: "/tmp/original.bundle", env: { GH_TOKEN: "read-token", VSCE_PAT: "private-value", MIRROR_SYNC_PAT: "write-value" }, spawn: (cmd, args, options) => { captured = { cmd, args, options };return { status: 0, stdout: "[{}]" }; } });
  assert.equal(captured.cmd, "gh");assert.deepEqual(captured.args.slice(0, 5), ["attestation", "verify", "/tmp/zemdomu.vsix", "--bundle", "/tmp/original.bundle"]);for (const flag of ["--repo", "--signer-workflow", "--signer-digest", "--source-digest", "--source-ref", "--deny-self-hosted-runners"]) assert.ok(captured.args.includes(flag));assert.equal(captured.options.env.VSCE_PAT, undefined);assert.equal(captured.options.env.MIRROR_SYNC_PAT, undefined);
  assert.throws(() => verifyAttestation("/tmp/zemdomu.vsix", p.candidate, { bundlePath: "/tmp/original.bundle", spawn: () => ({ status: 1, stderr: "secret should never print" }) }), /Cryptographic/);
});

test("failed original-bundle cryptographic verification retains no publishable attestation files", t => {
  const f = fixture(t);const p = prepared(f);const b = path.join(f.temp, "original.json");fs.writeFileSync(b, JSON.stringify(provenance(p.candidate)));assert.throws(() => preserveProvenance({ ...f.options, bundlePath: b, verify: () => { throw new Error("cryptographic rejection"); } }), /cryptographic/);assert.deepEqual(fs.readdirSync(f.directory).sort(), [FILES.vsix, FILES.candidate].sort());
});

test("evidence API is GET-only, repository-bound and redacts failed subprocess output", async () => {
  let captured;const api = createGithubApi({ env: { GH_TOKEN: "read-token", VSCE_PAT: "private-value" }, spawn: (cmd, args, opts) => { captured = { cmd, args, opts };return { status: 0, stdout: "{}" }; } });await api(`repos/${REPOSITORY}/branches/main`);assert.deepEqual(captured.args.slice(0, 5), ["api", "--hostname", "github.com", "--method", "GET"]);assert.equal(captured.opts.env.VSCE_PAT, undefined);await assert.rejects(api("repos/other/project/branches/main"));const failed = createGithubApi({ spawn: () => ({ status: 1, stderr: "credential-bearing-output" }) });await assert.rejects(failed(`repos/${REPOSITORY}/branches/main`), error => !error.message.includes("credential-bearing-output"));
});

test("release notes reject duplicate/malformed sections and preserve real line breaks", () => {
  assert.throws(() => extractReleaseNotes("## Unreleased\n\n## 0.1.3\n\n## 0.1.3\n", "0.1.3"), /Duplicate/);assert.throws(() => extractReleaseNotes("## Unreleased\\n", "0.1.3"), /literal/);
});
