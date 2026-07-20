# Runtime verification

The managed extension contract is pinned to
`@moonshot-ai/kimi-code@0.28.0` and launches `kimi acp`. Local discovery checks
the shared runtime search environment plus the official installer directory
`~/.kimi-code/bin`. Compatibility is bounded to `>=0.28.0 <1.0.0`; discovery
must complete a standard ACP initialize probe within 15 seconds.

The verified `0.28.0` ACP handshake advertises image and embedded-context
prompt input, session resume/load, model and mode config options, and runtime
commands. The extension keeps Skill roots undeclared because the runtime's
user-local Skill inventory is not extension-owned metadata.

Release `1.0.1` requires Tutti `0.2.2-rc.7` or newer because older hosts
strictly reject the new signed discovery field instead of ignoring it. The
workflow default must not be lowered when publishing this package.
