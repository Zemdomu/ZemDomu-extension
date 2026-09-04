# Public Repository Policy

This repository is public. Assume every tracked file, commit, CI artifact, and
VSIX entry can be read by anyone.

Public Markdown is limited to `README.md`, `CHANGELOG.md`, this policy, and the
explicitly approved user, dependency, performance, and release documents in
`docs/`. Put local plans, agent context, investigation notes, security work,
and release coordination in `.internal/`; that directory is ignored and must
never be force-added.

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
