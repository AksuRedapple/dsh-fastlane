# Security Policy

## Reporting

Please use GitHub private vulnerability reporting for this repository. Do not open a public issue containing credentials, private tokens, session cookies, internal hostnames, or exploitable details.

## Security boundaries

- `dsh-fastlane` is not an authentication service. Bind it to loopback and place a trusted authenticated entry layer in front of it.
- The cached DSH cookie grants access to the upstream web application. Keep the state file private and do not copy it between machines.
- WebSocket compression and DOM injection operate on live client traffic. Changes must preserve byte delivery, bounded memory, and a documented rollback path.
- Cacheable RPC methods must remain read-only. Any method capable of changing state must invalidate cached read results before forwarding.

## Supported versions

Security fixes are applied to the latest published minor line.
