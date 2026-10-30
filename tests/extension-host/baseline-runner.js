const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { finished } = require('stream/promises');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');
const { exitAfterOutput } = require('./exit-after-output');
const { SCHEMA_VERSION, PROTOCOL, sha256, createOriginalWorkspace, fixtureIdentity, samplePlan, controlManifest, aggregateSamples } = require('./baseline-shared');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sourceIdentity(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const files = [
    'package.json', 'package-lock.json', 'tests/extension-host/run.js',
    'tests/extension-host/suite/index.js', 'tests/extension-host/baseline-runner.js',
    'tests/extension-host/baseline-suite.js', 'tests/extension-host/baseline-shared.js',
  ].map(name => ({ name, sha256: sha256(fs.readFileSync(path.join(root, name))) }));
  return {
    gitHead: git('rev-parse', 'HEAD'),
    gitTree: git('rev-parse', 'HEAD^{tree}'),
    gitStatus: git('status', '--porcelain', '--untracked-files=normal'),
    files,
    sha256: sha256(JSON.stringify(files)),
    bundleSha256: sha256(fs.readFileSync(path.join(root, 'dist', 'extension.js'))),
  };
}

// Kept separate so contract tests can prove every scheduled failure is retained
// without launching real hosts, skipping pairs, or changing the real CLI plan.
async function executePlan(manifest, launch, persist) {
  for (const sample of manifest.samples) {
    sample.status = 'running';
    sample.startedAt = new Date().toISOString();
    persist();
    try {
      sample.report = await launch(sample);
      assert.strictEqual(sample.report.status, 'passed', `Host reported failure: ${sample.sampleId}`);
      sample.status = 'passed';
    } catch (error) {
      sample.status = 'failed';
      sample.error = { name: error.name, message: error.message, stack: error.stack };
    } finally {
      sample.finishedAt = new Date().toISOString();
      persist();
    }
  }
  manifest.summary = aggregateSamples(manifest);
  return manifest;
}

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const version = process.env.VSCODE_TEST_VERSION;
  assert.ok(PROTOCOL.versions.includes(version), 'Set exact VSCODE_TEST_VERSION=1.105.0 or 1.144.0; moving stable is not a baseline');
  const source = sourceIdentity(root);
  const output = path.resolve(process.env.ZEMDOMU_BASELINE_RESULTS_DIR || path.join(root, '.agent', 'extension-host-baseline'));
  assert.ok(!fs.existsSync(output) || fs.readdirSync(output).length === 0, 'Result directory must be empty; never overwrite or select previous samples');
  fs.mkdirSync(output, { recursive: true });
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'paired-extension-host-baseline',
    status: 'running',
    startedAt: new Date().toISOString(),
    cell: `${process.platform}-${process.arch}-vscode-${version}`,
    vscodeVersion: version,
    runner: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version },
    source: { ...source, treeClean: source.gitStatus === '' },
    protocol: PROTOCOL,
    samples: samplePlan().map(sample => ({ ...sample, status: 'pending' })),
    limitations: [
      'Control replaces the product development extension with an inert manifest; shared suite and product manifest imports are identical.',
      'Product activation, workspace scans and diagnostic checks occur only in treatment; controls omit these operations.',
      'Fixed common editor cadence and quiet settling do not make product-specific work have equal duration; phase timings and cadence overruns are reported.',
      'Process differences include runtime, built-ins, allocation/GC timing and product workload; subtraction is not precise extension memory ownership.',
      'Five paired observations give descriptive small-N distributions, not a precise tail estimate or automatic resource budget.',
      'Diagnostic measurements do not change any normal release latency, growth, activation or absolute memory gate.',
    ],
  };
  const persist = () => writeJson(path.join(output, 'experiment.json'), manifest);
  persist();
  let template;
  try {
    assert.strictEqual(source.gitStatus, '', 'Baseline requires a clean committed source tree; git status is retained in experiment.json');
    template = createOriginalWorkspace(path.join(__dirname, 'run.js'));
    manifest.fixture = fixtureIdentity(template);
    writeJson(path.join(output, 'fixture.json'), manifest.fixture);
    const executable = await downloadAndUnzipVSCode({ version, extensionDevelopmentPath: root });
    manifest.executable = { path: executable, sha256: sha256(fs.readFileSync(executable)) };
    persist();
    await executePlan(manifest, async sample => {
      const sampleDir = path.join(output, sample.sampleId);
      fs.mkdirSync(sampleDir);
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-pair-'));
      const workspace = path.join(tempRoot, 'workspace');
      fs.cpSync(template, workspace, { recursive: true });
      const userData = path.join(tempRoot, 'profile');
      const extensions = path.join(tempRoot, 'extensions');
      fs.mkdirSync(userData);
      fs.mkdirSync(extensions);
      const inertRoot = path.join(tempRoot, 'inert');
      fs.mkdirSync(inertRoot);
      writeJson(path.join(inertRoot, 'package.json'), controlManifest(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))));
      assert.strictEqual(fixtureIdentity(workspace).sha256, manifest.fixture.sha256, 'Each launch gets the identical source/settings contents');
      assert.strictEqual(sha256(fs.readFileSync(path.join(root, 'dist', 'extension.js'))), source.bundleSha256, 'Bundle changed during experiment');
      const config = {
        schemaVersion: SCHEMA_VERSION,
        sample: { pairId: sample.pairId, position: sample.position, order: sample.order, condition: sample.condition, sampleId: sample.sampleId },
        cell: manifest.cell,
        vscodeVersion: version,
        productRoot: root,
        fixtureSha256: manifest.fixture.sha256,
        sourceSha256: source.sha256,
        bundleSha256: source.bundleSha256,
        reportPath: path.join(sampleDir, 'report.json'),
        eventsPath: path.join(sampleDir, 'milestones.jsonl'),
        executable: manifest.executable,
        userData,
        extensions,
      };
      const configPath = path.join(sampleDir, 'input.json');
      writeJson(configPath, config);
      sample.reportPath = path.relative(output, config.reportPath);
      sample.inputPath = path.relative(output, configPath);
      const stdout = fs.createWriteStream(path.join(sampleDir, 'stdout.log'));
      const stderr = fs.createWriteStream(path.join(sampleDir, 'stderr.log'));
      const args = [
        workspace,
        ...(process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true' ? ['--disable-gpu'] : []),
        '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
        `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
      ];
      sample.launchArgs = args;
      sample.developmentExtension = sample.condition === 'control' ? inertRoot : root;
      persist();
      console.log(`[baseline] ${manifest.cell} ${sample.sampleId}`);
      try {
        const exitCode = await runTests({
          vscodeExecutablePath: executable,
          extensionDevelopmentPath: sample.developmentExtension,
          extensionTestsPath: path.join(__dirname, 'baseline-suite.js'),
          extensionTestsEnv: { ZEMDOMU_BASELINE_SAMPLE_CONFIG: configPath },
          launchArgs: args,
          stdout,
          stderr,
        });
        assert.strictEqual(exitCode, 0, 'Host must exit successfully');
        return JSON.parse(fs.readFileSync(config.reportPath, 'utf8'));
      } finally {
        stdout.end(); stderr.end();
        await Promise.all([finished(stdout), finished(stderr)]);
        // Every report, input, milestone and log is outside the temporary profile.
        // Failure evidence survives; only this launch's disposable local data goes.
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }, persist);
    manifest.status = 'passed';
    writeJson(path.join(output, 'summary.json'), { schemaVersion: SCHEMA_VERSION, cell: manifest.cell, source: manifest.source, ...manifest.summary });
    console.log(JSON.stringify({ cell: manifest.cell, status: manifest.status, summary: manifest.summary }, null, 2));
  } catch (error) {
    manifest.status = 'failed';
    manifest.error = { name: error.name, message: error.message, stack: error.stack };
    throw error;
  } finally {
    manifest.finishedAt = new Date().toISOString();
    persist();
    if (template) fs.rmSync(template, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().then(() => exitAfterOutput(0), error => { console.error(error); exitAfterOutput(1); });
}
module.exports = { sourceIdentity, executePlan };
