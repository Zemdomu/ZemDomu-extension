const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} = require('@vscode/test-electron');

function runCli(cliPath, args) {
  if (process.platform !== 'win32') {
    return spawnSync(cliPath, args, { encoding: 'utf8' });
  }

  const vscodeRoot = path.resolve(path.dirname(cliPath), '..');
  const candidates = [
    vscodeRoot,
    ...fs.readdirSync(vscodeRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(vscodeRoot, entry.name)),
  ];
  const appRoot = candidates.find(candidate =>
    fs.existsSync(path.join(candidate, 'resources', 'app', 'out', 'cli.js'))
  );
  assert.ok(appRoot, `Could not locate the VS Code CLI entrypoint under ${vscodeRoot}`);

  return spawnSync(
    path.join(vscodeRoot, 'Code.exe'),
    [path.join(appRoot, 'resources', 'app', 'out', 'cli.js'), ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }
  );
}

async function main() {
  const packageRoot = path.resolve(__dirname, '..');
  const manifest = require(path.join(packageRoot, 'package.json'));
  const vsixPath = path.join(packageRoot, 'dist', 'zemdomu.vsix');
  assert.ok(fs.existsSync(vsixPath), 'Build the VSIX before testing installation');

  const version = process.env.VSCODE_TEST_VERSION || 'stable';
  const executable = await downloadAndUnzipVSCode(version);
  const [cliPath, ...baseArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-vsix-'));
  const userDataDir = path.join(profileRoot, 'user-data');
  const extensionsDir = path.join(profileRoot, 'extensions');

  try {
    const install = runCli(
      cliPath,
      [
        ...baseArgs,
        '--user-data-dir',
        userDataDir,
        '--extensions-dir',
        extensionsDir,
        '--install-extension',
        vsixPath,
        '--force',
      ]
    );
    assert.strictEqual(
      install.status,
      0,
      `Clean-profile VSIX install failed:\n${install.error || ''}\n${install.stdout}\n${install.stderr}`
    );

    const list = runCli(
      cliPath,
      [
        ...baseArgs,
        '--user-data-dir',
        userDataDir,
        '--extensions-dir',
        extensionsDir,
        '--list-extensions',
        '--show-versions',
      ]
    );
    assert.strictEqual(list.status, 0, `Could not list installed extensions: ${list.stderr}`);
    const installedId = `${manifest.publisher}.${manifest.name}@${manifest.version}`.toLowerCase();
    assert.ok(
      list.stdout.toLowerCase().split(/\r?\n/).includes(installedId),
      'Clean profile does not contain the packaged ZemDomu extension'
    );

    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: path.join(__dirname, 'installed-extension-host', 'harness'),
      extensionTestsPath: path.join(
        __dirname,
        'installed-extension-host',
        'harness',
        'suite',
        'index.js'
      ),
      extensionTestsEnv: {
        ZEMDOMU_EXPECTED_EXTENSION_ID: `${manifest.publisher}.${manifest.name}`,
      },
      launchArgs: [
        path.join(__dirname, 'installed-extension-host', 'workspace'),
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
    });
  } finally {
    const resolvedProfile = path.resolve(profileRoot);
    const resolvedTemp = path.resolve(os.tmpdir());
    assert.ok(
      resolvedProfile.startsWith(`${resolvedTemp}${path.sep}`),
      'Refusing to remove a profile outside the system temp directory'
    );
    fs.rmSync(resolvedProfile, { recursive: true, force: true });
  }

  console.log(`Clean-profile VSIX install and activation passed on VS Code ${version}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
