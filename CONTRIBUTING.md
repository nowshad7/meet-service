# Contributing

Thanks for helping make meet-service better.
Bug reports, documentation fixes, new tests and focused features are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Keep the core rule: no fork and no patches to the upstream Jitsi images.
  New behaviour is a Prosody plugin, a config fragment, a compose override or a script, switched on per deployment by a setting.
- Keep the service product-neutral.
  Anything specific to one app or company belongs in that deployment's folder, not in the shared code.
- Changes to the app contract follow [its versioning rules](contract/README.md#versioning): additions are fine, breaking changes need a new contract version.

## Development

Requirements: bash, Docker, Python 3 with `jsonschema` and `referencing`, and Node.js 22 or newer.
`luacheck`, `busted`, `shellcheck` and `node` are used from your `PATH` when present, otherwise from pinned Docker images.

```bash
pip install jsonschema referencing
tests/run.sh
```

`tests/run.sh` runs luacheck, the busted plugin tests, shellcheck, the finalize and `scripts/meet` tests, the reference app tests, the contract check and the Prosody config check.
CI runs the same script on every pull request.

For changes that touch Prosody, Jicofo or the compose files, also bring up the localhost example and run the live check:

```bash
scripts/meet init example && scripts/meet up example
tests/stack-check.sh example
```

## Pull requests

- One topic per pull request, with tests for new behaviour.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(control): ...`, `fix(scripts): ...`, `docs: ...`, `test: ...`, `chore: ...`.
  Release notes are generated from them, so there is no hand-edited changelog.
- Update the docs page of any feature you change, and the contract schemas and examples together with the contract README.
- In Markdown, put each sentence on its own line.

## Code style

- Shell: `set -euo pipefail`, small functions, clean under shellcheck.
- Lua: Prosody module conventions, clean under `tests/.luacheckrc`.
- Prefer clear names and small functions over comments.

By contributing you agree that your contributions are licensed under the [Apache-2.0 license](LICENSE).
