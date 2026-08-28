# Performance Baseline

This baseline records the reproducible version 1 scale check. Run it with:

```sh
npm run benchmark:workspace
```

The benchmark creates a temporary, evenly mixed HTML, JSX, TSX, and Vue
workspace. Each of its 1,000 standalone files contains valid headings,
landmarks, and named images. It runs the production ZemDomu `ProjectLinter`
with cross-component analysis enabled, reports five scan durations, samples
resident memory, enforces the launch thresholds, and removes the fixture.

## 2026-08-28 reference run

- Hardware: Intel Core i7-11700KF, 8 cores / 16 logical processors, 32 GiB RAM
- Operating system: Windows 11 Home 10.0.26200, x64
- VS Code reference host: 1.135.0
- Node.js: 24.15.0
- Extension: 0.0.17 unreleased launch candidate
- Fixture: 1,000 files, 250 each of HTML, JSX, TSX, and Vue
- Runs: 5
- Scan durations: 2102.42 ms, 1872.54 ms, 2372.54 ms, 2121.69 ms, and 1751.27 ms
- Scan p95: 2372.54 ms — passes the under-10-second gate
- Findings: 0 in every run, as expected for the valid fixture
- Peak RSS: 317.39 MiB — fails the under-250-MiB gate

The workspace timing gate is satisfied on this reference machine. The memory
gate remains a version 1 blocker; this result does not measure or satisfy the
separate requirement for less than 20% growth after 100 repeated scans.
