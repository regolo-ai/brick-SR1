# Eval Cost & Token Usage Report

## Riepilogo Generale

| Modello | Benchmark | Score | Samples | Input Tok | Output Tok | Costo Tot |
|---------|-----------|-------|---------|-----------|------------|-----------|
| Brick (Router) | arc_challenge | 0.3% | 1,172 | 193,728 | 8,657 | — |
| GPT-OSS-120B | arc_challenge | 0.0% | 1,172 | 164,924 | 6,109 | €0.19 |
| GPT-OSS-20B | arc_challenge | 0.2% | 1,172 | 167,268 | 6,724 | €0.02 |
| Qwen3-8B | arc_challenge | 0.0% | 1,172 | 167,268 | 161 | €0.01 |
| Qwen3-Coder-Next | arc_challenge | 15.4% | 1,172 | 167,268 | 69,682 | €0.22 |
| Brick (Router) | bbh | 34.4% | 2,700 | 432,682 | 120,692 | — |
| GPT-OSS-120B | bbh | 33.0% | 2,700 | 386,948 | 119,952 | €0.89 |
| GPT-OSS-20B | bbh | 26.4% | 2,700 | 381,548 | 71,678 | €0.07 |
| Llama-3.3-70B-Instruct | bbh | 47.7% | 2,700 | 432,682 | 628,734 | €1.96 |
| Mistral-Small-3.2 | bbh | 47.2% | 2,700 | 351,706 | 640,196 | €1.58 |
| Qwen3-8B | bbh | 1.3% | 2,700 | 381,548 | 3,488 | €0.03 |
| Qwen3-Coder-Next | bbh | 39.2% | 2,700 | 381,548 | 643,074 | €1.48 |
| Brick (Router) | drop | 17.7% | 200 | 254,131 | 2,839 | — |
| GPT-OSS-120B | drop | 17.0% | 200 | 263,590 | 2,974 | €0.28 |
| GPT-OSS-20B | drop | 20.2% | 200 | 263,190 | 2,674 | €0.03 |
| Mistral-Small-3.2 | drop | 14.0% | 200 | 257,508 | 4,953 | €0.14 |
| Qwen3-8B | drop | 0.0% | 200 | 263,190 | 0 | €0.02 |
| Qwen3-Coder-Next | drop | 17.9% | 200 | 263,190 | 3,504 | €0.14 |
| Brick (Router) | humaneval | 0.0% | 164 | 54,096 | 17,669 | — |
| Qwen3-Coder-Next | humaneval | 0.0% | 164 | 23,161 | 39,629 | €0.09 |
| Brick (Router) | ifeval | 78.6% | 541 | 43,780 | 213,732 | — |
| GPT-OSS-120B | ifeval | 77.3% | 541 | 30,508 | 216,378 | €0.94 |
| GPT-OSS-20B | ifeval | 54.7% | 541 | 29,426 | 130,683 | €0.06 |
| Llama-3.3-70B-Instruct | ifeval | 88.4% | 541 | 43,780 | 183,027 | €0.52 |
| Mistral-Small-3.2 | ifeval | 89.3% | 541 | 26,061 | 189,698 | €0.43 |
| Qwen3-8B | ifeval | 71.5% | 541 | 29,426 | 141,170 | €0.05 |
| Qwen3-Coder-Next | ifeval | 81.0% | 541 | 29,426 | 212,083 | €0.44 |
| Brick (Router) | mbpp | 75.2% | 500 | 346,534 | 36,201 | — |
| Llama-3.3-70B-Instruct | mbpp | 3.0% | 500 | 346,534 | 65,997 | €0.39 |
| Qwen3-Coder-Next | mbpp | 74.8% | 500 | 363,354 | 37,018 | €0.26 |
| Brick (Router) | minerva_math | 12.4% | 700 | 534,545 | 34,661 | — |
| GPT-OSS-120B | minerva_math | 12.0% | 700 | 537,163 | 35,395 | €0.69 |
| GPT-OSS-20B | minerva_math | 15.7% | 700 | 535,763 | 30,087 | €0.07 |
| Llama-3.3-70B-Instruct | minerva_math | 23.7% | 700 | 534,545 | 171,137 | €0.78 |
| Mistral-Small-3.2 | minerva_math | 23.7% | 700 | 472,636 | 173,725 | €0.62 |
| Qwen3-8B | minerva_math | 0.0% | 700 | 535,763 | 0 | €0.04 |
| Qwen3-Coder-Next | minerva_math | 34.4% | 700 | 535,763 | 157,236 | €0.58 |
| Brick (Router) | mmlu_pro | 63.7% | 6,790 | 9,403,213 | 821,790 | — |
| GPT-OSS-120B | mmlu_pro | 63.7% | 6,790 | 9,512,311 | 812,372 | €12.92 |
| GPT-OSS-20B | mmlu_pro | 31.5% | 6,790 | 9,498,731 | 729,187 | €1.26 |
| Brick (Router) | truthfulqa | 47.0% | 817 | 157,523 | 31,971 | — |
| GPT-OSS-120B | truthfulqa | 46.0% | 817 | 144,517 | 31,906 | €0.28 |
| GPT-OSS-20B | truthfulqa | 34.0% | 817 | 142,883 | 21,451 | €0.02 |
| Mistral-Small-3.2 | truthfulqa | 53.0% | 817 | 137,288 | 53,698 | €0.19 |
| Qwen3-Coder-Next | truthfulqa | 53.4% | 817 | 142,883 | 46,029 | €0.16 |

