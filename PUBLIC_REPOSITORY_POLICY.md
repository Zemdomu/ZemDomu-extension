# Public Repository Policy

This repository is public. Assume every tracked file, commit, CI artifact, and
VSIX entry can be read by anyone.

Public Markdown is limited to `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`,
`CODE_OF_CONDUCT.md`, `SECURITY.md`, this policy,
`.github/PULL_REQUEST_TEMPLATE.md`, and the explicitly approved user,
dependency, performance, and release documents in `docs/`. Contributor issue
forms and routing configuration belong in `.github/ISSUE_TEMPLATE/`.

Put local plans, agent context, investigation notes, security work,
and release coordination in `.internal/`; that directory is ignored and must
never be force-added.

Public CI and OpenSSF Scorecard workflows live in `.github/workflows/`; their
jobs run only in this public product repository. CodeQL uses GitHub-managed
default setup. `.github/dependabot.yml` tracks npm and workflow dependencies.
Keep workflow actions pinned to full commit SHAs and grant write permissions
only to the jobs that need them.

The manual public artifact builder records reviewed source/version/channel and
attests the exact inspected VSIX. It never publishes to Marketplace, creates
release tags, or accepts publishing credentials. Public build artifacts contain
only the VSIX, its public candidate metadata, the original provenance bundle, and
its unchanged DSSE envelope. They do not upgrade historical download signatures
to build provenance or authorize replacement of an existing version.

Never store credentials, tokens, private keys, customer data, private URLs, or
real environment values in this repository. From the canonical ZemDomu
monorepo root, run:

```sh
node scripts/check-public-repo-safety.mjs --package extension
```

If sensitive information is committed, stop publication, revoke or rotate the
affected credential, report the exposure privately, and assess Git history.
Removing the current file does not remove earlier commits; do not rewrite
shared history without an explicit coordinated decision.
