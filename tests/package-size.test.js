const fs = require('fs');
const path = require('path');

const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
const MAX_VSIX_BYTES = 2 * 1024 * 1024;
const root = path.join(__dirname, '..');
const checks = {
  '--bundle': {
    label: 'Bundle',
    path: path.join(root, 'dist', 'extension.js'),
    limit: MAX_BUNDLE_BYTES,
  },
  '--vsix': {
    label: 'VSIX',
    path: path.join(root, 'dist', 'zemdomu.vsix'),
    limit: MAX_VSIX_BYTES,
  },
};

const requestedChecks = process.argv.slice(2);
if (requestedChecks.length !== 1 || !checks[requestedChecks[0]]) {
  throw new Error('Specify exactly one size check: `--bundle` or `--vsix`.');
}

const check = checks[requestedChecks[0]];
if (!fs.existsSync(check.path)) {
  throw new Error(`${check.label} not found at ${check.path}.`);
}

const bytes = fs.statSync(check.path).size;
const mib = (bytes / 1024 / 1024).toFixed(2);
const limitMib = (check.limit / 1024 / 1024).toFixed(2);
if (bytes >= check.limit) {
  throw new Error(`${check.label} is ${mib} MiB; it must stay below ${limitMib} MiB.`);
}

console.log(`${check.label} size passed: ${mib} MiB (limit: < ${limitMib} MiB)`);
