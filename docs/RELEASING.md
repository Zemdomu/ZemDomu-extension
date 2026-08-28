# ZemDomu VS Code Extension Release Runbook

## Release checks

1. Release ZemDomu Core first when the extension needs a new Core version.
2. Update `package.json` and `package-lock.json` to the intended extension
   version and add the customer-facing changes to `CHANGELOG.md`.
3. From `packages/ZemDomu-Extension`, run `npm run release`.
4. Confirm the command reports zero audit findings, passes the full test suite,
   keeps the bundle below 5 MiB, keeps the VSIX below 2 MiB, inspects the
   archive contents, installs the VSIX in a clean profile, and activates that
   installed artifact in a real VS Code Extension Host.
5. Create and push the tag `v<package-version>`. The publish workflow rejects
   any tag that does not exactly match `package.json`.
6. Confirm the publish workflow uploads `dist/zemdomu.vsix`, then install the
   Marketplace build in a clean profile for the final release smoke check.

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
