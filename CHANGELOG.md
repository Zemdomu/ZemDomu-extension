## Unreleased

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
