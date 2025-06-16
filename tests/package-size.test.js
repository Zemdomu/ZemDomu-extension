const fs = require('fs');
const path = require('path');

const bundlePath = path.join(__dirname, '..', 'dist', 'extension.js');
if (!fs.existsSync(bundlePath)) {
  throw new Error('Bundle not found. Run `npm run bundle` first.');
}
const bytes = fs.statSync(bundlePath).size;
const kb = (bytes / 1024).toFixed(2);
console.log(`Bundle size: ${kb} KB`);
