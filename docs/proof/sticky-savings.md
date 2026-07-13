# Proof: sticky routing measurably reduces cost

**Claim.** On real routed traffic (521 turns, 513 priced, measured 2026-07-13), Brick's
sticky routing netted **−40.5M price-units versus a no-sticky counterfactual — a 25.05%
saving on the turns it held**. Of the 39 held turns (where the router's candidate differed
from the model actually served), 37 were the economically correct call and 2 were not.

This is an initial sample from one dev profile, not a definitive benchmark — see
[Honest caveats](#honest-caveats) below. It is reproducible on your own traffic in one
command (see [Reproduce it yourself](#reproduce-it-yourself)).

## Why this needed a dedicated measurement

Brick already surfaces a "savings" number in two places:
- `brick claude status` → **Economy** panel: cost of the *model mix* actually used vs an
  all-most-expensive-model baseline. Answers "did routing to cheaper models save money?".
- `brick claude stats routing` → `save/held`: the prompt-cache reprocessing cost a hold
  *avoided* on the cached prefix. Answers "how expensive would re-priming the cache have
  been?" — but only half the question.

Neither answers "did **holding** a model (instead of switching) actually save money **net**
of everything?" A hold keeps a conversation on its current model to avoid re-priming the
cache — but if that model is pricier, the extra cost of its output (and any fresh input) for
the rest of the turn could, in principle, outweigh the avoided cache-invalidation cost. The
prefix-only figure never checks this. This proof does.

## Methodology: counterfactual replay

For every routed turn where both the router's candidate model and the model actually served
are known, price the turn twice on the *same* recorded token counts:

- **Sticky (real)**: cost as actually served. The cached prefix billed as a **cache read**
  on the served model.
- **No-sticky (counterfactual)**: the same turn, served by the candidate instead. On a held
  turn, the prefix that was a cache read on the warm model becomes a **cache write** on the
  cold candidate — the exact reprocessing a hold avoids.

`Net = cost(sticky) − cost(no-sticky)`. Negative means sticky was cheaper. Summed over all
priced turns in a mode, this is the honest total: it already contains both sides of the
trade-off (avoided cache-invalidation vs the held model's own price).

Code: [`apps/router/src/spatial-router/pkg/proxy/replay.go`](../../apps/router/src/spatial-router/pkg/proxy/replay.go)
(`replayCounterfactual`), reusing the same switch-cost math as the live router
([`pkg/sticky/decision.go`](../../apps/router/src/spatial-router/pkg/sticky/decision.go)).

**Assumption (held-token-parity):** the counterfactual branch reprices the *same* token
counts on the candidate model — it does not simulate a different reply the candidate model
would actually have produced (different length, different downstream cache state). This is a
first-order price comparison, not a response simulation.

## Results

| Metric | Value |
|---|---:|
| Turns in log | 521 |
| Turns priced (enriched + both models resolvable) | 513 |
| Held turns (candidate ≠ served) | 39 |
| Held turns where sticky was cheaper | 37 |
| Held turns where sticky cost **more** | 2 |
| Net (sticky − no-sticky) | −40.5M price-units |
| **Savings** | **25.05%** |

For reference, the prefix-only figure the live `save/held` metric reports on the same
sample is 44.8M price-units avoided — larger than the net, because it does not subtract the
2 turns where the held model's own price outweighed the avoided cache rewrite.

## Reproduce it yourself

Copy the router's event log and pricing table out of the container, then run the replay:

```bash
docker cp brick-claude-router:/app/config/routing_events.jsonl ./routing_events.jsonl
docker cp brick-claude-router:/app/config/pricing.yaml ./pricing.yaml

cd apps/router/src/spatial-router
export LD_LIBRARY_PATH=$(pwd)/../../candle-binding/target/release  # needed by the proxy test package

BRICK_REPLAY_LOG=../../../../routing_events.jsonl \
BRICK_REPLAY_PRICING=../../../../pricing.yaml \
  go test -run TestReplayOnRealLog ./pkg/proxy/ -v
```

Or, without touching Go at all, ask the router directly (once your build includes the
enriched log — see [Data](#data) below for what "enriched" means):

```bash
brick claude stats routing
```

The `net (honest)` column shows the same counterfactual computed live, merged from
`replayCounterfactual` into `/api/v1/routing/stats`
([`pkg/proxy/routing_stats.go`](../../apps/router/src/spatial-router/pkg/proxy/routing_stats.go)).

## Data

[`data/routing_events_sample.jsonl`](data/routing_events_sample.jsonl) — the exact 521-turn
log this proof was computed from, copied from a live `brick-claude-router` container on
2026-07-13. [`data/pricing_sample.yaml`](data/pricing_sample.yaml) — the pricing table used
(public Anthropic per-model rates, no secrets). Both are a snapshot, not auto-updated.

Each JSONL line is one routed turn: `candidate_model`/`served_model` (a held turn is where
they differ), the per-turn token breakdown (`fresh_input_tokens`, `cache_read_tokens`,
`cache_creation_tokens`, `output_tokens` — the fields this replay needs), the prefix-only
`est_switch_delta_price_units`, and end-to-end latency. Older logs predating this token
breakdown ("legacy" records) still aggregate for session/latency stats but cannot be
net-priced — the replay reports them separately (`priced_turns` excludes them) rather than
silently mixing them in.

## Honest caveats

- **Small, early sample.** 513 priced turns from one dev profile over ~3 days. Not a
  controlled A/B, not yet the scale the sticky-routing promotion gate targets (50+ dev
  sessions across a longer window).
- **Held-token-parity**, stated above: this is a price comparison on recorded tokens, not a
  simulation of what the candidate model would actually have produced.
- **2 of 39 held turns lost the trade-off** — sticky cost more than switching would have.
  That is expected: the hysteresis in `DecideModel` (see
  [`pkg/sticky/decision.go`](../../apps/router/src/spatial-router/pkg/sticky/decision.go))
  trades off *some* held turns being wrong for *most* being right, using a fixed score
  margin rather than knowing the future. The net figure already includes these 2 losses —
  it is not cherry-picked.
- **No `off`-mode baseline in this sample.** This proof answers "hold vs always-switch on the
  same traffic", which does not require an `off` baseline. It does *not* by itself clear the
  full sticky-vs-off promotion gate (`brick claude stats routing` tracks that gate
  separately, and still needs an `off` stint to compare p95 latency).

## Where to go next

- [`apps/router/src/spatial-router/pkg/proxy/replay.go`](../../apps/router/src/spatial-router/pkg/proxy/replay.go) — the replay implementation and its tests.
- [`apps/router/src/spatial-router/pkg/sticky/decision.go`](../../apps/router/src/spatial-router/pkg/sticky/decision.go) — the switch-cost math and hysteresis rule sticky routing actually runs on.
- `brick claude stats routing` — the live version of this measurement against your own router.
