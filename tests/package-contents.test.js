const assert = require('assert');
const path = require('path');
const fs = require('fs');
const yauzl = require('yauzl');

const vsixPath = path.resolve(__dirname, '..', 'dist', 'zemdomu.vsix');
assert.ok(fs.existsSync(vsixPath), 'Build the VSIX before inspecting its contents');

function readEntries(archivePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError) return reject(openError);
      const entries = [];
      zipFile.on('error', reject);
      zipFile.on('entry', entry => {
        if (!entry.fileName.endsWith('/')) entries.push(entry.fileName.replace(/\\/g, '/'));
        zipFile.readEntry();
      });
      zipFile.on('end', () => resolve(entries));
      zipFile.readEntry();
    });
  });
}

(async () => {
  const archiveEntries = await readEntries(vsixPath);
  const extensionFiles = archiveEntries
    .filter(file => file.startsWith('extension/'))
    .map(file => file.slice('extension/'.length));

  for (const required of [
    'dist/extension.js',
    'package.json',
    'readme.md',
    'changelog.md',
    'LICENSE.txt',
    'docs/USER_GUIDE.md',
    'images/icon.png',
  ]) {
    assert.ok(extensionFiles.includes(required), `VSIX is missing ${required}`);
  }

  const forbidden = [
    /^out\//,
    /^src\//,
    /^tests\//,
    /^types\//,
    /^\.github\//,
    /^\.vscode\//,
    /^node_modules\//,
    /\.vsix$/i,
  ];

  for (const file of extensionFiles) {
    assert.ok(
      !forbidden.some(pattern => pattern.test(file)),
      `VSIX contains non-runtime file ${file}`
    );
  }

  assert.strictEqual(
    extensionFiles.length,
    7,
    `VSIX contains unexpected runtime files: ${extensionFiles.join(', ')}`
  );
  console.log(`VSIX archive contents passed (${extensionFiles.length} runtime files)`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