## Per-Benchmark Detail

### arc_challenge (`exact_match,remove_whitespace`)

| Modello | Score | Samples | Avg In Tok | Avg Out Tok | Totale Tok | Costo (€) |
|---------|-------|---------|------------|-------------|------------|-----------|
| Brick (Router) | 0.3% | 1,172 | 165 | 7 | 202,385 | — |
| GPT-OSS-120B | 0.0% | 1,172 | 140 | 5 | 171,033 | €0.19 |
| GPT-OSS-20B | 0.2% | 1,172 | 142 | 5 | 173,992 | €0.02 |
| Qwen3-8B | 0.0% | 1,172 | 142 | 0 | 167,429 | €0.01 |
| Qwen3-Coder-Next | 15.4% | 1,172 | 142 | 59 | 236,950 | €0.22 |

### bbh (`exact_match,flexible-extract`)

| Modello | Score | Samples | Avg In Tok | Avg Out Tok | Totale Tok | Costo (€) |
|---------|-------|---------|------------|-------------|------------|-----------|
| Brick (Router) | 34.4% | 2,700 | 160 | 44 | 553,374 | — |
| GPT-OSS-120B | 33.0% | 2,700 | 143 | 44 | 506,900 | €0.89 |
| GPT-OSS-20B | 26.4% | 2,700 | 141 | 26 | 453,226 | €0.07 |
| Llama-3.3-70B-Instruct | 47.7% | 2,700 | 160 | 232 | 1,061,416 | €1.96 |
| Mistral-Small-3.2 | 47.2% | 2,700 | 130 | 237 | 991,902 | €1.58 |
| Qwen3-8B | 1.3% | 2,700 | 141 | 1 | 385,036 | €0.03 |
| Qwen3-Coder-Next | 39.2% | 2,700 | 141 | 238 | 1,024,622 | €1.48 |

### drop (`f1,none`)

| Modello | Score | Samples | Avg In Tok | Avg Out Tok | Totale Tok | Costo (€) |
|---------|-------|---------|------------|-------------|------------|-----------|
| Brick (Router) | 17.7% | 200 | 1,270 | 14 | 256,970 | — |
| GPT-OSS-120B | 17.0% | 200 | 1,317 | 14 | 266,564 | €0.28 |
| GPT-OSS-20B | 20.2% | 200 | 1,315 | 13 | 265,864 | €0.03 |
| Mistral-Small-3.2 | 14.0% | 200 | 1,287 | 24 | 262,461 | €0.14 |
| Qwen3-8B | 0.0% | 200 | 1,315 | 0 | 263,190 | €0.02 |
| Qwen3-Coder-Next | 17.9% | 200 | 1,315 | 17 | 266,694 | €0.14 |

### humaneval (`pass@1,create_test`)

| Modello | Score | Samples | Avg In Tok | Avg Out Tok | Totale Tok | Costo (€) |
|---------|-------|---------|------------|-------------|------------|-----------|
| Brick (Router) | 0.0% | 164 | 329 | 107 | 71,765 | — |
| Qwen3-Coder-Next | 0.0% | 164 | 141 | 241 | 62,790 | €0.09 |

### ifeval (`prompt_level_strict_acc,none`)

| Modello | Score | Samples | Avg In Tok | Avg Out Tok | Totale Tok | Costo (€) |
|---------|-------|---------|------------|-------------|------------|-----------|
| Brick (Router) | 78.6% | 541 | 80 | 395 | 257,512 | — |
| GPT-OSS-120B | 77.3% | 541 | 56 | 399 | 246,886 | €0.94 |
| GPT-OSS-20B | 54.7% | 541 | 54 | 241 | 160,109 | €0.06 |
| Llama-3.3-70B-Instruct | 88.4% | 541 | 80 | 338 | 226,807 | €0.52 |
| Mistral-Small-3.2 | 89.3% | 541 | 48 | 350 | 215,759 | €0.43 |
| Qwen3-8B | 71.5% | 541 | 54 | 260 | 170,596 | €0.05 |
| Qwen3-Coder-Next | 81.0% | 541 | 54 | 392 | 241,509 | €0.44 |

### mbpp (`pass_at_1,none`)

| Modello | Score | Samples | Avg In Tok | Avg Out Tok | Totale Tok | Costo (€) |
|---------|-------|---------|------------|-------------|------------|-----------|
| Brick (Router) | 75.2% | 500 | 693 | 72 | 382,735 | — |
| Llama-3.3-70B-Instruct | 3.0% | 500 | 693 | 131 | 412,531 | €0.39 |
| Qwen3-Coder-Next | 74.8% | 500 | 726 | 74 | 400,372 | €0.26 |

