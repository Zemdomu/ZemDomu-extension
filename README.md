# ZemDomu VS Code Extension

> Semantic feedback while you code.

The ZemDomu VS Code Extension brings ZemDomu's semantic checks directly into the
editor. It highlights structure, accessibility, and search-related markup
issues while you work, so you can fix them before they become CI failures or
late-stage audit findings.

Most linters check syntax. ZemDomu checks meaning.

## What It Is

ZemDomu is a VS Code extension for HTML, JSX, TSX, and Vue templates. It
integrates with inline diagnostics, the Problems panel, workspace scans, and
quick fixes so semantic feedback becomes part of normal development rather than
an extra review step.

## Why ZemDomu

Compared with generic editor linting and post-deploy scanners, ZemDomu is built
to give faster and more actionable semantic feedback while you code.

- Focused semantic diagnostics for document structure, accessible names, and landmarks.
- Consistent rule behavior with ZemDomu Core and the ZemDomu GitHub Action.
- Cross-component analysis to surface issues hidden behind imports.
- Built-in quick fixes for common remediation paths.

## Features

- Lints HTML, JSX, TSX, and Vue templates with semantic rules.
- Runs on save, on type, or manually.
- Workspace scan command and status bar issue count.
- Cross-component JSX and Vue analysis.
- Quick fixes for common missing attributes and semantic issues.
- Optional verbose logging and performance diagnostics.

## Quick Start

1. Install from the VS Code Marketplace or search for `ZemDomu` in Extensions.
2. Open an `.html`, `.jsx`, `.tsx`, or `.vue` file.
3. Save the file or run `ZemDomu: Scan Workspace for Semantic Issues`
   (`Ctrl+Alt+Z` / `Cmd+Alt+Z`).
4. Review findings in the Problems panel and editor.

## Configuration

Settings are under the `zemdomu` namespace.

### Run Mode

```json
"zemdomu.run": "onSave"
```

Options: `onSave`, `onType`, `manual`, `disabled`.

### Cross-Component Analysis

```json
"zemdomu.crossComponentAnalysis": true
```

### Logging and Diagnostics

```json
"zemdomu.devMode": false,
"zemdomu.enableVerboseLogging": false
```

`devMode` enables the `ZemDomu Perf` output channel. `enableVerboseLogging`
adds structured lifecycle logs to the `ZemDomu` output channel.

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
- requireButtonText
- requireIframeTitle
- requireHtmlLang
- requireImageInputAlt
- requireNavLinks
- uniqueIds
- preventZemdomuPlaceholders
- requireDocumentTitle
- requireSingleMain
- ariaValidAttrValue

## Inline Disabling

```html
<!-- zemdomu-disable-next -->
<!-- zemdomu-disable -->
<!-- zemdomu-enable -->
```

```jsx
{/* zemdomu-disable-next */}
```

## Local Development

From the extension package:

```bash
cd packages/ZemDomu-Extension
npm install
npm test
```

## Links

- Extension page: https://marketplace.visualstudio.com/items?itemName=ZachariasErydBerlin.zemdomu
- Issues and suggestions: https://github.com/ZemDomu/ZemDomu-extension/issues
- ZemDomu Core: https://www.npmjs.com/package/zemdomu
- Website and docs: https://zemdomu.dev/

## License

MIT (c) 2025 Zacharias Eryd Berlin
