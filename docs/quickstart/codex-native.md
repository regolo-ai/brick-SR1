# Native Codex routing

Brick routes HTTP inference requests; the original official Codex session owns
its workspace, tools, login, and credential refresh. The former nested
`codex exec` bridge is retired.

Activation is enabled after complete official Codex tool cycles passed against
the Codex subscription upstream.

Codex's official model catalog is preserved and extended with `brick`. Selecting
an official model bypasses classification and preserves its reasoning settings.
Selecting `brick` reevaluates the compatible active pool on every inference
request, including requests containing tool results. Routing uses a separate
context view and does not truncate the forwarded history.

## One-command setup

Install the published Brick package, install Codex, and authenticate the
subscription once:

```bash
npm install -g @regoloai/brick
codex login
brick start codex
```

`brick start codex` creates the `codex` profile when it does not exist, verifies
the SystemOne checkpoint installed by `npm install`, starts the local router,
and wires the official Codex client to it. The default pool is two Codex
subscription models, `gpt-6.1-terra` and `gpt-6-luna`; no Regolo API key is
required. Open Codex,
select the `brick` model, and every turn is routed on the subscription.

An existing profile keeps its user-owned pool. To switch it to the default
Codex pool, run `brick start codex --reset-pool`: this replaces only the routing
pool, the default model, and an empty rule list, and leaves the configured
providers and credentials untouched.

Before starting, Brick compares the active pool with the authenticated Codex
catalog and warns when a model is not listed. The check is metadata-only and
never blocks a start: a catalog that lags the backend must not break a working
profile.

## Authentication and configuration

The managed setup implementation migrates matching legacy transport copies and
generates a separate
`BRICK_CODEX_LOCAL_KEY`, and configures `X-Brick-Key` in the managed Codex
provider.
The environment and Codex configuration files use mode `0600`. Conflicting
inline endpoints or credentials stop migration. The original catalog setting,
model, and provider are restored by `brick stop codex`. That command leaves the
local Responses bridge available to the already-open Codex thread: select an
official model such as `gpt-6.1-terra` to forward directly to the official Codex
upstream without classifier routing. Use `brick clear codex` when that thread
can be disconnected and the local bridge/runtime should be removed completely;
later Codex launches then use OpenAI directly.

The provider uses `requires_openai_auth = true`, HTTP/SSE, and disabled
transport
retries and WebSockets. Codex's Authorization and account headers go only to
`https://chatgpt.com/backend-api/codex/responses`. Brick never reads
`auth.json`.
External credentials come exclusively from the selected provider profile;
classifier credentials remain separate. Redirects are refused. External
401/403 responses become provider-attributed gateway errors, while subscription
authentication errors retain their upstream status and recovery header.

