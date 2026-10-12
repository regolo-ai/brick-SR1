# SystemOne — query → capability vector (workstream report)

Single-head ModernBERT-large (8192 ctx) predicting `final_vector ∈ [0,1]⁶`
(`instruction_following, coding, math_reasoning, world_knowledge, planning_agentic, creative_synthesis`).

## Artifacts
- Dataset: `massaindustries/systemone-50k-train` (privato) — v1 49.680 righe,
  v2 +13k (pair-transfer + garbage-zero) = 62.658, v3 +6k (ultra-short) = 68.882
- Modello v1: `massaindustries/brick-systemone-large` — holdout pearson **0,9663**
- Modello v2 (current): `massaindustries/brick-systemone-large-v2` — holdout **0,9656**,
  brevity-gap 0,27→0,13, garbage-spike 30%→0%
- Sweep W&B: `massa-industries/sysone-large/slgwu3po` (8 run, Bayes + Hyperband).
  Winner v1: `magic-sweep-8` (LR 8.93e-5, WD 1.1e-4, warmup 0.062, 4 epoch, gradacc 8).
  v2/v3 retrain con stessa ricetta. Vedi `assets/` (curve, ranking, history CSV).
- Serving: `deploy/addons/brick-systemone-server/` (porta 8095, `/vectors`+`/health`).
  Latenza RTX PRO bf16: short 7ms, 10k-char 16ms, ~150 qps seriali.
- Router: `capability_model.sidecar_url` → sidecar primario, fallback Candle invariato
  (`pkg/brickrouting/router.go`, `pkg/config/config.go`, `sidecar_test.go`).
- Batterie di calibrazione: `map2_battery.tsv` + `map2_run.py` (nella farm dati);
  baseline JSON in `assets/`? No — restano nella farm `Brick-SystemOne-Training-Data`
  (repo separato, non versionato qui).

## Note operative (dal lavoro sul campo)
- Cluster: Seeweb `ECS2GPU12` (2× RTX PRO 6000 96GB, GB202/sm_120). Driver ≥580
  obbligatorio (il 570 non inizializza CUDA). vLLM funziona solo con
  `--attention-backend TRITON_ATTN --enforce-eager`, decoding greedy-only
  (il sampler JIT flashinfer non compila su sm_120).
- transformers 5.x: niente più `warmup_ratio` (convertire in `warmup_steps`);
  flash-attn non compila su Blackwell → fallback sdpa (ok).
- `sky exec` con comando raw non sincronizza il workdir: usare rsync esplicito.
- Label difficulty effectively ordinal-7 (judge quantization); corr(diff,len) 0.3-0.6.