### minerva_math (`math_verify,none`)

| Modello | Score | Samples | Avg In Tok | Avg Out Tok | Totale Tok | Costo (€) |
|---------|-------|---------|------------|-------------|------------|-----------|
| Brick (Router) | 12.4% | 700 | 763 | 49 | 569,206 | — |
| GPT-OSS-120B | 12.0% | 700 | 767 | 50 | 572,558 | €0.69 |
| GPT-OSS-20B | 15.7% | 700 | 765 | 42 | 565,850 | €0.07 |
| Llama-3.3-70B-Instruct | 23.7% | 700 | 763 | 244 | 705,682 | €0.78 |
| Mistral-Small-3.2 | 23.7% | 700 | 675 | 248 | 646,361 | €0.62 |
| Qwen3-8B | 0.0% | 700 | 765 | 0 | 535,763 | €0.04 |
| Qwen3-Coder-Next | 34.4% | 700 | 765 | 224 | 692,999 | €0.58 |

### mmlu_pro (`exact_match,custom-extract`)

| Modello | Score | Samples | Avg In Tok | Avg Out Tok | Totale Tok | Costo (€) |
|---------|-------|---------|------------|-------------|------------|-----------|
| Brick (Router) | 63.7% | 6,790 | 1,384 | 121 | 10,225,003 | — |
| GPT-OSS-120B | 63.7% | 6,790 | 1,400 | 119 | 10,324,683 | €12.92 |
| GPT-OSS-20B | 31.5% | 6,790 | 1,398 | 107 | 10,227,918 | €1.26 |

### truthfulqa (`rouge1_acc,none`)

| Modello | Score | Samples | Avg In Tok | Avg Out Tok | Totale Tok | Costo (€) |
|---------|-------|---------|------------|-------------|------------|-----------|
| Brick (Router) | 47.0% | 817 | 192 | 39 | 189,494 | — |
| GPT-OSS-120B | 46.0% | 817 | 176 | 39 | 176,423 | €0.28 |
| GPT-OSS-20B | 34.0% | 817 | 174 | 26 | 164,334 | €0.02 |
| Mistral-Small-3.2 | 53.0% | 817 | 168 | 65 | 190,986 | €0.19 |
| Qwen3-Coder-Next | 53.4% | 817 | 174 | 56 | 188,912 | €0.16 |

## Confronto con Brick

| Benchmark | Brick Score | Miglior Modello | Suo Score | Delta | Costo Modello |
|-----------|-------------|-----------------|-----------|-------|---------------|
| arc_challenge | 0.3% | Qwen3-Coder-Next | 15.4% | +15.2pp | €0.22 |
| bbh | 34.4% | Llama-3.3-70B-Instruct | 47.7% | +13.3pp | €1.96 |
| drop | 17.7% | GPT-OSS-20B | 20.2% | +2.4pp | €0.03 |
| humaneval | 0.0% | Qwen3-Coder-Next | 0.0% | +0.0pp | €0.09 |
| ifeval | 78.6% | Mistral-Small-3.2 | 89.3% | +10.7pp | €0.43 |
| mbpp | 75.2% | Qwen3-Coder-Next | 74.8% | -0.4pp | €0.26 |
| minerva_math | 12.4% | Qwen3-Coder-Next | 34.4% | +22.0pp | €0.58 |
| mmlu_pro | 63.7% | GPT-OSS-120B | 63.7% | -0.1pp | €12.92 |
| truthfulqa | 47.0% | Qwen3-Coder-Next | 53.4% | +6.4pp | €0.16 |

## Stima Range Costo Brick

> Il costo reale di Brick dipende dalla distribuzione del routing tra i modelli.

> I range seguenti mostrano il costo se **tutte** le request fossero inoltrate al modello più/meno economico.

| Benchmark | Brick Tokens | Se cheapest | Se costliest | Modello cheap | Modello costly |
|-----------|-------------|-------------|--------------|---------------|----------------|
| arc_challenge | 202,385 | €0.02 | €0.23 | Qwen3-8B | GPT-OSS-120B |
| bbh | 553,374 | €0.07 | €0.94 | Qwen3-8B | GPT-OSS-120B |
| drop | 256,970 | €0.02 | €0.27 | Qwen3-8B | GPT-OSS-120B |
| humaneval | 71,765 | €0.0100 | €0.13 | Qwen3-8B | GPT-OSS-120B |
| ifeval | 257,512 | €0.08 | €0.94 | Qwen3-8B | GPT-OSS-120B |
| mbpp | 382,735 | €0.04 | €0.50 | Qwen3-8B | GPT-OSS-120B |
| minerva_math | 569,206 | €0.05 | €0.68 | Qwen3-8B | GPT-OSS-120B |
| mmlu_pro | 10,225,003 | €0.95 | €12.85 | Qwen3-8B | GPT-OSS-120B |
| truthfulqa | 189,494 | €0.02 | €0.29 | Qwen3-8B | GPT-OSS-120B |

---
*Report generated by `cost_report.py`*
