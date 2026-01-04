# ZemDomu VS Code Extension

ZemDomu lints HTML, JSX, TSX, and Vue templates for semantic and accessibility issues. It
surfaces diagnostics in the Problems panel and inline editor warnings.

## Usage

1. Install the extension.
2. Open an `.html`, `.jsx`, `.tsx`, or `.vue` file.
3. Save the file, type, or run `ZemDomu: Scan Workspace for Semantic Issues`
   (`Ctrl+Alt+Z` / `Cmd+Alt+Z`).
4. Review results in the Problems panel and editor.

## Configuration

Settings are under the `zemdomu` namespace.

```json
"zemdomu.run": "onSave",
"zemdomu.crossComponentAnalysis": true,
"zemdomu.devMode": false,
"zemdomu.enableVerboseLogging": false
```

Rules and per-rule severity:

```json
"zemdomu.rules.requireAltText": true,
"zemdomu.severity.requireAltText": "warning"
```

Inline disabling:

```html
<!-- zemdomu-disable-next -->
<!-- zemdomu-disable -->
<!-- zemdomu-enable -->
```

```jsx
{/* zemdomu-disable-next */}
```

## Development

To build and package the extension:

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

The bundling step produces `dist/extension.js` with runtime code inlined.
`node_modules/` is excluded via `.vscodeignore`, keeping the packaged
extension small.

## License

MIT (c) 2025 Zacharias Eryd Berlin
