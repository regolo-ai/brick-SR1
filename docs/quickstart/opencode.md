# OpenCode with Brick

Brick exposes the reserved `opencode` profile as a local OpenAI-compatible
router. OpenCode talks to Brick, Brick decides the upstream model, and you keep
a single provider — `brick` — in the OpenCode model picker.

## One-command setup

Install the published Brick package, install OpenCode, then start the managed
profile:

```bash
npm install -g @regoloai/brick
brick start opencode
```

`brick start opencode` creates the `opencode` profile when it does not exist,
starts the local router, and wires the official OpenCode client to it. The CLI
writes the managed `provider.brick` block into the global
`~/.config/opencode/opencode.json`, pointing at
`http://127.0.0.1:<port>/v1`, and lists the whole Brick catalog plus the `brick`
router model. It also installs the Brick OpenCode V2 plugin under
`~/.config/opencode/plugins/brick/`. Open OpenCode, select `brick`, and every
turn is routed by Brick across the profile's active pool.

An existing `opencode` profile keeps its user-owned pool; `brick start opencode`
only rewires the client. Edit the pool with `brick profile edit opencode`.

## What Brick manages

- `provider.brick` in `~/.config/opencode/opencode.json`, fenced by a managed
  comment. The writer preserves JSONC comments and every unrelated key
  byte-for-byte. A second `brick start opencode` is a no-op; Brick refuses to
  overwrite a `provider.brick` it did not write.
- The V2 plugin at `~/.config/opencode/plugins/brick/index.js`, marked with a
  managed header. The plugin never registers a provider: at setup it reads the
  configured `brick` provider, fetches `<baseURL>/models`, and refreshes the
  model inventory. A stopped router only logs a warning and never blocks
  OpenCode startup.

## Stop and remove

```bash
brick stop opencode   # restore the original opencode.json and remove the plugin
brick clear opencode  # stop the runtime as well
```

`brick stop opencode` removes the managed block, restores the file to its
previous state exactly, and uninstalls the plugin. `brick status opencode`
reports whether the harness is attached; `brick status opencode --for-agent`
emits the schema v2.0 automation report.

## Requirements and limits

- OpenCode V2 (`Plugin.define`) is required.
- Brick runs locally on `127.0.0.1`; there is no authentication between OpenCode
  and Brick, and Brick owns the credentials for the upstream providers.
- The plugin is shipped inside the CLI and is not published to npm on its own.
