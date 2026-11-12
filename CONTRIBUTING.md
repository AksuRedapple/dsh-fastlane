# Contributing

## Development

Requirements: Node.js 20+.

```bash
npm install
npm test
```

For integration checks, run DSH and the proxy locally, then:

```bash
npm run verify
npm run bench
```

## Pull requests

- Keep changes focused and explain the user-visible failure mode.
- Add a regression test for cache, request, WebSocket, or authentication behavior.
- Record user-visible changes in `CHANGELOG.md`.
- Do not commit cookies, launch tokens, private hostnames, personal absolute paths, or local deployment configuration.
- Treat cache entries, compressed streams, and injected scripts as correctness-sensitive surfaces with rollback paths.
