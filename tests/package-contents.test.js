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

function readTextEntry(archivePath, targetPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError) return reject(openError);
      zipFile.on('error', reject);
      zipFile.on('entry', entry => {
        if (entry.fileName !== targetPath) {
          zipFile.readEntry();
          return;
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            zipFile.close();
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
        });
      });
      zipFile.on('end', () => reject(new Error(`VSIX is missing ${targetPath}`)));
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
    'images/icon.png',
    'images/marketplace-cross-component.png',
    'images/marketplace-diagnostic.png',
    'images/marketplace-vue-remediation.png',
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
    9,
    `VSIX contains unexpected runtime files: ${extensionFiles.join(', ')}`
  );

  const packagedReadme = await readTextEntry(vsixPath, 'extension/readme.md');
  assert.match(packagedReadme, /## Try It in Under a Minute/);
  assert.match(packagedReadme, /ZMD004: <img> tag missing alt attribute/);
  assert.doesNotMatch(packagedReadme, /raw\/HEAD\/\.\.\/images/);
  for (const imageName of [
    'marketplace-diagnostic.png',
    'marketplace-cross-component.png',
    'marketplace-vue-remediation.png',
  ]) {
    assert.ok(
      packagedReadme.includes(
        `https://raw.githubusercontent.com/Zemdomu/ZemDomu-extension/main/images/${imageName}`
      ),
      `Packaged Marketplace README is missing ${imageName}`
    );
  }
  console.log(`VSIX archive contents passed (${extensionFiles.length} runtime files)`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
