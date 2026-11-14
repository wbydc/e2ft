# Contributing

Bug reports and pull requests are welcome. For a security problem, follow `SECURITY.md` instead of opening a public
issue.

## Before you open a pull request

Run the same gate that CI runs on every pull request. The toolchain is Rust 1.98.1 and Node.js 24.22.2, the versions
the `Dockerfile` builds with.

```bash
cd web && npm ci && npm run check
cargo test
cd web && npx playwright install chromium firefox && npm run e2e
```

`npm run check` covers types, formatting (`npm run fmt` fixes it), lint, the project style rules and the unit tests.
The e2e suite starts a release build of the server and runs two browsers against it. The README's Development
section lists the options for both.

CI also runs these. Run them locally when your change touches what they cover:

- The coturn-backed tests, when you change TURN or the relay path: `cd web && scripts/coturn.sh start`, then
  `E2E_TURN=1 npx playwright test tests/e2e/settings.spec.ts` and `npm run integration`, then
  `scripts/coturn.sh stop`. The script uses `turnserver` when it is installed and the coturn container image
  otherwise.
- Security scans: gitleaks over the history, semgrep with `p/default`, `p/typescript` and `p/rust`, `cargo audit`,
  and `npm audit` in `web/`. A false positive gets `// nosemgrep: <rule>` with the reason on the line above.

## Pull requests

- Keep one change per pull request, with a title that says what it changes for the user or the code.
- Follow the conventions in the code around your change. The style checks enforce most of them.
- Update `README.md` or `docs/` when your change makes them wrong, and add a line under `Unreleased` in
  `CHANGELOG.md` for anything a user would notice.
- The `check` workflow must pass and a maintainer must approve. Pull requests are squash-merged, so the title becomes
  the commit message.

By contributing you agree that your work is licensed under the AGPL-3.0, the project's license (`LICENSE`).
