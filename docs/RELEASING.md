# ZemDomu VS Code Extension Release Runbook

## Release checks

The pre-publish gate runs the real Extension Host suite on Windows and Linux
against both VS Code 1.105.0, the oldest supported release, and the current
stable release. macOS is explicitly deferred for the 1.0 release because the
extension has no platform-native runtime dependency and the two operating
systems cover both supported CI shell families. Add macOS before release if a
platform-specific dependency or defect is discovered.

1. Release ZemDomu Core first when the extension needs a new Core version.
2. Update `package.json` and `package-lock.json` to the intended extension
   version and add the customer-facing changes to `CHANGELOG.md`.
3. From `packages/ZemDomu-Extension`, run `npm run release`.
4. Confirm the command reports zero audit findings, passes the full test suite,
   keeps the bundle below 5 MiB, keeps the VSIX below 2 MiB, inspects the
   archive contents, installs the VSIX in a clean profile, and activates that
   installed artifact in a real VS Code Extension Host.
5. Create and push the tag `v<package-version>`. The publish workflow reruns
   the Windows/Linux and oldest/stable Extension Host matrix, and rejects any
   tag that does not exactly match `package.json`.
6. Confirm the publish workflow uploads `dist/zemdomu.vsix`, then install the
   Marketplace build in a clean profile for the final release smoke check.

## Marketplace pre-release

Use an opt-in Marketplace pre-release when the candidate needs real-user beta
coverage before stable promotion:

1. Keep the stable release gate and acceptance criteria unchanged.
2. Run **Publish VS Code Extension** from `main` with `bump: minor` and
   `channel: pre-release`. From `0.0.18`, this creates `0.1.0`.
3. Confirm the Marketplace offers **Install Pre-Release Version** and the public
   GitHub release is marked Pre-release, not Latest.
4. Collect the anonymized beta results described in
   [RELEASE_CANDIDATE_BETA.md](RELEASE_CANDIDATE_BETA.md).
5. Promote only after the beta and remaining launch gates pass. Marketplace
   pre-release and stable versions must use distinct `major.minor.patch`
   numbers; do not use SemVer suffixes such as `-rc.1`.

## Failed release before Marketplace publication

- Keep the failed tag as evidence while diagnosing the failure.
- Fix the cause on a new commit and rerun `npm run release`.
- If the tag was never published or consumed, replace it only after confirming
  the Marketplace has no version for it. Otherwise, increment the patch
  version and publish a new tag.

## Fault discovered after publication

1. Stop promotion and document the user impact.
2. Revert or fix the faulty change on a new commit without rewriting the
   published tag.
3. Increment the patch version, update `CHANGELOG.md`, run `npm run release`,
   and publish the new `v<package-version>` tag.
4. Verify the patch from the Marketplace in a clean profile.
5. For a severe security or data-loss issue, temporarily unpublish through the
   Marketplace publisher portal while preparing the patch. Do not remove the
   extension: removal is irreversible and permanently reserves its name.

Marketplace version deletion is irreversible, deleted version numbers cannot
be reused, and the latest version cannot be deleted. Prefer a forward patch
release except when temporarily unpublishing is necessary to protect users.
See the official [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
