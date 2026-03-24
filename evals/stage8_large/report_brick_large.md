# Brick Large Benchmark — Report Completo

**Data esecuzione:** 18-19 marzo 2026
**Dataset:** `brick_large` — 2000 domande MMLU-Pro, 400 per categoria
**Formato:** A-J (fino a 10 scelte, formato MMLU-Pro nativo)
**Metriche:** Exact Match (lettera risposta estratta via regex)

---

## 1. Riepilogo Risultati

| # | Modello | Accuracy | Correct / 2000 | +/- | Note |
|---|---|---|---|---|---|
| 1 | **Qwen3-Coder-Next** | **83.4%** | 1668 | 0.83% | Best assoluto |
| 2 | **Brick (Router)** | **79.4%** | 1588 | 0.90% | Pareggia GPT-120B |
| 3 | GPT-OSS-120B | 79.4% | 1587 | 0.91% | reasoning_effort=high |
| 4 | GPT-OSS-20B | 73.5% | 1470 | 0.99% | Best cost-efficiency |
| 5 | Llama-3.3-70B-Instruct | 70.6% | 1411 | 1.02% | |
| 6 | Mistral-Small-3.2 | 70.3% | 1406 | 1.02% | |
| 7 | Qwen3.5-9B | — | — | — | Crash a 1476/2000 (502 gateway) |

> `qwen3-8b` rimosso da Regolo API durante il test. Sostituito con `qwen3.5-9b`, che ha crashato per un 502 Bad Gateway a 1476/2000. `lm-eval` salva i risultati solo a fine run, quindi l'accuracy parziale non e' recuperabile. I dati di token/costi parziali (1476q) sono inclusi nella sezione 3.

---

## 2. Accuracy per Categoria

| Categoria | Qwen3-Coder | Brick | GPT-120B | GPT-20B | Llama-70B | Mistral-24B |
|---|---|---|---|---|---|---|
| **math_reasoning** | **94.8%** | 92.8% | 93.0% | 90.2% | 70.2% | 68.8% |
| **science_knowledge** | **89.5%** | 84.5% | 85.2% | 81.2% | 79.2% | 78.5% |
| **coding** | **86.5%** | 84.8% | 83.2% | 77.0% | 69.0% | 72.8% |
| **general** | **86.0%** | 80.5% | 82.2% | 76.0% | 79.5% | 78.8% |
| **humanities** | **60.2%** | 54.5% | 53.0% | 43.0% | 54.8% | 52.8% |
| **Totale** | **83.4%** | **79.4%** | **79.4%** | **73.5%** | **70.6%** | **70.3%** |

### Osservazioni per categoria

- **Math**: Qwen3-Coder (94.8%), GPT-120B (93.0%) e Brick (92.8%) dominano. La matematica pura premia i modelli grandi o specializzati. Llama/Mistral restano a 68-70%.
- **Humanities**: la categoria piu' difficile per tutti. Gap enorme: GPT-20B (43.0%) vs Qwen3-Coder (60.2%). Legge + filosofia MMLU-Pro risulta la piu' ostica.
- **Coding**: Qwen3-Coder eccelle (86.5%), Brick segue a 84.8% — il routing verso Qwen3-Coder funziona bene qui.
- **Science / General**: modelli mid-range (Llama, Mistral) competitivi a 78-80%, suggerendo che le scienze non richiedono ragionamento avanzato.
- **Brick vs GPT-120B**: Brick vince su coding (+1.6pp) e humanities (+1.5pp), perde su science (-0.7pp) e general (-1.7pp). Pareggio su math (-0.2pp).

---

## 3. Token Usage e Costi

### Token per richiesta (media per domanda)

| Modello | Input (avg/q) | Output (avg/q) | Totale/q |
|---|---|---|---|
| GPT-OSS-120B | 274 | 505 | 779 |
| GPT-OSS-20B | 274 | 1,024 | 1,298 |
| Qwen3-Coder-Next | 226 | 1,195 | 1,421 |
| Llama-3.3-70B | 240 | 352 | 592 |
| Mistral-Small-3.2 | 240 | 349 | 589 |
| Brick (router) | 270 | 840 | 1,110 |
| Qwen3.5-9B * | 277 | 6,720 | 6,998 |

> \* Qwen3.5-9B: dati parziali (1476/2000 domande). Output estremamente verboso (6720 tok/q, ~9.9M token totali su 1476 domande).

### Token totali

| Modello | Input | Output | Totale |
|---|---|---|---|
| GPT-OSS-120B | 547,078 | 1,010,842 | **1,557,920** |
| GPT-OSS-20B | 547,078 | 2,048,048 | **2,595,126** |
| Qwen3-Coder-Next | 451,410 | 2,390,527 | **2,841,937** |
| Llama-3.3-70B | 479,998 | 704,480 | **1,184,478** |
| Mistral-Small-3.2 | 479,998 | 698,210 | **1,178,208** |
| Brick (router) | 540,316 | 1,680,328 | **2,220,644** |
| Qwen3.5-9B * | 409,369 | 9,918,338 | **10,327,707** |

