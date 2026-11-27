# OpenCode with the Brick router

Brick exposes the local router to [OpenCode](https://opencode.ai) as a reserved
`opencode` profile. OpenCode selects the single `brick` model; Brick classifies
every turn and forwards it to the upstream model it picks.

## One-command setup

Install the published Brick package and start the managed profile:

```bash
npm install -g @regoloai/brick
brick start opencode
```

`brick start opencode` creates the `opencode` profile when it does not exist,
verifies the SystemOne checkpoint installed by `npm install`, starts the local
router on `127.0.0.1`, and wires the official OpenCode client to it. Open
OpenCode, select the `brick` model, and every turn is routed.

## What Brick writes

The CLI owns exactly one provider in the global OpenCode config,
`~/.config/opencode/opencode.json`. It is fenced by comment markers so the edit
is surgical: comments, formatting, and third-party keys are preserved.

```jsonc
"provider": {
  // >>> brick opencode managed provider (do not edit) >>>
  "brick": {
    "npm": "@ai-sdk/openai",
    "name": "Brick (local router)",
    "options": { "baseURL": "http://127.0.0.1:8000/v1" },
    "models": { "brick": {}, /* catalog models */ }
  }
  // <<< brick opencode managed provider <<<
}
```

Brick also installs its OpenCode V2 plugin at
`~/.config/opencode/plugins/brick/index.js`. At startup the plugin reads the
already-configured `brick` provider, fetches `<baseURL>/models` from the local
router, and refreshes the model inventory. It never registers a second provider,
and a stopped router only logs a warning and does not block OpenCode from
starting.

Writing is idempotent: running `brick start opencode` again leaves the file
byte-for-byte unchanged. Any existing `provider.brick` that Brick did not write
is never overwritten.

## Status and teardown

```bash
brick status opencode          # recognises the managed wiring
brick status opencode --for-agent   # machine-readable schema v2.0
brick stop opencode            # restores the original opencode.json, removes the plugin
```

`brick stop opencode` restores the exact `provider` value that was present
before wiring (or removes the key when Brick created the file), and uninstalls
only the plugin file it wrote.

## Notes

- The OpenCode integration targets OpenCode V2 (`@opencode/plugin`,
  `Plugin.define`). V1 and RPC/TUI plugin surfaces are out of scope.
- The plugin is bundled with the CLI and installed under the user config
  directory; it is not published to npm on its own.
- Brick handles provider authentication upstream, so there is no auth between
  OpenCode and the local router.
