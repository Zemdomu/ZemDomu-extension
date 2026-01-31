# ZemDomu VS Code Extension

Semantic HTML linting for a cleaner, more accessible web.

## What it is

ZemDomu is a VS Code extension that lints HTML, JSX, TSX, and Vue templates for
semantic and accessibility issues. It integrates with the Problems panel and
inline diagnostics so you can catch structural problems early.

## Features

- Lints HTML, JSX, TSX, and Vue templates with semantic rules.
- Runs on save, on type, or manually.
- Workspace scan command and status bar issue count.
- Cross-component JSX/Vue analysis.
- Quick fixes for common missing attributes.
- Optional verbose logging and performance diagnostics.

## Quick start

1. Install from the VS Code Marketplace or search for "ZemDomu" in Extensions.
2. Open an `.html`, `.jsx`, `.tsx`, or `.vue` file.
3. Save the file or run `ZemDomu: Scan Workspace for Semantic Issues`
   (`Ctrl+Alt+Z` / `Cmd+Alt+Z`).
4. Review findings in the Problems panel and editor.

## Configuration

Settings are under the `zemdomu` namespace.

### Run mode

```json
"zemdomu.run": "onSave"
```

Options: `onSave`, `onType`, `manual`, `disabled`.

### Cross-component analysis

```json
"zemdomu.crossComponentAnalysis": true
```

### Logging and diagnostics

```json
"zemdomu.devMode": false,
"zemdomu.enableVerboseLogging": false
```

`devMode` enables the "ZemDomu Perf" output channel. `enableVerboseLogging`
adds structured lifecycle logs to the "ZemDomu" channel.

### Rules

Enable or disable individual rules:

```json
"zemdomu.rules.requireAltText": true,
"zemdomu.rules.enforceHeadingOrder": true
```

Override severity per rule:

```json
"zemdomu.severity.requireAltText": "warning",
"zemdomu.severity.enforceHeadingOrder": "error"
```

Supported rules:

- requireSectionHeading
- enforceHeadingOrder
- singleH1
- requireAltText
- requireLabelForFormControls
- enforceListNesting
- requireLinkText
- requireTableCaption
- preventEmptyInlineTags
- requireHrefOnAnchors
- requireButtonText (non-empty accessible name from content, aria-label, or aria-labelledby)
- requireIframeTitle
- requireHtmlLang
- requireImageInputAlt
- requireNavLinks
- uniqueIds
- preventZemdomuPlaceholders

### Inline disabling

```html
<!-- zemdomu-disable-next -->
<!-- zemdomu-disable -->
<!-- zemdomu-enable -->
```

```jsx
{/* zemdomu-disable-next */}
```

## Local development (monorepo)

From the extension package:

```bash
cd packages/ZemDomu-Extension
npm install
npm test
```

## Links

Development happens in a private monorepo; this repository is the public mirror
for issues and updates.

- Extension page: https://marketplace.visualstudio.com/items?itemName=ZachariasErydBerlin.zemdomu
- Public mirror: https://github.com/Zemdomu/ZemDomu-extension
- Issues and suggestions: https://github.com/Zemdomu/ZemDomu-extension/issues
- ZemDomu core: https://www.npmjs.com/package/zemdomu

## License

MIT (c) 2025 Zacharias Eryd Berlin