> **Totale token consumati (tutti i modelli): ~21.9M**
> Di cui Qwen3.5-9B da solo ne ha consumati 10.3M (47%) per soli 1476 domande.

### Costi stimati (prezzi Regolo API, EUR)

| Modello | Input /1M | Output /1M | Costo Totale | Costo/Domanda |
|---|---|---|---|---|
| GPT-OSS-120B | 1.00 | 4.20 | **4.79** | 0.00240 |
| GPT-OSS-20B | 0.10 | 0.42 | **0.91** | 0.00046 |
| Qwen3-Coder-Next | 0.50 | 2.00 | **5.01** | 0.00250 |
| Llama-3.3-70B | 0.60 | 2.70 | **2.19** | 0.00110 |
| Mistral-Small-3.2 | 0.50 | 2.20 | **1.78** | 0.00089 |
| Brick (router) | ~0.62 | ~2.58 | **4.67** | 0.00234 |
| Qwen3.5-9B * | 0.07 | 0.35 | **3.50** | ~0.00237 |
| **TOTALE campagna** | — | — | **22.85** | — |

> \* Costo Brick stimato da routing distribution reale (vedi sezione 4). Costo Qwen3.5-9B alto per l'enorme verbosita' in output (3.47M token su 1476 domande).

### Efficienza (Accuracy / Costo)

| Modello | Accuracy | Costo | Acc/EUR |
|---|---|---|---|
| **GPT-OSS-20B** | 73.5% | 0.91 | **80.8 pp/EUR** |
| Mistral-Small-3.2 | 70.3% | 1.78 | 39.5 pp/EUR |
| Llama-3.3-70B | 70.6% | 2.19 | 32.2 pp/EUR |
| **Brick (router)** | **79.4%** | **4.67** | **17.0 pp/EUR** |
| GPT-OSS-120B | 79.4% | 4.79 | 16.6 pp/EUR |
| Qwen3-Coder-Next | 83.4% | 5.01 | 16.6 pp/EUR |

> **GPT-OSS-20B** e' il piu' cost-efficient (80.8 pp/EUR). **Brick** ha la stessa accuracy di GPT-120B ma costa leggermente meno (4.67 vs 4.79, -2.5%).

---

## 4. Brick — Routing Analysis

### Distribuzione routing (2000 domande)

| Modello downstream | Domande | % | Ruolo nel routing |
|---|---|---|---|
| **GPT-OSS-120B** | 927 | 46.4% | STEM + humanities + hard reasoning |
| GPT-OSS-20B | 551 | 27.6% | Business, economics, science, default |
| Qwen3-Coder-Next | 466 | 23.3% | Coding + math + analysis |
| Llama-3.3-70B | 29 | 1.5% | Creative, formatting |
| Qwen3.5-9B | 17 | 0.9% | Greetings, easy reasoning |
| Mistral-Small-3.2 | 10 | 0.5% | Formatting |

### Cambiamento rispetto ai benchmark precedenti

- **brick_mixed (200q)**: 87.5% Qwen3-Coder, 10.5% GPT-120B, 1% altro
- **brick_large (2000q)**: 46.4% GPT-120B, 27.6% GPT-20B, 23.3% Qwen3-Coder

Il routing e' radicalmente diverso! Su brick_large, le domande MMLU-Pro native (10-choice, prevalentemente domain-specific) attivano le regole di dominio (`domain_stem`, `domain_humanities`, `domain_business`, `domain_science`) che routano verso GPT-120B e GPT-20B. Su brick_mixed le domande erano piu' generiche e attivavano keywords/complexity, che favorivano Qwen3-Coder.

### Impatto sulla performance

Brick raggiunge 79.4% usando un mix pesato di modelli. Se avesse routato tutto su Qwen3-Coder (83.4%), avrebbe ottenuto +4pp. Il routing verso GPT-120B (79.4%) e GPT-20B (73.5%) per domini come humanities e science penalizza il risultato complessivo.

---

## 5. Durata Esecuzione

| Modello | Durata | Domande/min |
|---|---|---|
| GPT-OSS-120B | **1h 00m** | ~33/min |
| GPT-OSS-20B | **2h 34m** | ~13/min |
| Llama-3.3-70B | **5h 41m** | ~6/min |
| Mistral-Small-3.2 | **5h 46m** | ~6/min |
| Qwen3-Coder-Next | **8h 09m** | ~4/min |
| Brick (router) | **4h 52m** | ~7/min |

