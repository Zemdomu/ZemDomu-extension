# ZemDomu VS Code Extension Release Runbook

## Open VSX distribution

Distribute the same inspected `zemdomu.vsix` bytes already attached to the
matching GitHub release. Do not rebuild, bump a version, or promote a
Marketplace pre-release while adding another registry. Version 0.1.3 remains
a pre-release. Keep the publisher namespace exactly `ZachariasErydBerlin`.

For the first upload, sign in at [Open VSX](https://open-vsx.org/publish), link
the maintainer's Eclipse account, and review its Publisher Agreement. Create
the matching namespace and upload the existing release VSIX. Check its name,
version and pre-release status before confirming publication, then verify the
listing and downloaded SHA-256 against the GitHub asset. No access token is
needed for this browser upload.

For subsequent releases, the manual **Distribute reviewed Extension to Open
VSX** workflow verifies the selected release, reviewed SHA-256, channel,
runtime-only archive and matching manifest/package identities. It defaults
to a dry run and retains the verified artifact for inspection. Publication
uses those identical bytes, never executes their runtime, and never changes
the Marketplace release.

Before enabling a non-dry run, claim namespace ownership through Open VSX and
register a [trusted publisher](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing)
for `Zemdomu/ZemDomu-extension`, workflow `publish-open-vsx.yml`, environment
`open-vsx`, extension `zemdomu`. A namespace contributor alone cannot register
this policy. The first active version must exist before registration. Keep
the environment and workflow names exact. Configure the GitHub environment's
deployment-branch policy to allow only `main`, with the intended review rules:
Open VSX registrations themselves accept any ref running the registered
workflow filename. An editable workflow `if` guard alone is not this external
branch restriction. The workflow uses a short-lived OIDC publishing
token and does not require an `OVSX_PAT` repository secret. A successful dry
run does not establish that this external registration is complete.

Verify the registry's returned version and channel after every upload. An
already existing version is a review stop, not a reason to suppress errors
or replace its bytes. Do not silently delete or unpublish an existing version.

## Release checks

The pre-publish gate runs the real Extension Host suite on Windows and Linux
against both VS Code 1.105.0, the oldest supported release, and the current
stable release. macOS is explicitly deferred for the 1.0 release because the
extension has no platform-native runtime dependency and the two operating
systems cover both supported CI shell families. Add macOS before release if a
platform-specific dependency or defect is discovered.

1. Release ZemDomu Core first when the extension needs a new Core version.
2. Add the customer-facing changes to `CHANGELOG.md`. The shared workflow
   updates `package.json`, `package-lock.json`, and the versioned changelog
   section; do not create those release changes by hand.
3. From `packages/ZemDomu-Extension`, run `npm run release` as a local gate.
4. Confirm the command reports zero audit findings, passes the full test suite,
   keeps the bundle below 5 MiB, keeps the VSIX below 2 MiB, inspects the
   archive contents, installs the VSIX in a clean profile, and activates that
   installed artifact in a real VS Code Extension Host.
5. Start the package-specific publish workflow from `main`. Do not create or
   push a release tag by hand.
6. Confirm the publish workflow uploads `dist/zemdomu.vsix`, then install the
   Marketplace build in a clean profile for the final release smoke check.

## Marketplace pre-release

Use an opt-in Marketplace pre-release when the candidate needs real-user beta
coverage before stable promotion:

1. Keep the owner's stable-release validation review separate from this
   pre-release publication.
2. Run **Publish VS Code Extension** from `main` with `bump: patch` and
   `channel: pre-release`. The first `0.1.0` attempt reserved an internal tag
   but failed before Marketplace publication because its VSIX lacked
   pre-release metadata; the forward fix therefore publishes `0.1.1`.
3. Confirm the Marketplace offers **Install Pre-Release Version** and the public
   GitHub release is marked Pre-release, not Latest.
4. Collect sanitized tester feedback using
   [RELEASE_CANDIDATE_BETA.md](RELEASE_CANDIDATE_BETA.md).
5. Promote only after the owner completes product validation. Marketplace
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
