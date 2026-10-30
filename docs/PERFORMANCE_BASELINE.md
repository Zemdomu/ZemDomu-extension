# Performance Baseline

The release performance gate runs inside real VS Code Extension Hosts:

```sh
npm run bundle
npm run test:extension-host
```

The runner creates a temporary 100-file workspace evenly mixed across HTML,
JSX, TSX, and Vue. It removes the fixture after the run and records the
hardware, operating system, Node.js, VS Code, extension version, fixture, and
sample counts with the measured results.

## Release budgets and methodology

- Cold activation: five fresh-host cache warm-ups followed by 20 measured
  fresh Extension Hosts; p95 must be below 500 ms.
- On-type: 20 diagnostic transitions in the real host; p95 includes the
  150-ms debounce and must be below 500 ms.
- On-save: 100 diagnostic transitions while the 100-file workspace is open;
  p95 must be below 1 second.
- Memory: RSS is sampled throughout the same 100 on-save scans. Peak RSS must
  stay below 250 MiB and final growth from the pre-scan baseline must stay
  below 20%.

Each measured interaction alternates one document between a valid named image
and a missing-alt state. The test waits for the corresponding Problems
diagnostic transition, so it measures completed user-visible work rather than
only dispatch time. The five activation warm-ups stabilize operating-system
and VS Code file caches; every measured activation still uses a new Extension
Host process.

The GitHub Actions Extension Host matrix runs this gate on Ubuntu and Windows
against both VS Code 1.105.0 and the current stable version. Shared hosted
runners use activation regression ceilings of 1.2 seconds on Linux and 1.8
seconds on Windows and a 750-ms on-type ceiling on Windows because hosted CPU
performance differs from the reference machine. Hosted save-window RSS must
stay below 275 MiB, with a reviewed 300-MiB allowance only for actual VS Code
1.144.0. The minimum version and unreviewed runtime versions retain 275 MiB;
the moving `stable` label alone cannot select the allowance. Linux on-type
plus all on-save and growth budgets are unchanged. Any exceeded ceiling fails
that matrix cell; the stricter
500-ms and 250-MiB release budgets remain enforced everywhere else.

## 2026-10-30 hosted memory review

The owner approved the version-specific allowance after the
[paired baseline experiment](https://github.com/Zemdomu/ZemDomu-extension/actions/runs/41072128378)
completed all 40 predetermined launches (five alternating inert-control/product
pairs per Ubuntu/Windows and VS Code 1.105.0/1.144.0 cell). Original fixtures and
the normal release workload were preserved. Save-window measurements in MiB:

| OS | VS Code | Control median | Product median | Product maximum |
| --- | --- | ---: | ---: | ---: |
| Ubuntu | 1.105.0 | 184.18 | 232.55 | 234.97 |
| Ubuntu | 1.144.0 | 234.94 | 275.40 | 276.61 |
| Windows | 1.105.0 | 176.01 | 225.99 | 231.01 |
| Windows | 1.144.0 | 231.02 | 274.61 | 277.35 |

The stable allowance leaves 22.65 MiB above this batch's largest save-window
observation. It is an explicit engineering budget, not an automatic adjustment
or a statistical tail bound. Future runtime versions require their own review.
Latency, 20% save-loop growth, activation and functional assertions stay intact.
Every release still requires the normal exact-source four-cell host workflow.

RSS measures the whole test Extension Host process. Matched differences include
product work, built-ins and allocation timing; they are not exact product memory
ownership. Cross-version jobs also used different hosted CPUs, and five pairs
per cell do not establish production tail behavior or prove no regression from
an older product release. Full measured lifecycle peaks were recorded separately
(maximum 290.76 MiB); the save-window ceiling does not enforce a full-lifecycle
ceiling. Diagnostic sampling starts at suite entry, misses earlier bootstrap
and can miss synchronous transients. No retries or selected subsets were used.

## 2026-09-01 Windows reference

- Hardware: Intel Core i7-11700KF, 8 cores / 16 logical processors, 32 GiB RAM
- Operating system: Windows 11 Home 10.0.26200, x64
- Extension: 0.0.17 unreleased launch candidate
- Fixture: 100 files across HTML, JSX, TSX, and Vue
- VS Code 1.105.0 / Node.js 22.19.0:
  - cold activation p95: 329.63 ms
  - on-type p95: 227.30 ms
  - on-save p95: 60.47 ms
  - peak RSS: 238.78 MiB
  - RSS growth after 100 scans: 1%
- VS Code 1.135.0 / Node.js 24.18.1:
  - cold activation p95: 422.53 ms
  - on-type p95: 222.61 ms
  - on-save p95: 60.59 ms
  - peak RSS: 238.36 MiB
  - RSS growth after 100 scans: 0%

The separate `npm run benchmark:workspace` command remains a manual 1,000-file
Core scale probe. It measures a full project scan rather than interactive
Extension behavior and is not a substitute for this release gate.
