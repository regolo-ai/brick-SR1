# plan_ab_suite: misura A/B del risparmio reale di Brick sul piano Claude

Suite di test che esegue la stessa task suite headless (`claude -p`) in due rami,
entrambi attraverso il proxy Brick:

- `brick_on`: `--model brick-claude` (skill router attivo)
- `brick_off`: `--model claude-sonnet-4-6` (passthrough puro verso Anthropic)

Il router (dopo le modifiche in `spatial-routing/apps/router/.../pkg/proxy/`)
logga per ogni risposta Anthropic, sia routed sia native, in
`routing_events.jsonl`: token reali (fresh/cache read/cache write/output),
header `anthropic-ratelimit-*` (utilization del piano) e il tag di
attribuzione `x-brick-ab-tag`. Il report confronta i due rami su consumo
piano reale, pass rate e costo esterno del classificatore.

## Prerequisiti (una tantum)

1. Rebuild dell'immagine router con le modifiche:

   ```bash
   cd /root/forkGO/spatial-routing
   docker build -f apps/router/Dockerfile -t docker.io/regolo/brick-cc-router:ab-suite .
   echo 'BRICK_CC_TAG=ab-suite' >> ~/.brick/profiles/claude/.env
   docker compose -p brick-claude -f ~/.brick/profiles/claude/docker-compose.yml up -d
   ```

2. Profilo brick attivo con `anthropic_passthrough.enabled: true` e
   `route_subagents: false` (il runner lo verifica e abortisce altrimenti).
3. `claude` CLI loggata con l'account subscription (OAuth in `~/.claude`).
4. Python 3 con PyYAML.

## Uso

```bash
# smoke: 1 task, entrambi i rami, auto-verifica header/tag/token
python3 run_suite.py --smoke

# suite completa: 20 task x 2 rep x 2 rami (~80 run, ore; consuma piano reale)
python3 run_suite.py

# report
python3 report.py out/runs/<run_id>
```

Flag utili: `--tasks 'qa_*'`, `--reps 1`, `--order block|abba` (default abba),
`--off-model`, `--profile`, `--url`.

Attenzione: il ramo OFF consuma piano reale al modello nativo. Eseguire la
suite in una finestra senza altro uso di Claude, altrimenti gli header di
utilization risultano sporchi (i token per-request restano comunque puliti
grazie al tag).

## Struttura

- `fixture_src/`: progetto Go "taskman" (CLI + HTTP API), sempre verde. Il
  runner lo copia in `.work/fixture/` (repo git usa e getta) a ogni task-run.
- `tasks/*.yaml`: 20 task (8 qa, 6 bugfix, 4 feature, 2 refactor) con
  `setup/` (introduce bug o test TDD) e `checks/` (exit 0 = pass, `$OUT_FILE`
  = stdout di claude).
- `run_suite.py`: runner seriale con ordine abba, tag per-run, snapshot del
  log eventi via `docker cp`, abort su 429.
- `report.py`: join tag -> eventi, plan_units (prezzi `../pricing.yaml`),
  delta utilization per-richiesta, pass rate, risparmio lordo/netto.
- `out/`, `.work/`: gitignored.
