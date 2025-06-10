This repository contains the source code for ZemDomu, a VS Code extension that checks for semantic HTML issues.

## Development
To minimize the extension size, the build process bundles the compiled
JavaScript into a single file. Run the following commands to build and
package the extension:

```bash
npm run publish-all
```

Individual steps if you prefer to run them separately:

```bash
npm install
npm run compile
npm run bundle
npm run package
```

## License

MIT © 2025 Zacharias Eryd Berlin