# Paired Extension Host memory experiment

This is diagnostic maintainer tooling. It does not replace or relax the normal
release suite, its reviewed hosted RSS caps, activation/typing/save limits, or
20% save-loop growth limit. A diagnostic run can exceed the release memory cap
without failing for memory; release eligibility still uses the normal release
gates documented in [Performance Baseline](../../docs/PERFORMANCE_BASELINE.md).

Build the normal bundle, then run from a **clean committed checkout**:

```sh
npm ci
npm run package
VSCODE_TEST_VERSION=1.144.0 ZEMDOMU_BASELINE_RESULTS_DIR=.agent/baseline-results node tests/extension-host/baseline-runner.js
node --test tests/extension-host/baseline-contract.test.js
```

Use the manual baseline workflow for Linux/Windows and both exact versions
`1.105.0` and `1.144.0`. Moving `stable` is deliberately rejected. The output
directory must be empty: previous samples cannot be overwritten or selected.

Each matrix cell downloads/resolves one exact binary and executes all five pairs
in the predetermined order C/T, T/C, C/T, T/C, C/T. There is no retry or pair-count
switch. Each launch receives a fresh profile/extensions directory and a copy of
the original release runner's 100-file workspace. Only the original fixture
declarations are evaluated, after a fixed hash check (source CRLF is normalized
to LF for Windows checkout parity; fixture values remain unchanged); the release runner and
release suite remain unchanged. Filename/content/settings hashes are recorded
and checked for every launch.

Control uses an inert development manifest under another ID, with the product's
identical static configuration schemas and no product main, commands, dependency
or activation code. Treatment registers and explicitly activates the expected
ZemDomu ID. Both use the same test suite/imports, instrumented stages, flags,
configuration changes, text changes and saves. The product manifest is read in
both; Core and the product runtime are never directly imported by the suite.

Every sample records product registration, `isActive`, exact bundle-module cache
presence before explicit activation, after activation and at the end. Control
must have no product ID, bundle/source/output modules or standalone Core modules.
Treatment must load the expected product bundle from the expected checkout.
Core is bundled into that product file, so bundle absence is also relevant to
inlined Core. These are module-cache/registration checks, not an OS file-access
trace. `isActive: false` alone is not proof of an unloaded or never-started module;
prestate is retained without assuming cold activation. Built-in active extension
IDs and paths are captured before and after settling at every phase.

Common stages include opening/enumerating the workspace; initial/severity/rule
disable/rule restore stage slots; a common text repair/save and restoration;
20 alternating valid/invalid typing changes with a 200 ms delay; and 100
alternating saves with a 50 ms delay. Each phase, including the final phase, has
at least 1000 ms of quiet settling after its work. The same configuration schemas
avoid introducing unknown-setting warnings only in control. Only treatment
activates, performs workspace scans and validates missing-alt diagnostics.
The repair uses the same direct editor edit in both conditions rather than a
treatment-only quick-fix provider. The normal release suite still tests actual
quick fixes. Product operations and diagnostic waits can extend treatment wall
time; phase and operation timings expose this unavoidable asymmetry. The fixed
cadence is a delay after each common edit/save, not a guaranteed real-time
deadline; any extra diagnostic wait after it is reported.

RSS belongs to the test's entire Node/Electron Extension Host process, including
the host, native allocations, loaded built-ins and suite instrumentation. It does
not sum separate VS Code renderer/main/language-server processes and is not a
live-object accounting of ZemDomu. Full-window sampling starts at suite entry
after the shared suite imports/report setup; it ends after final proof and quiet
settling, before JSON serialization. Startup before entry is unmeasured. A 5 ms
same-thread timer plus explicit milestones can miss synchronous transient peaks;
this is a sampled maximum, not an OS high-water claim. Every milestone updates
the full maximum. The save-window maximum is reported separately and includes
its final settling/milestones. No forced GC or heap flags are used.

`experiment.json` is updated before/after every launch and contains the exact
plan, git HEAD/tree/clean status, source/bundle/binary hashes, runner metadata,
fixture identity and every sample status/report. Each sample directory retains
`input.json`, `report.json`, incremental `milestones.jsonl`, `stdout.log` and
`stderr.log`; early launch failures may have no host report but remain failed in
the manifest. Profiles/workspaces are disposable, while failure evidence stays
in the output directory. All ten launches are attempted once even if one fails.
Missing/failed/mismatched samples make the experiment fail; a subset never
produces a passing summary. Setup failures also retain their manifest.

On complete success `summary.json` contains all five signed treatment-minus-
control paired full-window/save-window deltas, raw per-pair peaks and descriptive
min/median/max/range distributions. The small-N descriptive p95 is normally the
maximum of five observations and is not a precise tail estimate. Subtraction
estimates matched process-workload differences, not exact extension ownership.
Compare each OS/runtime cell separately; a Mac control cannot define CI limits.

Budget review requires a human decision after examining every paired result,
raw absolute RSS, background-extension differences, runtime/runner changes and
headroom. This tooling computes no replacement threshold, adjusts no budget,
and cannot make a failing normal release memory gate pass.
