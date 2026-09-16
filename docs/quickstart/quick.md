# Quick start

Follow [local installation and lifecycle](serve.md) to install Brick, configure
provider credentials, select models and start a profile.

For an official harness:

```bash
brick profile edit codex
brick start codex
```

Use `claude` instead of `codex` for Claude Code. Select models with verified
context limits and skill vectors before starting. Harness configuration is
changed only after the runtime becomes ready.

The local proxy exposes Chat Completions, Responses and Anthropic Messages
transports. See [the Codex integration](codex-native.md) for its tool and
credential contracts.
