# Dependency Override Review

Last reviewed: 2026-08-28
Owner: ZemDomu maintainer
Next review: 2026-09-28

The extension uses temporary major-version overrides for `js-yaml` and
`markdown-it` because the latest `@vscode/vsce` release still declares older
ranges with known high-severity findings. These packages are used only by the
test and VSIX release toolchain; they are not bundled into `dist/extension.js`
or shipped as runtime dependencies.

Compatibility is guarded by the full extension test suite, VSIX creation,
archive-content inspection, clean-profile installation, and activation of the
installed VSIX. Remove each override when its parent release accepts the
patched major version directly.
