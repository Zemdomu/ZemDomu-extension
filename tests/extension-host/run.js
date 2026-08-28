const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
  const workspacePath = path.resolve(__dirname, 'workspace');
  const version = process.env.VSCODE_TEST_VERSION || 'stable';

  await runTests({
    version,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
}

main().catch(error => {
  console.error('VS Code Extension Host tests failed');
  console.error(error);
  process.exitCode = 1;
});
