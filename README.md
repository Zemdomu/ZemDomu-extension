<p align="center">
  <img src="images/icon.png" width="100" alt="ZemDomu logo" />
</p>

<h1 align="center">ZemDomu</h1>

<p align="center">
  <em>Semantic HTML linting for a cleaner, more accessible web</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=ZachariasErydBerlin.zemdomu">
    <img src="https://img.shields.io/visual-studio-marketplace/v/ZachariasErydBerlin.zemdomu?label=VS%20Code" alt="VS Code Marketplace" />
  </a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
</p>

---

## What is ZemDomu?

ZemDomu is a VS Code extension that lints HTML, JSX, TSX, and Vue templates for
semantic and accessibility issues. It integrates with the Problems panel and
inline diagnostics so you can catch structural problems early.

---

## Features

- Lints HTML, JSX, TSX, and Vue templates with semantic rules.
- Runs on save, on type, or manually.
- Workspace scan command and status bar issue count.
- Cross-component JSX/Vue analysis.
- Quick fixes for common missing attributes.
- Optional verbose logging and performance diagnostics.

---

## Getting Started

1. Install from the VS Code Marketplace or search for "ZemDomu" in Extensions.
2. Open an `.html`, `.jsx`, `.tsx`, or `.vue` file.
3. Save the file or run `ZemDomu: Scan Workspace for Semantic Issues`
   (`Ctrl+Alt+Z` / `Cmd+Alt+Z`).
4. Review findings in the Problems panel and editor.

---

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
- requireButtonText
- requireIframeTitle
- requireHtmlLang
- requireImageInputAlt
- requireNavLinks
- uniqueIds

### Inline disabling

```html
<!-- zemdomu-disable-next -->
<!-- zemdomu-disable -->
<!-- zemdomu-enable -->
```

```jsx
{/* zemdomu-disable-next */}
```

---

## Links

Development happens in a private monorepo; this repository is the public mirror
for issues and updates.

- Extension page: https://marketplace.visualstudio.com/items?itemName=ZachariasErydBerlin.zemdomu
- Public mirror: https://github.com/Zemdomu/ZemDomu-extension
- Issues and suggestions: https://github.com/Zemdomu/ZemDomu-extension/issues

---

## License

MIT (c) 2025 Zacharias Eryd Berlin
