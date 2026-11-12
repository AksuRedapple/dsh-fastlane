# dsh-fastlane

**A small, non-invasive reverse proxy that makes the DeepSeek Harness web UI usable on slow or high-latency links.**

It sits between the browser and DSH and changes no application semantics. The proxy adds HTTP caching, Brotli variants, read-only RPC caching, optional WebSocket compression, a mobile-width injection, and observable statistics.

[中文说明](README.zh-CN.md) · [五篇联合连载](https://ouya15.cn/insights/series/dsh-fastlane.html) · [Design notes](designs/) · [Changelog](CHANGELOG.md)

## The problem

When DSH is reached through a long path such as:

```text
phone → Cloudflare edge → tunnel → home Mac → DSH web app
```

two defaults make every reopen expensive:

1. Content-hashed static assets have no `cache-control`, `etag`, or `last-modified`; the browser downloads the same first-screen bundle again.
2. The web client repeatedly asks small RPC endpoints. A measured session produced hundreds of requests, so request count mattered more than response size.

On the tested path, a 601-byte 401 page still took 1.6–7.0 seconds. The route was the dominant problem; the proxy reduces what each trip carries and how many trips are needed.

## What it does

```text
browser → HTTPS entry / tunnel
            ↓
        dsh-fastlane :8781
            ├─ reuses the DSH launch cookie server-side
            ├─ immutable + ETag + LRU cache for /assets/*
            ├─ Brotli variants for large HTML/JSON responses
            ├─ short-lived cache for an explicit read-only RPC allowlist
            ├─ optional per-message WebSocket compression
            └─ /__proxy/status for cache, compression, cookie, and WS diagnostics
        ↓
      DSH :8780
```

The proxy does **not** replace the authentication boundary. Bind it to loopback and put a trusted authenticated entry point in front of it.

## Measured results

These are local and real-device measurements from 2026-10-28/29, not universal benchmarks:

| Case | Before | After |
|---|---:|---:|
| First-screen assets | 544 KB gzip | **399 KB Brotli** |
| Reopen first-screen assets | 544 KB | **0 bytes** via immutable cache |
| Revalidation | 544 KB | **304 / 0 bytes** |
| `session/list` | 73 KB gzip | **52 KB Brotli** |
| Read-only RPC, same request ×20 | 20 upstream calls / 485 ms | **1 upstream call / 181 ms** |
| WebSocket replay, medium session | 1000 KB payload | **211 KB on wire** |
| WebSocket replay, long session | 11328 KB payload | **1809 KB on wire** |

The proxy does **not** remove geographic RTT. If direct networking is available, a tailnet or VPN is still faster than optimizing bytes through a cross-ocean tunnel.

## Quick start

Requirements: Node.js 20+ and a running DSH web endpoint.

```bash
npm install
npm test

# The DSH launch log contains the token the proxy exchanges for a cookie.
dsh web

# Start the proxy
node src/dsh-web-proxy.mjs

# Optional: expose it only to your private tailnet
tailscale serve --bg --https=10001 http://127.0.0.1:8781
```

Open `http://127.0.0.1:8781/`, or the private HTTPS URL created by your entry layer.

See `node src/dsh-web-proxy.mjs --help` for all environment variables and switches.

## Safety model

- The proxy listens on loopback by default.
- Authentication belongs to the entry layer, not this proxy.
- The DSH cookie is stored locally with mode `0600`.
- RPC caching is restricted to an explicit read-only allowlist and is invalidated before write-like methods.
- WebSocket compression uses a send-callback serial queue. The callback means the local send layer accepted a frame, not that the remote application consumed it. If the bounded application queue is exceeded, the connection closes with `1011` instead of silently stalling or growing without limit.
- Features have environment-variable rollback switches.

## Validation

```bash
npm test
npm run verify   # requires a running proxy
npm run bench    # requires a running proxy
```

The packaged test suite covers asset cache policy, compression negotiation, token/cookie exchange, RPC cache invalidation, WebSocket upgrade failures, compressed WebSocket delivery, and slow-client backpressure behavior.

## Scope and limitations

- The project targets the DSH web client observed on 2026-10-28/29. Private RPC contracts may change upstream.
- It does not implement authentication, end-to-end encryption, P2P routing, or a second UI.
- The DOM injection for narrow screens is best-effort; upstream markup changes may disable it without affecting proxy functionality.
- The current test suite is macOS-oriented where the default DSH log path is concerned.
- Cache correctness depends on the read-only RPC allowlist and invalidation rules staying accurate.

## License

MIT. See [LICENSE](LICENSE).
