# Changelog

All notable public changes are documented here. The format follows Keep a Changelog and semantic versioning.

## [Unreleased]

No unreleased changes yet.

## [0.1.0] - 2026-11-13

- Initial public release.
- Immutable content-hash asset cache with ETag, LRU, and Brotli variants.
- Server-side DSH launch-token/cookie hand-off.
- Read-only RPC caching with explicit invalidation and rollback.
- Optional WebSocket compression with confirmation-driven serial queue and bounded backpressure.
- Narrow-screen DOM adjustment and diagnostic status endpoint.
- Packaged tests for proxy, cache, WebSocket, and slow-client behavior.
- Test discovery works consistently across the Node 20 and Node 22 CI jobs.
