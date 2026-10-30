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

### Property tests

The normal test suite also runs four fast-check properties against the production
diagnostic adapter and inline-disable implementation. They cover primary and
related diagnostic positions, rule-qualified disable/enable boundaries,
disable-next behavior across LF and CRLF documents, and directive-looking
strings that must not suppress findings. The VS Code constructor stub supplies
the API boundary; the production functions themselves are not mocked.

Run the properties separately, or increase their generated cases:

```sh
npm run test:fuzz
ZEMDOMU_FUZZ_RUNS=1000 ZEMDOMU_FUZZ_SEED=12345 npm run test:fuzz
```

Each property defaults to 250 cases with the fixed seed 1592594996. Run counts
must be integers from 1 through 10000; seeds must be signed 32-bit integers.
To replay a shrunk counterexample, select the property printed before its
failure and copy fast-check's seed and path:

```sh
ZEMDOMU_FUZZ_PROPERTY=disable-next ZEMDOMU_FUZZ_SEED=12345 ZEMDOMU_FUZZ_PATH=0:0 npm run test:fuzz
```

Property names are diagnostic-ranges, block-directives, disable-next, and
literal-directives. Record a genuine counterexample as a focused regression test.

See the [user guide](docs/USER_GUIDE.md) for settings, supported VS Code versions,
privacy, and troubleshooting. Do not commit generated bundles, local workspace
files, or private fixtures.

## Open a pull request

Explain the user-visible problem, the resulting behavior, and how you checked
it. New functionality must include automated tests for its expected behavior
and important failure cases. Add a regression test for a behavior fix and update
user-facing guidance
when settings or diagnostics change. For documentation-only work, check links
and examples and say that code tests were not run. Record customer-relevant
changes under the appropriate category in the unreleased changelog.

Follow the surrounding TypeScript naming, formatting, and module conventions.
Keep type checking enabled with the repository's checked-in `tsconfig.json`.
Fix compiler errors and confirmed security-analysis findings before merging;
document the evidence for any finding dismissed as a false positive. Do not
disable checks or weaken configuration to make a pull request pass.

Accessibility rule changes should explain their detection limits and the
relevant standard or authoring policy. Source analysis cannot establish WCAG
conformance; avoid claims that a passing scan proves an accessible result.
