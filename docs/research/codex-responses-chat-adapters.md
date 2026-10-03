# Codex Responses-to-Chat-Completions adapters

## Finding

The adapter in the proposed Brick architecture already exists as an established
open-source pattern. It is technically feasible to route Codex's Responses API
traffic to Regolo's Chat Completions endpoint and return the result to Codex as
Responses SSE. It does not require Regolo to implement `/responses`.

The important qualification is that this is a compatibility layer, not a
wire-identical protocol conversion. It can preserve Codex's client-executed
tool loop if it treats tools as a typed, stateful translation problem. It must
reject, or explicitly shim, features for which Chat Completions has no semantic
counterpart.

## Existing implementations

| Project | Evidence of Responses-to-Chat translation | Custom/freeform tools | Assessment for Brick |
| --- | --- | --- | --- |
| [go-llm-proxy](https://github.com/yatesdr/go-llm-proxy/blob/master/docs/codex.md) | Direct native probe, then cached Chat translation after a 404; maps streamed Chat events back to Responses. | Documents `local_shell_call` and `custom_tool_call` as function-type tools, plus tool-result mapping. | Strongest directly comparable Go reference; explicitly Codex-oriented. |
| [codex-api-gateway](https://github.com/mapleafgo/codex-api-gateway/blob/main/docs/protocol-coverage.md) | Documents Responses/Chat streaming translation and coverage matrix. | Maps `shell`, `local_shell`, and `apply_patch` to Chat functions with one string input, then maps them back to `custom_tool_call`. | Closest published description of the required `apply_patch` shim. |
| [codex-universal-proxy](https://github.com/bharat2808/codex-universal-proxy) | Offers a Chat Completions adapter for Codex Responses traffic. | States that it preserves `apply_patch` and shims `tool_search`. | Useful behavioral reference; provider breadth needs independent verification. |
| [LiteLLM](https://github.com/BerriAI/litellm-docs/blob/main/docs/response_api.md) | Officially documents an opt-in `/responses` to `/chat/completions` bridge and calls out Codex CLI. | General bridge; documentation does not establish complete Codex custom-tool round trips. | Viable upstream component/prototype, insufficient evidence alone for our acceptance criteria. |
| [codex-adapter](https://github.com/tvrcgo/codex-adapter) and [completion-to-response](https://github.com/NoahStepheno/completion-to-response) | Both expose a local Responses endpoint and translate to Chat Completions with SSE and function calling. | Public documentation establishes function calling, not a complete freeform-tool contract. | Useful small-reference implementations, but not a reason to delegate Brick's credential boundary to another process. |

OpenAI's own Codex test helpers confirm that `apply_patch` is emitted as a
`custom_tool_call` with a raw `input` string, while ordinary functions carry a
JSON `arguments` string. [1]

## The missing Brick mapping

The current Brick adapter handles ordinary `function` tools. The missing
extension is a reversible freeform-tool registry.

| Responses from Codex | Chat sent to Regolo | Chat response returned by Regolo | Responses returned to Codex |
| --- | --- | --- | --- |
| `tools: [{type: "custom", name: "apply_patch"}]` | `tools: [{type: "function", function: {name: "apply_patch", parameters: {type: "object", properties: {input: {type: "string"}}, required: ["input"]}}}]` | `tool_calls[].function.arguments = '{"input":"*** Begin Patch..."}'` | `custom_tool_call {call_id, name: "apply_patch", input: "*** Begin Patch..."}` |
| `custom_tool_call_output {call_id, output}` | `{role: "tool", tool_call_id: call_id, content: output}` | N/A | N/A |
| regular `function` / `function_call` / `function_call_output` | Standard Chat `tools`, assistant `tool_calls`, tool message | Standard Chat function call | Standard Responses function-call item |
| `tool_search` with client execution | A declared shim function such as `tool_search` | Function call | `tool_search_call`, preserving the client execution ID |

The adapter must retain a per-request registry of each original tool's kind,
name, namespace, schema, and call IDs. It uses the registry to decide whether a
Chat function call returns a Responses `function_call`, `custom_tool_call`, or
`tool_search_call`. This avoids guessing from the tool name and supports two
tools with similar names but different wire semantics.

The source evidence supports this design. A published Codex gateway specifies
the same one-string freeform conversion for `apply_patch`, `shell`, and
`local_shell`; it also notes that consecutive calls must become one Chat
assistant message with `tool_calls[]`. [2] A reported production bug explains
why: dropping `type: "custom"` makes Codex's freeform `apply_patch` disappear;
the proposed fix maps it to `{input: string}` and preserves generated call IDs
when a streaming provider omits them. [3]

## Required streaming behavior

For a Chat-streamed custom/function call, the adapter needs to accumulate each
tool-call index independently:

1. Generate or retain a stable `call_id` on the first chunk.
2. Emit `response.output_item.added` once.
3. Emit either `response.function_call_arguments.delta` or a custom-call input
   delta form as chunks arrive; if Codex requires a complete freeform payload,
   buffer until the `output_item.done` event.
4. Emit exactly one matching done event and then `response.completed` only when
   the Chat stream finishes successfully.
5. On an upstream interruption, emit `response.failed`; never synthesize a
   successful completion from partial text or partial tool arguments.

This is a known failure point. The public bug report identifies missing Chat
tool-call IDs as sufficient to make Codex receive no usable tool event. [3]
The go-llm-proxy documentation publishes the corresponding event mapping for
Chat tool-call IDs and argument deltas. [4]

## Features that cannot be represented faithfully by generic Chat

| Feature | Recommendation for a Regolo Chat route |
| --- | --- |
| Encrypted reasoning items/signatures | Keep the request on native Responses; do not drop or fabricate them. |
| Native provider-hosted tools such as web search or code interpreter | Do not forward them as if Regolo executed them. Use a client-executed shim only where Brick/Codex owns execution and an explicit mapping exists. |
| `input_file` without a Chat representation | Reject before forwarding. |
| Images represented by URLs/data URLs | Support only after an end-to-end provider test; preserve `detail`. |
| Explicit `/responses/compact` encrypted compaction | Require native Responses, or use a documented summary-based fallback and label it non-equivalent. |
| Arbitrary unknown item/tool types | Reject rather than silently omit. |

This distinction matters. Some existing proxies explicitly drop reasoning,
compaction, and non-function provider tools when using Chat. [4] Other projects
document a summary fallback for compaction rather than claiming encrypted
equivalence. [4] Brick should keep the stronger rule from its original plan:
exclude an incompatible candidate for that request, rather than remove data.

## Recommended Brick implementation

Build the freeform registry into Brick's existing Go adapter rather than adding
a second runtime such as LiteLLM. Brick already owns model routing, provider
credentials, cancellation, and diagnostics. A second proxy would create an
additional credential boundary and make routing after tool results harder to
observe.

Implement in this order:

1. Add the `custom` tool-definition and `custom_tool_call` / output mappings.
2. Add a registry keyed by `(request, call_id)`, including namespace and the
   original tool kind.
3. Add generated stable IDs for upstream Chat chunks that omit them.
4. Preserve multiple calls in one assistant `tool_calls` message and test
   parallel calls.
5. Add `tool_search` only as an explicit client-executed shim.
6. Keep the existing reject paths for encrypted reasoning, unknown items, and
   unsupported multimodal/file forms.
7. Run the acceptance test that is currently missing: official Codex through
   Brick to Regolo, an `apply_patch` edit in a temporary project, test execution,
   tool result, and final answer.

The adapter should not use the Codex subscription token for Regolo. It should
continue to use the Regolo profile key, while the subscription token is only
used for the native OpenAI/Codex branch.

## Conclusion

There is no architectural reason to require a different external provider.
The diagram's upper branch is a normal and already implemented pattern in the
ecosystem. The concrete work remaining in Brick is to complete the bidirectional
freeform-tool conversion and verify it against Regolo. The original activation
gate should then be replaced by that live test result, not by a requirement that
Regolo expose a native Responses endpoint.

## Sources

1. OpenAI Codex repository, [Responses test helpers](https://github.com/openai/codex/blob/main/codex-rs/core/tests/common/responses.rs), accessed September 10, 2026.
2. mapleafgo, [Codex API Gateway protocol coverage](https://github.com/mapleafgo/codex-api-gateway/blob/main/docs/protocol-coverage.md), accessed September 10, 2026.
3. router-for-me/CLIProxyAPI, [Issue #4219: streamed tool calls and custom tools](https://github.com/router-for-me/CLIProxyAPI/issues/4219), July 2026.
4. yatesdr, [go-llm-proxy Codex documentation](https://github.com/yatesdr/go-llm-proxy/blob/master/docs/codex.md), accessed September 10, 2026.
5. BerriAI, [LiteLLM Responses API documentation](https://github.com/BerriAI/litellm-docs/blob/main/docs/response_api.md), accessed September 10, 2026.
6. bharat2808, [codex-universal-proxy](https://github.com/bharat2808/codex-universal-proxy), accessed September 10, 2026.
7. tvrcgo, [codex-adapter](https://github.com/tvrcgo/codex-adapter), accessed September 10, 2026.
8. NoahStepheno, [completion-to-response](https://github.com/NoahStepheno/completion-to-response), accessed September 10, 2026.
