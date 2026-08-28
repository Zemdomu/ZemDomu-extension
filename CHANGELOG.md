## Unreleased

### Bugfix

- Bugfix: publish the same inspected VSIX that passes the deterministic release checks, with clean-profile installation and real Extension Host smoke coverage before Marketplace publication.
- Bugfix: verify rule enablement, severity changes, and status-bar issue counts as part of the launch test suite.
- Bugfix: make on-save, on-type, manual, and disabled run modes honor their documented triggers, including linting unsaved editor buffers in on-type mode and avoiding implicit workspace scans during activation or settings changes.
- Bugfix: preserve last-known diagnostics when scans fail and report failures through the scan command, a user-visible error, and actionable output-channel details.
- Bugfix: honor inline disable-next, disable, and enable controls in shipped HTML, JSX/TSX, and Vue project scans, including same-line blocks and multiple findings on one line.
- Bugfix: preserve repeated HTML findings instead of collapsing diagnostics that share a rule, message, and line.
- Bugfix: target quick fixes with document-absolute offsets and correct line/column conversion, including table caption insertion in multiline and CRLF documents.
- Bugfix: replace empty accessibility attribute values without creating duplicate attributes, and withhold unsafe list-wrapping fixes for inline JSX expressions.
- Bugfix: replace corrupted characters in settings, progress notifications, and diagnostic log previews.

### Feature

- Feature: expose `crossComponentDepth` as a supported setting and analyze each folder in a multi-root workspace as an independent project root.

### Docs

- Docs: identify `singleH1` and `requireNavLinks` as house style, and table-caption and section-heading guidance as advisory unless a specific conformance requirement applies.
- Docs: add guided GitHub report forms for extension bugs, false positives, false negatives, and performance regressions.
- Docs: list all 21 supported rules consistently in the README and Marketplace user guide, including `noTabindexGreaterThanZero`.
- Docs: explain run modes, supported VS Code versions, static-analysis limitations, privacy, troubleshooting, and performance diagnostics in the Marketplace user guide.

### Performance

- Performance: enforce a 5 MiB bundle ceiling and a 2 MiB packaged VSIX ceiling; the verified release candidate is 1.27 MiB and excludes source, tests, compiled `out/`, dependencies, and stale VSIX files.
- Performance: add a reproducible 1,000-file mixed-framework workspace benchmark with enforced scan-time and peak-memory launch thresholds.

### Security

- Security: update production and release-tool dependency overrides to patched versions and enforce a zero-high production audit in pull-request and release pipelines.
- Security: update dependency overrides and the lockfile to patched js-yaml, brace-expansion, undici, fast-uri, and related transitive versions.

## 0.0.17

### Bugfix

- Bugfix: bundle ZemDomu Core 1.3.19 so the extension includes decorative image alt handling and framework app-shell HTML fixes.

## 0.0.16

### Security

- Security: update extension build and packaging dependencies, and refresh dependency overrides, to clear current npm audit vulnerabilities in the extension toolchain.

### Bugfix

- Bugfix: expose `noTabindexGreaterThanZero` in extension rule settings and diagnostic documentation links.

## 0.0.15

### Security

- Security: bump the undici override to 7.24.0 and add a yauzl override to 3.2.1 to resolve current Dependabot alerts in the extension packaging toolchain without changing linting behavior.

## 0.0.14

### Bugfix

- Bugfix: avoid inserting form control quick fix attributes inside JSX arrow expressions
- Bugfix: fix <caption> quick fix insertion offset to use the table tag end
- Bugfix: recognize `requireLinkText` diagnostics by rule/code so the aria-label quick fix still appears when core message wording changes

### Feature

- Feature: add quick fixes for `requireDocumentTitle` (ZMD019), `requireSingleMain` (ZMD020), and `ariaValidAttrValue` (ZMD021).
- Feature: add extension rule/severity settings for `requireDocumentTitle`, `requireSingleMain`, and `ariaValidAttrValue`.
- Feature: add quick fix for links missing accessible names (ZMD007)
- Feature: add npm funding metadata linking to Buy Me a Coffee for `npm fund`

### Security

- Security: override @isaacs/brace-expansion to 5.0.1 to address the dependabot alert.
- Security: add dependency overrides for ajv, markdown-it, minimatch, qs, and undici to resolve dependabot vulnerability alerts without changing extension behavior.

### Chore

- Chore: add quick fix coverage for requireLinkText
- Chore: clean out/dist build artifacts after tests
- Chore: add fixture-driven behavior tests that validate core rule hits and extension quick-fix output from JSON test files
- Chore: update the bundled ZemDomu core dependency to 1.3.18 for this release.

### Docs

- Docs: add a "Why ZemDomu vs alternatives" section to the extension README.
- Docs: update requireLinkText setting description to reference accessible names
- Docs: clarify requireHtmlLang setting now validates language tags
- Docs: update requireAltText setting description to include SVG icons

## 0.0.13

### Feature

- Feature: add quick fix for missing section headings (ZMD001) with safe heading level selection
- Feature: add quick fix for heading order skips (ZMD002) to correct the offending heading level
- Feature: add quick fix for extra <h1> headings (ZMD003) to convert to <h2>
- Feature: add quick fix for unlabeled form controls (ZMD005) to insert empty aria-label
- Feature: add quick fix for list nesting (ZMD006) to wrap <li> items with <ul>
- Feature: add quick fix option for router link "to" attribute when href is missing (ZMD010)
- Feature: add quick fix to insert an empty <a href> inside <nav> (ZMD015)
- Feature: add quick fix to set tabindex to 0 or -1 (ZMD017)
- Feature: expand ZMD005 quick fixes for labels/id/htmlFor/for and placeholder aria-labels
- Feature: add ZMD018 placeholder warnings and switch quick fix placeholders to TODO-ZMD
- Feature: ZMD001 quick fix adds aria-label/aria-labelledby placeholders instead of inserting headings

### Bugfix

- Bugfix: wrap full <li> blocks for ZMD006 quick fixes instead of only the opening line
- Bugfix: clear stale diagnostics on file save when issues are resolved

### Docs

- Docs: clarify requireButtonText expectations for accessible names (content, aria-label, aria-labelledby)

### Tests

- Tests: add quick fix coverage for all supported quick fixes

### Security

- Security: pin lodash to 4.17.23 via overrides to address dependabot alert

### Chore

- Chore: bump zemdomu core dependency to 1.3.17

## 0.0.12

- Chore: bump zemdomu core dependency to 1.3.16

## 0.0.11

- Chore: bump zemdomu core dependency to 1.3.15
