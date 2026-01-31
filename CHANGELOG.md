## Unreleased

- Feature: add quick fix for missing section headings (ZMD001) with safe heading level selection
- Feature: add quick fix for heading order skips (ZMD002) to correct the offending heading level
- Feature: add quick fix for extra <h1> headings (ZMD003) to convert to <h2>
- Feature: add quick fix for unlabeled form controls (ZMD005) to insert empty aria-label
- Feature: add quick fix for list nesting (ZMD006) to wrap <li> items with <ul>
- Feature: add quick fix option for router link "to" attribute when href is missing (ZMD010)
- Tests: add quick fix coverage for all supported quick fixes
- Feature: add quick fix to insert an empty <a href> inside <nav> (ZMD015)
- Feature: add quick fix to set tabindex to 0 or -1 (ZMD017)
- Security: pin lodash to 4.17.23 via overrides to address dependabot alert
- Docs: clarify requireButtonText expectations for accessible names (content, aria-label, aria-labelledby)
- Feature: expand ZMD005 quick fixes for labels/id/htmlFor/for and placeholder aria-labels
- Feature: add ZMD018 placeholder warnings and switch quick fix placeholders to TODO-ZMD
- Bugfix: wrap full <li> blocks for ZMD006 quick fixes instead of only the opening line
- Bugfix: clear stale diagnostics on file save when issues are resolved
- Feature: ZMD001 quick fix adds aria-label/aria-labelledby placeholders instead of inserting headings

## 0.0.12

- Chore: bump zemdomu core dependency to 1.3.16

## 0.0.11

- Chore: bump zemdomu core dependency to 1.3.15
