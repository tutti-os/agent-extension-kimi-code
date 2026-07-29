# Runtime verification

The managed extension contract is pinned to
`@moonshot-ai/kimi-code@0.28.0` and launches `kimi acp`. Local discovery checks
the shared runtime search environment plus the official installer directory
`~/.kimi-code/bin`. Compatibility is bounded to `>=0.28.0 <1.0.0`; discovery
must complete a standard ACP initialize probe within 15 seconds.

The verified `0.28.0` ACP handshake advertises image and embedded-context
prompt input, session resume/load, model and mode config options, and runtime
commands. Kimi also discovers directory-form Skills from the project
`.agents/skills` root during ACP session creation. The extension declares that
workspace root so Tutti can materialize its canonical Skills there; the native
command name is `/skill:<name>`. The repository check starts the pinned runtime,
creates a canonical `SKILL.md`, and requires `available_commands_update` to
contain `skill:tutti-canonical-test`.

Release `1.0.3` also declares the host-managed `browserUse` capability. Tutti
still gates the effective capability on its own browser availability and
injects the browser tools at launch; the Kimi ACP runtime does not need to
advertise a provider-native browser command.

The same release declares an authoritative slash-command projection containing
only `compact`, `status`, `usage`, `mcp`, `tasks`, and `help`. Tutti intersects
that list with live ACP commands, preserving runtime descriptions. Unlisted
runtime commands are projected through the typed Skill catalog with their exact
slash triggers, producing separate Command, Capability, and Skill groups in the
composer.

Release `1.0.3` requires Tutti `0.2.3-rc.14` or newer because older hosts do
not accept provider-native compound Skill trigger prefixes such as `/skill:`
or project host-managed extension capabilities into the composer. The workflow
default must not be lowered when publishing this package.
