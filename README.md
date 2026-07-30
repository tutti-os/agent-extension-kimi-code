# Kimi Code Agent Extension for Tutti

This repository connects the official Kimi CLI to Tutti through the standard
Agent Client Protocol (ACP). The signed package is declarative: it contains
metadata, profiles, localized copy, and passive images, but no executable
extension code.

The contract follows the official
[Kimi Code CLI getting-started guide](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html)
and the upstream
[`MoonshotAI/kimi-code`](https://github.com/MoonshotAI/kimi-code) repository.

## Runtime contract

- npm package: `@moonshot-ai/kimi-code@0.28.0`
- Discovery: `kimi --version`
- Official installer location: `~/.kimi-code/bin`
- ACP launch: `kimi acp`
- Managed install: isolated `npm install --prefix` under the Target runtime root

Models and permission modes are projected from the live ACP session. The
signed profile maps `plan`, `default`, `auto`, and `yolo` to Tutti's semantic
permission tiers without embedding provider-specific daemon code.

The signed authentication profile binds Kimi's runtime-advertised `login`
method to the local `kimi login` subcommand. Tutti supplies only the generic
terminal launcher; the provider-specific login command remains declarative in
this extension package.

Releases carrying the authentication profile publish mutable metadata under
`agents/kimi-code/authentication-v1/`. The original
`agents/kimi-code/versions.json` index remains unchanged for older Tutti builds
whose strict manifest decoder does not recognize the authentication profile
reference. Point Tutti at the new index only after the first compatible Tutti
version has been released.

The extension declares Tutti's host-managed browser capability. When the host
enables browser use, Kimi Code receives the same `/browser` composer capability
and settings entry as built-in agents.

The composer profile keeps the slash palette focused on Kimi's six core
session commands (`compact`, `status`, `usage`, `mcp`, `tasks`, and `help`).
Other runtime-advertised entries are projected as Skills with their exact slash
triggers instead of crowding the command group. Tutti therefore presents three
distinct groups: Commands, Capabilities (including Browser), and Skills.

## Validation

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:tutti-agent
```

Release publication uses Ed25519 signatures, immutable version objects, and
the shared Tutti Agent Extension CDN. The production private key is stored only
as the `TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY` repository secret.

Kimi Code CLI remains an upstream Moonshot AI project; this repository owns only
Tutti's declarative integration metadata and release pipeline.