See the official [proxy authentication
documentation](https://learn.chatgpt.com/docs/auth#alternative-model-providers).

Each model references exactly one `provider_endpoints` entry. Its
`provider_profiles` entry owns the transport:

```yaml
codex_router:
  enabled: true
  local_key_env: BRICK_CODEX_LOCAL_KEY
provider_profiles:
  regolo:
    type: openai_compatible
    base_url: https://api.regolo.ai/v1
    protocol: chat_completions
    auth_source: provider_env
    api_key_env: REGOLO_API_KEY
    capabilities: [function_tools]
```

Known provider context limits are populated from first-party references instead
of prompting during configuration. Brick uses the **Total context** value shown
on each card in Regolo's [model library](https://regolo.ai/models/); this is the
hosted service limit and can be lower than the base model's architectural
window. Models served by the Codex subscription use the `context_window` value
from Codex's authenticated local model catalog, which reflects the effective
limit advertised to that client and account.

Native Responses providers declare `protocol: responses`, a relative
`responses_path` (default `responses`), and supported capabilities. Supported
feature declarations include `function_tools`, `custom_tools`,
`opaque_reasoning`, `images`, `audio`, `files`, `compaction`, and
`previous_response`.
Additional native item types require an explicit `item:<type>` declaration.
An optional `compact_path` declares a separate compaction operation. Unknown
protocols and incompatible requests are excluded; an empty candidate set fails
before forwarding. Configuration conflicts fail rather than selecting a
fallback.

Requests routed to the subscription backend are normalized to `store: false`
before forwarding: the Codex backend rejects persisted responses, while a client
may leave the field unset. Other Responses providers keep their own storage
semantics. The subscription backend also requires streaming; a non-streaming
request receives its explicit error rather than a synthesized JSON response.

The native runtime binds only `127.0.0.1`. It starts explicitly with
`brick start codex` and is not registered as a system service.
`brick start codex` refuses to wire a runtime that does not advertise the
native
Responses transport. Build the updated router before using this integration;
Publishing remains gated on platform verification.

Provider capabilities are inherited by each model. A model's
`transport_capabilities` list replaces the inherited list when present. This is
independent of the classifier's skill vector. At every start, each active pool
model receives a verified `context_window_size`. This is the maximum operational
input after any provider output reservation. Brick publishes the minimum as the
virtual model's `context_window` and `max_context_window`. Start a new Codex
session after changing the pool so the client loads the regenerated limit.

## Chat adapter field policy

The Chat Completions adapter supports text messages, instructions,
image/audio/file
parts when the backend declares the matching capability, function and custom
tool
schemas, namespaces, parallel calls, call identifiers, arguments, and tool
results.
It streams text and argument deltas as they arrive and reports partial failures
without synthesizing a successful completion. Unrepresentable fields fail
closed.

The adapter applies this explicit top-level field policy:

| Responses field | Chat branch policy |
|---|---|
| `model`, sampling settings, `store`, `metadata`, `service_tier`, `safety_identifier`, `prompt_cache_key`, `prompt_cache_retention`, `user` | Forwarded under the Chat equivalent |
| `instructions`, `input`, `tools`, `tool_choice`, `max_output_tokens`, `reasoning.effort`, `text.format` | Converted |
| `client_metadata`, `reasoning.summary`, `reasoning.context`, `include: [reasoning.encrypted_content]`, encrypted reasoning history | Consumed and omitted from the external copy |
| unknown fields, hosted tools without a declared native capability, other `include` values, background execution, automatic truncation | Rejected |

When Responses omits an output limit, the Chat copy requests at most 8,192
completion tokens to avoid provider defaults that reserve the entire remaining
context. Custom tools use a function schema with one required string property,
`input`; format constraints are included in its description and are decoded
strictly on return. Brick does not claim provider-side grammar enforcement.

`brick status` is passive: it reports router reachability separately from
unprobed upstream authentication and tool capability. It never runs classifier
or model inference during refresh. Responses include separate requested,
selected, and sent reasoning headers.

## Cheap model mixture

The starter pool is exactly two Codex subscription models, so cost and
capability trade off inside the same `brick` session:

- `gpt-6-luna` is the cheap tier, weighted toward creative and math-heavy work.
- `gpt-6.1-terra` carries the agentic and coding vectors, so tool-driven turns
  keep the stronger model.

The pool is only applied to new or empty profiles; an existing user-owned pool
is never rewritten. Skill vectors come from the Hugging Face dataset
`regolo/brick-skill-tables`: profile setup and every `brick start` replace the
template's provisional vectors with the published CSV, cached under
`$BRICK_HOME/cache`. `BRICK_SKILLS_OFFLINE=1` uses the cache only. A download
failure, an invalid published table, or a model missing from the table never
blocks the start and never drops a pool model: Brick keeps the vectors already
in the profile and reports what it kept. Official Codex catalog entries declare
their reasoning levels (both of these models support `max`), and the proxy
clamps an effort only when the selected model's declared modes exclude it.

Request effort also drives the routing knob (`low=-1`, `medium=-0.5`, `high=0`,
`xhigh=0.5`, `max=1`). The knob scales the request vector up, and at `max` the
starter pool's hard coding requests reach the stronger model by distance alone.
The pool also ships one strict rule, `strong-agentic`, which forces
`gpt-6.1-terra` whenever the latest user message mentions `apply_patch`,
`refactor`, `debug`, `bug(s)`, `failing test(s)`, or `unit test(s)`. That keeps
tool work on the strong tier while ordinary creative and math turns stay on the
cheap tier.

Because the Codex system prompt is itself coding-heavy, the classifier sees a
coding request on every Codex turn. At `high` effort (knob 0) that means serious
coding tasks can all land on `gpt-6.1-terra`; the cheap tier is exercised at
`medium` and `low` effort. This is expected knob behaviour, not a pool bug, and
`BRICK_CODEX_POOL_EFFORT` makes it measurable.

## Verification

The automated tests cover credential separation, redirects, cancellation,
concurrent sessions, early SSE delivery, function-call replay, incompatible
requests, dynamic routing after tool results, and manual model bypass.

Explicit live tests are opt-in in `pkg/proxy/codex_responses_test.go` and
`pkg/proxy/codex_cheap_mixture_live_test.go`:

- `BRICK_CODEX_CHEAP_MIX_LIVE_TEST=1`: the official Codex app-server routes
  real turns through SystemOne against its pinned luna/terra pair at `xhigh`,
  proves a tool turn edits the workspace through the routed model, and checks
  the effort normalization the harness configures.
- `BRICK_CODEX_POOL_POLL_LIVE_TEST=1`: five bounded coding tasks (Python, Go
  and Node) run through the official Codex client and a pinned luna/terra pool;
  the log records each task's routed model sequence, duration and whether its
  own tests pass, and protected test files are checked so a model cannot
  "fix" a task by rewriting the test. The companion
  `TestCheapPoolFixturesFailBeforeFix` runs offline and proves every fixture
  fails before the edit.

- `BRICK_CODEX_LIVE_TEST=1`: official Codex edits a temporary Python project,
  executes its tests, and returns through Brick after tool execution.
- `BRICK_REGOLO_LIVE_TEST=1` with `BRICK_TEST_EXTERNAL`: official Codex
  completes
  both the direct function fixture and a namespaced custom-tool workspace edit
  through Regolo's Chat adapter.
- `BRICK_CODEX_COMPACT_TEST=1`: the original official Codex app-server session
  compacts its context and recalls a marker on a subsequent turn.

These tests passed with Codex `0.153.4`. In the tested proxy configuration,
explicit Codex compaction used ordinary Responses requests, not the dedicated
`/responses/compact` operation. Requests were uncompressed; other content
encodings currently receive an explicit error. Neither dedicated upstream
compaction nor WebSockets is claimed as live-verified by these tests.
