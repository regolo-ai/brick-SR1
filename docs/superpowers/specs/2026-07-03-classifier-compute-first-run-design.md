# Design: scelta classifier locale/API al primo `brick claude on` / `brick codex on`

Data: 2026-07-03
Autore: Francesco Massa (via Claude)

## Contesto e problema

Oggi il profilo default (`ensureDefaultProfile` in `apps/cli/src/lib/claude/bootstrap.ts`)
nasce già cablato sul **classifier di complessità hosted (Regolo)**. Al primo
`brick claude on` (e `brick codex on`) il flusso chiama `ensureRegoloClassifierKey`
(`apps/cli/src/lib/config/regolo-key.ts`), che si limita a chiedere la `REGOLO_API_KEY`.

L'utente non sceglie mai esplicitamente **dove gira l'inferenza del classifier**:
locale (sidecar Docker, Qwen3.5-0.8B) oppure API (endpoint Regolo hosted). La scelta
esiste solo come comando separato `brick claude settings compute local|api`, poco
scopribile al primo avvio.

Obiettivo: al primo avvio, chiedere esplicitamente **locale o API**, e nel caso API
far inserire la chiave. Vale sia per Claude che per Codex.

## Comportamento voluto

- Al `brick claude on` / `brick codex on`, se il classifier **non è ancora configurato**,
  mostrare un menu `select`:
  - **API — hosted Regolo** (preselezionato)
  - **Local — Docker sidecar**
- La domanda ricompare **finché il classifier non è configurato**, non solo al
  primissimo avvio. Esempio: scelgo API ma lascio la chiave vuota → al prossimo `on`
  la scelta ricompare.
- API → prompt della chiave (riusa `REGOLO_API_KEY_HELP` + `p.password`), poi persistenza.
- Local → disclaimer risorse (`LOCAL_DISCLAIMER`) + switch al sidecar.
- Non-interattivo (CI/pipe, `!stdin.isTTY`) → nessun blocco: mantiene il warning attuale
  ("classifier falls back to medium until you set it").

### Definizione di "configurato"

- Modo **API**: la config punta a Regolo (`complexity_service.base_url` o
  `skill_router.complexity_model.base_url` inizia con `REGOLO_CLASSIFIER_URL`)
  **E** `REGOLO_API_KEY` è presente e non vuota in `.env`.
- Modo **Local**: la config NON punta a Regolo (il `base_url` è il sidecar locale).
  In questo caso non serve chiave → è già "configurato".

## Approccio scelto

Sostituire l'helper `ensureRegoloClassifierKey` con un helper più ampio
`ensureClassifierCompute(profile, announce?)`, nello stesso modulo
`apps/cli/src/lib/config/regolo-key.ts` (il modulo diventa il punto unico "assicurati
che il classifier sia configurato prima di avviare"). Entrambi `claude/on.ts:48` e
`codex/on.ts:39` già chiamano l'helper condiviso, quindi il cambiamento è in un solo
posto e copre entrambi i comandi.

Logica dell'helper:

1. Legge lo stato corrente:
   - modo (Regolo vs locale) da `loadConfigRaw` — stessa lettura già in `ensureRegoloClassifierKey`;
   - presenza chiave da `readEnvValue(pp.env, REGOLO_API_KEY_ENV)`.
2. **Già configurato** → no-op silenzioso (nessun attrito ai riavvii, identico a oggi
   quando la chiave c'è).
3. **Non configurato** + TTY interattivo → `p.select`:
   ```
   Where should the complexity classifier run?
   > API — hosted on Regolo (no GPU, needs an API key)   [initialValue]
     Local — Docker sidecar (Qwen3.5-0.8B, ~1.6GB VRAM)
   ```
   - **API** → `p.note(REGOLO_API_KEY_HELP)` + `p.password`. Se il modo corrente è già
     API basta salvare la chiave in `.env` (come oggi); se si commuta da locale a API,
     usare `runCompute('api', { token })` per riscrivere config + compose + restart.
   - **Local** → `p.note(LOCAL_DISCLAIMER)` + `runCompute('local', undefined)`.
4. **Non configurato** + non-TTY → warning attuale, nessun blocco.

Il menu segue la preferenza globale dell'utente sui menu di config: `initialValue`
sul valore raccomandato (`'api'`), no-op se la scelta non cambia nulla.

### Riuso (niente duplicazione)

- `runCompute(mode, api, exit)` (`apps/cli/src/lib/claude/runSettings.ts`): esegue già
  env-persistenza chiave, `applyCompute` (riscrive `complexity_service` +
  `skill_router.complexity_model` + rigenera compose), restart del router e
  aggiornamento wiring-state. NON riscrivere questa logica.
- `LOCAL_DISCLAIMER`, `REGOLO_API_KEY_HELP`, `REGOLO_CLASSIFIER_URL`, `ComputeMode`,
  `REGOLO_API_KEY_ENV`: già esportati da `settings-apply.ts`.
- La lettura "usa Regolo?" è identica a quella già in `ensureRegoloClassifierKey`.

Attenzione all'ordine in `on.ts`: l'helper gira **prima** di `ensureServing`/`isHealthy`
(come oggi), così un eventuale switch a locale rigenera il compose prima che il router
parta. `runCompute` fa restart se il router è già up; al primo avvio il router è down,
quindi la modifica sarà raccolta dal successivo `ensureServing`. Verificare che la
sequenza `ensureClassifierCompute` → `ensureServing` non avvii il router due volte.

## File toccati

- `apps/cli/src/lib/config/regolo-key.ts` — nuovo `ensureClassifierCompute`
  (sostituisce o affianca `ensureRegoloClassifierKey`; se rinominato, aggiornare i due
  import). Riusa `runCompute`.
- `apps/cli/src/commands/claude/on.ts` — chiamata all'helper nuovo (riga ~48).
- `apps/cli/src/commands/codex/on.ts` — chiamata all'helper nuovo (riga ~39).
- Test: `apps/cli/src/lib/claude/*.test.ts` — aggiungere un test per il rilevamento
  "configurato vs non configurato" (unit sull'helper di stato, senza prompt).

## Verifica end-to-end

1. `cd apps/cli && npm run lint && npm test` — verdi.
2. Profilo fresco: rimuovere `~/.brick/profiles/claude`, lanciare `brick claude on` in
   un TTY → deve comparire il menu API/Local con API preselezionato.
   - Scelta API + chiave valida → `.env` aggiornata, router parte, `brick claude status`
     ok. Rilancio `on` → nessun menu (configurato).
   - Scelta API + chiave vuota → warning; rilancio `on` → menu ricompare (non configurato).
   - Scelta Local → disclaimer, compose rigenerato con sidecar, `on` successivo silenzioso.
3. Stesso giro con `brick codex on`.
4. Non-TTY: `echo | brick claude on` → nessun hang, solo warning.
