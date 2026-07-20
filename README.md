# Kimi Code Agent Extension for Tutti

This repository connects the official Kimi CLI to Tutti through the standard
Agent Client Protocol (ACP). The signed package is declarative: it contains
metadata, profiles, localized copy, and passive images, but no executable
extension code.

## Runtime contract

- PyPI requirement: `kimi-cli==1.49.0`
- Discovery: `kimi --version`
- ACP launch: `kimi acp`
- Managed install: isolated `uv tool install` under the Target runtime root

Models and permission modes are projected from the live ACP session. The
signed profile maps `plan`, `default`, `auto`, and `yolo` to Tutti's semantic
permission tiers without embedding provider-specific daemon code.

## Validation

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:tutti-agent
```

Release publication uses Ed25519 signatures, immutable version objects, and
the shared Tutti Agent Extension CDN. The production private key is stored only
as the `TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY` repository secret.

Kimi CLI remains an upstream Moonshot AI project; this repository owns only
Tutti's declarative integration metadata and release pipeline.
