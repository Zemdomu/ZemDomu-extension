# ZemDomu — Semantic Accessibility Diagnostics for VS Code

ZemDomu finds supported semantic HTML and accessibility defects in HTML, JSX,
TSX, React, and Vue source. It reports each finding at the source and can follow
supported local component composition when a structural conflict is hidden
behind imports.

## Try It in Under a Minute

1. Install [ZemDomu from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ZachariasErydBerlin.zemdomu).
2. Open an `.html`, `.jsx`, `.tsx`, or `.vue` file.
3. Save the file, type, or run
   `ZemDomu: Scan Workspace for Semantic Accessibility Issues`
   (`Ctrl+Alt+Z` / `Cmd+Alt+Z`).
4. Review the rule code, severity, file, line, and column in the editor or
   Problems panel.

For example, this TSX source produces
`ZMD004: <img> tag missing alt attribute` at the image line:

```tsx
export function ProductCard({ product }) {
  return <img src={product.image} />;
}
```

![VS Code example showing ZMD004 at ProductCard.tsx line 5 for an image without alternative text.](https://raw.githubusercontent.com/Zemdomu/ZemDomu-extension/main/images/marketplace-diagnostic.png)

Cross-component analysis is the distinction: when enabled, ZemDomu follows
statically resolvable local React and Vue composition and adds supported page,
component-path, and related-source context to diagnostics.

![JSX example showing ZMD003 with the App, PageLayout, and ProductHero component path plus its related source location.](https://raw.githubusercontent.com/Zemdomu/ZemDomu-extension/main/images/marketplace-cross-component.png)

## Configuration

Settings are under the `zemdomu` namespace.

```json
"zemdomu.run": "onSave",
"zemdomu.crossComponentAnalysis": true,
"zemdomu.crossComponentDepth": 50,
"zemdomu.devMode": false,
"zemdomu.enableVerboseLogging": false
```

### Run Modes

| Value | Behavior |
| --- | --- |
| `onSave` | Lints the saved file after each save. This is the default. |
| `onType` | Lints the current unsaved editor buffer after a short debounce. |
| `manual` | Runs only when you use `ZemDomu: Scan Workspace for Semantic Accessibility Issues`. |
| `disabled` | Never starts an automatic scan. The manual workspace command remains available. |

Changing settings rebuilds the linter and listener configuration without
starting an implicit workspace scan. In `disabled` mode, ZemDomu preserves
existing diagnostics until a later successful manual scan refreshes them.

Manual workspace scans report file discovery, workspace-folder analysis,
diagnostic publication, and completion in a VS Code progress notification.
The ZemDomu status bar item exposes the same state with an explicit accessible
label; focus the VS Code status bar with the keyboard to review or activate it.
Scans are non-cancellable in 1.0 because the measured 1,000-file p95 is about
2.37 seconds and partial cancellation cannot yet preserve atomic results.

Rules and per-rule severity:

```json
"zemdomu.rules.requireAltText": true,
"zemdomu.severity.requireAltText": "warning"
```

## Supported Rules

- `requireSectionHeading`
- `enforceHeadingOrder`
- `singleH1`
- `requireAltText`
- `requireLabelForFormControls`
- `enforceListNesting`
- `requireLinkText`
- `requireTableCaption`
- `preventEmptyInlineTags`
- `requireHrefOnAnchors`
- `requireButtonText`
- `requireIframeTitle`
- `requireHtmlLang`
- `requireImageInputAlt`
- `requireNavLinks`
- `uniqueIds`
- `noTabindexGreaterThanZero`
- `preventZemdomuPlaceholders`
- `requireDocumentTitle`
- `requireSingleMain`
- `ariaValidAttrValue`
- `requirePageH1`

Inline disabling:

```html
<!-- zemdomu-disable-next -->
<!-- zemdomu-disable -->
<!-- zemdomu-enable -->
```

```jsx
{/* zemdomu-disable-next */}
```

`zemdomu-disable-next` applies to the next markup line (or the remaining
markup on the same line). `zemdomu-disable` suppresses findings until the next
`zemdomu-enable`. All findings in the controlled range are suppressed in HTML,
JSX/TSX, and Vue templates.

## Cross-Component and Multi-Root Workspaces

`crossComponentDepth` limits how many local dependency levels ZemDomu follows;
`0` analyzes only the requested entry files. In a multi-root workspace, ZemDomu
analyzes each workspace folder independently with that folder as its project
root. Files outside the workspace are linted as standalone files without
cross-component analysis.

ZemDomu treats `singleH1` and `requireNavLinks` as house-style rules.
`requireTableCaption` and `requireSectionHeading` are advisory by default;
whether their guidance is required depends on the document and the conformance
criteria that apply. Their default severity remains `warning`.
`requirePageH1` is also advisory: it reports a missing first-level heading only
when Core can resolve a composed page with enough confidence. Page identity,
component path, related source locations, and conservative suggestions appear
with the diagnostic when Core supplies them.

`enforceHeadingOrder` compares each heading with the previous heading it can
observe and warns only when a later heading skips upward levels. The first
observed heading does not warn. `singleH1` reports additional `<h1>` elements
but does not require one, so the current VS Code Extension does not report a
missing first or page-level `<h1>`.

## From Finding to Fix

ZemDomu identifies supported structural requirements without inventing the
author's meaning. When a fix needs a human-readable label, description, ARIA
state, or hierarchy decision, supply that intent and scan again. A `TODO-ZMD`
placeholder always requires author review.

![Vue before-and-after example showing ZMD004 cleared after the author adds meaningful alternative text.](https://raw.githubusercontent.com/Zemdomu/ZemDomu-extension/main/images/marketplace-vue-remediation.png)

## What Static Analysis Cannot Prove

ZemDomu finds source patterns; it cannot establish WCAG conformance. A passing
scan does not prove that the rendered application is accessible. Continue to
test the rendered DOM, keyboard interaction, focus order, visual contrast,
zoom and reflow, browser accessibility trees, and relevant screen readers.

Runtime state, CSS, generated content, dynamic or bound values, conditional
rendering, fragments, and slotted content can change the accessible result.
ZemDomu handles supported static cases conservatively, but ambiguous cases
still require human review. Cross-component analysis follows resolvable local
imports up to `crossComponentDepth`; runtime-selected components, external
packages, and imports the project resolver cannot resolve may remain outside
the combined source model.

## Supported VS Code Versions

ZemDomu supports VS Code `1.105.0` and later. Release validation runs in a real
Extension Host against `1.105.0` and the current stable VS Code release.

## Privacy and Data Processing

Linting runs locally inside the VS Code Extension Host. ZemDomu reads supported
workspace files to calculate diagnostics and does not transmit source files,
diagnostics, or usage telemetry. Documentation links open only when you choose
to follow them.

The `ZemDomu` and `ZemDomu Perf` output channels can contain local file paths,
rule names, timings, and diagnostic summaries. Review and sanitize that output
before sharing it in a public issue.

## Performance Diagnostics

Set `zemdomu.devMode` to `true` to enable the `ZemDomu Perf` output channel.
After a workspace scan, it reports phase timings and the slowest analyzed file.
Set `zemdomu.enableVerboseLogging` to `true` for structured lint lifecycle data
in the `ZemDomu` output channel. Keep both settings off during normal use and
enable them while reproducing a performance or diagnostic-lifecycle problem.

When reporting performance, include your hardware, operating system, VS Code
and ZemDomu versions, workspace file counts, relevant settings, operation, run
count, median or p95 time when available, and peak memory use.

## Troubleshooting

### No diagnostics appear

1. Confirm the file language is HTML, JavaScript React, TypeScript React, or Vue.
2. Check `zemdomu.run`. In `manual` or `disabled`, run the workspace-scan command.
3. Confirm the relevant `zemdomu.rules.*` setting is enabled.
4. Open **Output: ZemDomu** and rerun the scan to look for an actionable error.

### Cross-component findings are missing

Confirm `zemdomu.crossComponentAnalysis` is enabled, the files share the same
workspace folder, and `zemdomu.crossComponentDepth` is large enough. Reduce the
case to local static imports; runtime-selected or unresolved imports cannot be
combined reliably by source analysis.

### A scan fails

ZemDomu preserves the last known diagnostics instead of replacing them with an
empty result. Open **Output: ZemDomu**, copy a sanitized error, and retry the
manual scan. If it still fails, use the bug-report form linked from the
Marketplace listing.

### A quick fix leaves `TODO-ZMD`

The marker means the extension could target the correct node but could not
safely invent the needed human-readable label, content, ARIA state, or list
ordering. Replace the marker, save the file, and scan again.

ZemDomu withholds a quick fix when the correct change depends on author intent,
including heading hierarchy, duplicate landmark roles, keyboard focus order,
label associations, and props on custom framework components. Make those
changes manually so the extension does not encode a plausible but incorrect
semantic choice.

## Development

To build and package the extension:

```bash
npm run release
```

Individual steps if you prefer to run them separately:

```bash
npm ci
npm run compile
npm run bundle
npm run package
```

The bundling step produces `dist/extension.js` with runtime code inlined.
`node_modules/` is excluded via `.vscodeignore`, keeping the packaged
extension small.

## Links

- [Website and rule documentation](https://zemdomu.dev/)
- [Report a bug or diagnostic problem](https://github.com/Zemdomu/ZemDomu-extension/issues)
- [Extension source](https://github.com/Zemdomu/ZemDomu-extension)
- [ZemDomu Core](https://www.npmjs.com/package/zemdomu)

## License

MIT (c) 2025 Zacharias Eryd Berlin
