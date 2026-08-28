const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSync } = require('esbuild');

let tempDir;

if (!process.env.ZEMDOMU_CORE_ENTRY) {
  const localCoreEntry = path.resolve(__dirname, '../../ZemDomu-Core/src/index.ts');
  if (fs.existsSync(localCoreEntry)) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zemdomu-core-oracle-'));
    const bundlePath = path.join(tempDir, 'index.cjs');
    buildSync({
      entryPoints: [localCoreEntry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundlePath,
      logLevel: 'silent',
    });
    process.env.ZEMDOMU_CORE_ENTRY = bundlePath;
  }
}

if (tempDir) {
  process.on('exit', () => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}

require('./rule-oracle-matrix.test.js');
