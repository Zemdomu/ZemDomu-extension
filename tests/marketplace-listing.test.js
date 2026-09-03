const assert = require('assert');
const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
);
const documents = ['README.md', 'docs/USER_GUIDE.md'];
const documentText = new Map(
  documents.map(relativePath => [
    relativePath,
    fs.readFileSync(path.join(packageRoot, relativePath), 'utf8'),
  ])
);
const expectedImages = [
  'images/marketplace-diagnostic.png',
  'images/marketplace-cross-component.png',
  'images/marketplace-vue-remediation.png',
];

assert.strictEqual(manifest.displayName, 'ZemDomu VS Code Extension');
assert.match(manifest.description, /semantic HTML/i);
assert.match(manifest.description, /accessibility diagnostics/i);
assert.ok(manifest.categories.includes('Linters'));
assert.ok(manifest.categories.includes('Programming Languages'));
assert.strictEqual(manifest.repository.url, 'https://github.com/Zemdomu/ZemDomu-extension.git');
assert.strictEqual(manifest.homepage, 'https://zemdomu.dev/');
assert.strictEqual(manifest.bugs.url, 'https://github.com/Zemdomu/ZemDomu-extension/issues');
assert.strictEqual(manifest.readme, 'docs/USER_GUIDE.md');

const searchableMetadata = manifest.keywords.join(' ').toLowerCase();
for (const term of [
  'semantic html',
  'accessibility',
  'a11y',
  'wcag',
  'jsx',
  'tsx',
  'react',
  'vue',
  'document structure',
  'diagnostics',
]) {
  assert.ok(searchableMetadata.includes(term), `Marketplace keywords are missing ${term}`);
}

const commandTitle = manifest.contributes.commands.find(
  command => command.command === 'zemdomu.lintWorkspace'
)?.title;
assert.ok(commandTitle, 'The workspace scan command must be declared');

for (const [relativePath, content] of documentText) {
  assert.ok(content.includes(commandTitle), `${relativePath} has a stale workspace command`);
  assert.doesNotMatch(content, /Scan Workspace for Semantic Issues/);
  assert.match(content, /HTML/);
  assert.match(content, /JSX/);
  assert.match(content, /TSX/);
  assert.match(content, /React/);
  assert.match(content, /Vue/);
  assert.match(content, /WCAG/);
  assert.match(content, /cross-component/i);
  assert.match(content, /ZMD004: <img> tag missing alt attribute/);

  const markdownLinks = Array.from(content.matchAll(/(!?)\[([^\]]*)\]\(([^)]+)\)/g));
  for (const [, imageMarker, label, target] of markdownLinks) {
    if (imageMarker) {
      assert.ok(label.trim().length >= 20, `${relativePath} image alt text is not useful`);
    }
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
    const localTarget = target.split('#', 1)[0];
    const resolved = path.resolve(packageRoot, path.dirname(relativePath), localTarget);
    assert.ok(fs.existsSync(resolved), `${relativePath} links to missing ${target}`);
  }
}

const rootReadme = documentText.get('README.md');
const marketplaceReadme = documentText.get('docs/USER_GUIDE.md');
for (const expectedLink of [
  'https://marketplace.visualstudio.com/items?itemName=ZachariasErydBerlin.zemdomu',
  manifest.homepage,
  manifest.bugs.url,
  manifest.repository.url.replace(/\.git$/, ''),
]) {
  assert.ok(marketplaceReadme.includes(expectedLink), `Marketplace user guide is missing ${expectedLink}`);
}
for (const imagePath of expectedImages) {
  assert.ok(rootReadme.includes(`](${imagePath})`), `Repository README is missing ${imagePath}`);
  assert.ok(
    marketplaceReadme.includes(
      `](https://raw.githubusercontent.com/Zemdomu/ZemDomu-extension/main/${imagePath})`
    ),
    `Marketplace user guide is missing the stable ${imagePath} URL`
  );
  const image = fs.readFileSync(path.join(packageRoot, imagePath));
  assert.strictEqual(image.toString('ascii', 1, 4), 'PNG', `${imagePath} must be a PNG`);
  assert.strictEqual(image.readUInt32BE(16), 1400, `${imagePath} width changed`);
  assert.strictEqual(image.readUInt32BE(20), 800, `${imagePath} height changed`);
}

console.log('Marketplace listing metadata, copy, links, commands, and visuals passed');
