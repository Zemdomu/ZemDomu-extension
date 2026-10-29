# Contributing to the ZemDomu extension

You can help by reporting unexpected diagnostics, improving the user guide, or
fixing how findings appear and update in VS Code.

## Find the right place

Search the [extension issues](https://github.com/Zemdomu/ZemDomu-extension/issues)
before opening a report. Use the bug, false-positive, false-negative, or
performance form that fits your case. Include the installed ZemDomu and VS Code
versions, file language, run mode, relevant settings, exact steps, and expected
and actual results. Include imported components when composition affects the
finding.

Remove private code, credentials, personal data, and identifying file paths
from examples, screenshots, and output-channel logs. A small standalone
reproduction is more useful than a private project archive. See
[SECURITY.md](SECURITY.md) for suspected vulnerabilities.

Use [Core issues](https://github.com/Zemdomu/ZemDomu-core/issues) for CLI or
programmatic API defects and [Action issues](https://github.com/Zemdomu/ZemDomu-action/issues)
for CI integration defects. If you are unsure where a diagnostic originates,
report it here with the workflow that exposed it. Cross-product questions and
ideas belong in [Meta discussions](https://github.com/Zemdomu/ZemDomu/discussions).

## Work on a change

For a substantial feature or behavior change, open an issue first to discuss
the use case and expected result. Keep pull requests focused on one problem.
Follow the [code of conduct](CODE_OF_CONDUCT.md).

From the root of your extension checkout, install dependencies and run the
checks declared in `package.json`:

```sh
npm ci
npm test
```

`npm test` compiles and bundles the extension before running its automated
checks. For a focused edit/build cycle, use:

```sh
npm run compile
npm run bundle
```

See the [user guide](docs/USER_GUIDE.md) for settings, supported VS Code versions,
privacy, and troubleshooting. Do not commit generated bundles, local workspace
files, or private fixtures.

## Open a pull request

Explain the user-visible problem, the resulting behavior, and how you checked
it. Add a regression test for a behavior fix and update user-facing guidance
when settings or diagnostics change. For documentation-only work, check links
and examples and say that code tests were not run. Record customer-relevant
changes under the appropriate category in the unreleased changelog.

Accessibility rule changes should explain their detection limits and the
relevant standard or authoring policy. Source analysis cannot establish WCAG
conformance; avoid claims that a passing scan proves an accessible result.
