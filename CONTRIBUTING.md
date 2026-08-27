# Contributing to Fluent

Thanks for helping improve Fluent. Small, focused pull requests with clear
tests are easiest to review.

## Set up a development environment

Fluent requires Node.js 24.

```bash
nvm use
npm ci
cp .env.example .env
npm run dev
```

Use development credentials and synthetic session data. The server can start
without a Gemini key, but live translation requires one. Never use production
keys, databases, uploaded decks, transcripts, or attendee data in development
or test fixtures.

The Vite client runs on `http://localhost:5175` and proxies requests to the
server on port `3010`.

## Before changing code

- Search existing issues and pull requests before opening a duplicate.
- For large features or protocol changes, open a design issue first.
- Keep Gemini integration isolated in `server/src/gemini-bridge.ts`.
- Add WebSocket message types to `server/src/types.ts` before implementing
  server and client behavior.
- Treat viewer input as untrusted: validate, rate-limit, and reject by default.
- Preserve the single-instance runtime unless the change includes a complete
  distributed-state design.

## Make a pull request

1. Branch from the current default branch.
2. Keep the change focused and avoid unrelated formatting.
3. Add or update tests for behavior changes.
4. Update `.env.example` and public documentation for configuration changes.
5. Use a descriptive commit message; conventional prefixes such as `feat:`,
   `fix:`, `docs:`, and `test:` are welcome.
6. Explain user-visible behavior, risk, and verification in the pull request.

Do not commit generated builds, local databases, uploads, `.env` files, audio
captures, private evaluation corpora, or provider credentials. See
[Public release and data handling](docs/public-release.md) for the full list.

## Test changes

Run the smallest relevant checks while developing:

```bash
npm run typecheck
npm run build
```

Before requesting review, run the complete suite:

```bash
npx playwright install chromium
npm run verify
```

`npm run verify` performs type checks, a production build, preflight checks,
dependency audit, server smoke tests, and browser smoke tests. If an environment
prevents part of the suite from running, state exactly what was and was not run
in the pull request.

Changes involving microphones, mobile playback, audio routing, or Cloudflare
Realtime also need a real-device check. Automated tests do not replace a short
host-to-viewer audio test.

## Report security issues privately

Do not open a public issue for a suspected vulnerability. Follow
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the MIT
License included in this repository.
