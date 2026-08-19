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

- npm package: `@moonshot-ai/kimi-code@0.34.0`
- Local discovery minimum: `>=0.34.0 <1.0.0`; older compatible-looking
  installations are upgraded into Tutti's isolated Target runtime before use
- Discovery: `kimi --version`
- Official installer location: `~/.kimi-code/bin`
- ACP launch: `kimi acp`
- Managed install: isolated `npm install --prefix` under the Target runtime root

Models and permission modes are projected from the live ACP session. The
signed profile maps `plan`, `default`, `auto`, and `yolo` to Tutti's semantic
permission tiers without embedding provider-specific daemon code.

The signed authentication profile presents Kimi's runtime-advertised `login`
method as `Set up Kimi`. Tutti opens the interactive Kimi Code TUI and submits
`/login` only after the runtime's welcome screen is ready, so users can choose
Kimi Code OAuth or a Kimi Platform API key inside the CLI. Tutti never receives
or stores credentials; Kimi Code owns login and provider configuration.

Releases carrying the account-usage profile publish mutable metadata under
`agents/kimi-code/account-usage-v1/`. The prior `authentication-v1` index and
the original `agents/kimi-code/versions.json` index remain unchanged for older
Tutti builds whose strict manifest decoders do not recognize the new profile
reference. A compatible Tutti release selects the new path first and may keep
those two prior indexes as ordered unavailable-path fallbacks. Publish that
Tutti release before publishing the first account-usage-v1 extension, then
remove the fallbacks after the new metadata path has propagated. A fetched but
invalid, incompatible, or withdrawn higher-priority index must never fall back
to either older path.

The extension declares Tutti's host-managed browser capability. When the host
enables browser use, Kimi Code receives the same `/browser` composer capability
and settings entry as built-in agents.

The composer profile keeps the slash palette focused on Kimi's six core
session commands (`compact`, `status`, `usage`, `mcp`, `tasks`, and `help`).
Other runtime-advertised entries are projected as Skills with their exact slash
triggers instead of crowding the command group. Tutti therefore presents three
distinct groups: Commands, Capabilities (including Browser), and Skills.
`/status` opens Tutti's provider-neutral status panel, while `/usage` is
submitted to the Kimi ACP runtime. Kimi Code remains the owner of login and
provider configuration. Because the pinned 0.34.0 ACP runtime does not publish
structured Coding Plan account windows, this repository publishes the separate
`@tutti-os/kimi-code-account-usage-probe` helper. The signed declarative profile
pins that companion package and its Node script; tuttid installs it into an
independent Target-scoped companion runtime, verifies the fixed Node interpreter
and script bytes separately, and consumes only the versioned provider-neutral
JSON result. The npm package builds the Helper as one self-contained CommonJS
script so tuttid can execute verified bytes without platform-specific npm shims,
mutable sibling modules, or runtime dependencies.

The helper owns Kimi TOML selection, OAuth credential storage, the trusted
`https://auth.kimi.com` issuer to `https://api.kimi.com/coding/v1` usage-origin
binding, `/usages`, response parsing, and the one-time changed-token retry after
401/403. Non-HTTPS or non-Kimi origins fail before credentials are read or sent.
Unknown successful payloads return `parse_failed`; results contain stable error
codes, quota percentages, and numeric reset times only. Tokens, file paths,
configured endpoints, raw bodies, and provider error text never enter the
result, renderer, or host logs. API-key providers return an explicit `api`
billing result with no quota rows. The signed Extension artifact itself remains
fully declarative and contains no Helper code.

## Validation

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:tutti-agent
```

For a local Tutti `make dev-gui` run, set
`DEV_GUI_KIMI_CODE_PACKAGE_DIR` to this repository's unpacked Extension package.
The standard repository layout lets the script discover the unpublished local
account-usage Helper's generated `dist/cli.cjs` automatically after `pnpm
check`; use
`DEV_GUI_KIMI_CODE_ACCOUNT_USAGE_EXECUTABLE` only for a nonstandard layout.
Production never uses this development override.

Release the two artifacts in dependency order: first publish the Helper with
`Publish Kimi Account Usage Probe`, then publish the Extension version that pins
it. Publish a compatible Tutti version before exposing the
`account-usage-v1` Extension index; older Tutti or older Extension versions must
report the capability as unsupported instead of guessing or downloading a
Helper during a status request.

Release publication uses Ed25519 signatures, immutable version objects, and
the shared Tutti Agent Extension CDN. The production private key is stored only
as the `TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY` repository secret.

Kimi Code CLI remains an upstream Moonshot AI project. This repository owns the
declarative Tutti integration, the provider-specific account-usage Helper, and
their independent release pipelines; it does not modify the CLI.
