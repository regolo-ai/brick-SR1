# Brick Large Benchmark — Risultati Completi

**Dataset:** `brick_large` — 2000 domande MMLU-Pro (A-J), 400 per categoria
**Categorie:** coding, math_reasoning, science_knowledge, general, humanities
**Data test:** 18-20 marzo 2026
**Endpoint:** Regolo API (`api.regolo.ai/v1`)

---

## Classifica Generale

| # | Modello | Score | Costo (2000q) | €/punto% |
|---|---------|-------|---------------|----------|
| 1 | qwen3.5-122b | **87.8%** | €9.406 | €0.107 |
| 2 | qwen3-coder-next | **83.4%** | €2.287 | €0.027 |
| 3 | qwen3.5-9b | **83.0%** | €3.324 | €0.040 |
| 4 | **Brick (audit config)** | **81.3%** | ~€4.32 | €0.053 |
| 5 | Brick (v2 config) | 81.1% | ~€4.15 | €0.051 |
| 6 | Brick (v1 config) | 79.4% | ~€2.22¹ | €0.028 |
| 7 | gpt-oss-120b | 79.3% | €1.790 | €0.023 |
| 8 | gpt-oss-20b | 73.5% | €1.338 | €0.018 |
| 9 | Llama-3.3-70B-Instruct | 70.5% | €0.237 | €0.003 |
| 10 | mistral-small3.2 | 70.3% | €0.257 | €0.004 |
| 11 | mistral-small-4-119b | 70.2% | €0.771 | €0.011 |

¹ Brick v1 aveva routing pesante su gpt-oss-120b/20b con output brevi → costo basso

---

## Breakdown per Categoria

| Modello | Coding | Math | Science | General | Humanities |
|---------|--------|------|---------|---------|------------|
| qwen3.5-122b | **88.8%** | **95.0%** | **92.8%** | **90.0%** | **72.2%** |
| qwen3-coder-next | 86.5% | 94.8% | 89.5% | 86.0% | 60.2% |
| qwen3.5-9b | 83.0% | 93.2% | 88.2% | 87.5% | 62.7% |
| **Brick audit** | **88.0%** | **93.2%** | **91.0%** | **85.0%** | **49.5%** |
| Brick v2 | 86.2% | 93.2% | 91.0% | 84.5% | 50.5% |
| Brick v1 | 84.8% | 92.8% | 91.0% | 80.5% | 54.5% |
| gpt-oss-120b | 83.2% | 93.0% | 85.2% | 82.2% | 53.0% |
| gpt-oss-20b | 77.0% | 90.2% | 81.2% | 76.0% | 43.0% |
| Llama-3.3-70B | 69.0% | 70.2% | 79.2% | 79.5% | 54.8% |
| mistral-small3.2 | 72.8% | 68.8% | 78.5% | 78.8% | 52.8% |
| mistral-small-4-119b | 72.0% | 68.8% | 78.8% | 78.0% | 53.8% |

---

## Token Usage e Costi — Modelli Singoli

| Modello | Prompt Tok | Completion Tok | Totale | €/1M in | €/1M out | Costo |
|---------|-----------|----------------|--------|---------|----------|-------|
| qwen3.5-122b | 463,560 | 7,722,790 | 8,186,350 | €0.30 | €1.20 | **€9.406** |
| qwen3.5-9b | 463,560 | 10,926,234 | 11,389,794 | €0.10 | €0.30 | €3.324 |
| qwen3-coder-next | 451,410 | 2,390,527 | 2,841,937 | €0.30 | €0.90 | €2.287 |
| gpt-oss-120b | 547,078 | 1,010,842 | 1,557,920 | €0.50 | €1.50 | €1.790 |
| gpt-oss-20b | 547,078 | 2,048,048 | 2,595,126 | €0.20 | €0.60 | €1.338 |
| mistral-small-4-119b | 479,998 | 697,046 | 1,177,044 | €0.30 | €0.90 | €0.771 |
| mistral-small3.2 | 479,998 | 698,210 | 1,178,208 | €0.10 | €0.30 | €0.257 |
| Llama-3.3-70B | 479,998 | 704,480 | 1,184,478 | €0.20 | €0.20 | €0.237 |

---

## Brick Audit — Distribuzione Routing

| Backend Model | Queries | % | Costo stimato |
|---------------|---------|---|---------------|
| qwen3.5-122b | 1016 | 50.4% | ~€2.57 |
| mistral-small-4-119b | 526 | 26.1% | ~€1.01 |
| qwen3-coder-next | 254 | 12.6% | ~€0.49 |
| gpt-oss-20b | 185 | 9.2% | ~€0.24 |
| qwen3.5-9b | 33 | 1.6% | ~€0.02 |
| **Totale** | **2014** | **100%** | **~€4.32** |

Token totali: 469,401 prompt + 4,129,045 completion = 4,598,446

---

## Analisi Costo-Efficacia

| Modello | Score | Costo | Score/€ |
|---------|-------|-------|---------|
| qwen3.5-9b | 83.0% | €3.32 | 25.0 |
| qwen3-coder-next | 83.4% | €2.29 | **36.4** |
| qwen3.5-122b | 87.8% | €9.41 | 9.3 |
| Brick audit | 81.3% | €4.32 | 18.8 |
| gpt-oss-120b | 79.3% | €1.79 | 44.3 |
| gpt-oss-20b | 73.5% | €1.34 | 54.9 |

**Miglior rapporto qualità/prezzo:** `qwen3-coder-next` (83.4% a €2.29)
**Miglior score assoluto:** `qwen3.5-122b` (87.8% a €9.41)

---

## Osservazioni Chiave

1. **qwen3.5-122b domina** a 87.8%, +4.4% sopra il secondo (qwen3-coder-next). È il modello più forte su tutte le categorie, specialmente humanities (72.2% vs 60.2% del secondo).

2. **Humanities è il tallone d'Achille del routing** — Brick audit fa 49.5% su humanities, ben sotto ogni modello singolo. `mistral-small-4-119b` (assegnato a humanities) fa solo 53.8% su quella categoria. Routare humanities verso `qwen3.5-122b` aggiungerebbe ~7 punti.

3. **mistral-small-4-119b ≈ mistral-small3.2** — Il modello 119b non offre alcun vantaggio rispetto al 3.2 (70.2% vs 70.3%), probabilmente MoE con attivazione simile. Costa 3× di più.

4. **qwen3.5-9b sorprende** — A 83.0% e €3.32 è competitivo con modelli 10× più grandi, ma genera output molto lunghi (10.9M completion tokens → costo alto per un 9b).

5. **Brick non batte il miglior singolo** — A 81.3% il router resta sotto qwen3-coder-next (83.4%) e qwen3.5-9b (83.0%). Il routing paga un costo nelle transizioni tra modelli e nell'assegnazione subottimale (humanities).

6. **gpt-oss-120b ridondante** — A 79.3% è sotto il Brick router. Rimosso nella config audit.

---

## Prossimi Passi Suggeriti

- **Routare humanities → qwen3.5-122b** (con reasoning) — potenziale +7% su humanities → +1.4% overall
- **Rimuovere mistral-small-4-119b** dalla config, sostituire con qwen3.5-122b o qwen3-coder-next
- **Valutare "all qwen3.5-122b"** come baseline — 87.8% ma a €9.41 (2× il brick audit)
- **Ridurre verbosità qwen3.5-9b/122b** con prompt engineering per tagliare costi output