> GPT-OSS-120B e' il piu' veloce (505 tok/output in media). Qwen3-Coder il piu' lento (1195 tok/output, verboso). Brick intermedio — la latenza include l'overhead del router (~100-200ms per embedding + classification).

---

## 6. Confronto con Benchmark Precedenti

### Evoluzione accuracy per modello

| Modello | brick_hard 200q | brick_mixed 200q | **brick_large 2000q** | Delta (hard->large) |
|---|---|---|---|---|
| Qwen3-Coder-Next | 79.5% | 85.0% | **83.4%** | +3.9pp |
| **Brick (router)** | **81.5%** | **82.5%** | **79.4%** | **-2.1pp** |
| GPT-OSS-120B | 71.5% | 81.0% | **79.4%** | +7.9pp |
| GPT-OSS-20B | 69.0% | 79.0% | **73.5%** | +4.5pp |
| Llama-3.3-70B | 53.5% | 69.0% | **70.6%** | +17.1pp |
| Mistral-Small-3.2 | 53.5% | 69.0% | **70.3%** | +16.8pp |
| Qwen3-8B / Qwen3.5-9B | 54.0% | 68.5% | — (crash) | — |

### Osservazioni chiave

1. **Brick non batte piu' il best-model.** Su brick_hard (200q) Brick era +2.0pp sopra Qwen3-Coder (81.5 vs 79.5). Su brick_large (2000q) Brick e' -4.0pp sotto (79.4 vs 83.4). Il dataset piu' grande e con domande domain-specific sposta il routing verso GPT-120B/20B, che sono meno accurati di Qwen3-Coder.

2. **Brick pareggia GPT-120B** al centesimo (79.4% entrambi), ma a costo leggermente inferiore (-2.5%).

3. **Il routing attuale non ottimizza per accuracy** — routa solo il 23% a Qwen3-Coder (il modello migliore). Se routasse il 100% a Qwen3-Coder, otterrebbe +4pp ma allo stesso costo.

4. **I modelli piccoli (Llama, Mistral) migliorano drasticamente** rispetto a brick_hard (+17pp), confermando che brick_hard era un test molto selettivo.

5. **Il formato 10-choice e' significativamente piu' difficile** del 4-choice: GPT-20B perde 5.5pp rispetto a brick_mixed.

---

## 7. Note sul Dataset

| Parametro | Valore |
|---|---|
| Totale domande | 2,000 |
| Domande per categoria | 400 |
| Formato scelte | A-J (MMLU-Pro nativo, max 10 scelte) |
| Distribuzione scelte | 10-choice: 1602 (80.1%), 9: 169, 8: 55, altri: 174 |
| Seed generazione | 2000 |
| Deduplicazione | Si (395 domande escluse da brick_hard/general/mixed) |
| Fonte coding | 342 computer_science + 58 engineering (CS pool esaurito) |
| Fonte math | 400 x MMLU-Pro math |
| Fonte humanities | 400 x law + philosophy |
| Fonte science | 400 x biology + chemistry + physics + health |
| Fonte general | 400 x economics + psychology |

---

## 8. Riepilogo Costi Campagna

| Voce | EUR |
|---|---|
| 6 modelli singoli (completati) | 14.68 |
| Brick (router) | 4.67 |
| Qwen3.5-9B (parziale 1476/2000) | 3.50 |
| **Totale campagna brick_large** | **~22.85** |
| Token totali consumati | ~21.9M |

---

## 9. Conclusioni

1. **Qwen3-Coder-Next e' il modello piu' accurato** su MMLU-Pro 10-choice con 83.4% — superiore a GPT-120B di +4pp.

2. **Brick (router) pareggia GPT-120B** (79.4%) ma non riesce a raggiungere Qwen3-Coder su questo benchmark. La causa principale e' il routing: le domande MMLU-Pro attivano le regole di dominio che distribuiscono il traffico su GPT-120B (46%) e GPT-20B (28%), invece di concentrare su Qwen3-Coder.

3. **Opportunita' di miglioramento per Brick**: routare piu' aggressivamente verso Qwen3-Coder per domande multi-choice/MMLU-style potrebbe portare l'accuracy verso l'83%. L'attuale configurazione privilegia la specializzazione per dominio rispetto all'accuracy globale.

4. **GPT-OSS-20B e' il campione di cost-efficiency**: 73.5% a EUR 0.91 (80.8 pp/EUR), 5x piu' economico di Qwen3-Coder.

5. **Qwen3.5-9B e' estremamente verboso** (~6700 tok/output): il costo per domanda (EUR 0.00237) e' paragonabile a GPT-120B nonostante il pricing sia 14x piu' basso. Un test con `max_tokens` ridotto potrebbe migliorare drasticamente il rapporto costo/performance.

---

*Report generato automaticamente — 19 marzo 2026*
*File: `evals/stage8_large/report_brick_large.md`*
