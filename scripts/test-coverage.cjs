const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateCoverage, validateSourceMaps } = require('./coverage-report.cjs');

const root = path.resolve(__dirname, '..');

function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0, `Command failed: ${script} ${args.join(' ')}`);
}

// Keep the normal minified build and every production size check mandatory.
assert.ok(process.env.npm_execpath, 'Run coverage with npm run test:coverage');
fs.rmSync(path.join(root, 'coverage'), { recursive: true, force: true });
run(process.env.npm_execpath, ['test']);
try {
  run(require.resolve('typescript/bin/tsc'), ['-p', 'tsconfig.json', '--sourceMap', '--inlineSources']);
  require('esbuild').buildSync({
    entryPoints: [path.join(root, 'src', 'extension.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    outfile: path.join(root, 'dist', 'extension.js'),
    sourcemap: true,
    sourcesContent: true,
  });
  validateSourceMaps(root);
  // Call the shared test bodies directly: npm posttest would delete the maps
  // before c8 can remap and report the collected V8 counters.
  run(require.resolve('c8/bin/c8.js'), [
    '--config', '.c8rc.json', process.execPath, 'scripts/run-functional-tests.cjs', '--coverage',
  ]);
  const summary = validateCoverage(root);
  run(path.join(root, 'tests', 'coverage-report.test.cjs'));
  console.log(`Validated mapped coverage for ${Object.keys(summary).length - 1} TypeScript source files`);
} finally {
  // Never leave the unminified measurement bundle or source maps for packaging.
  fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
}
