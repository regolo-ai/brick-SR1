# Classifier local/api first-run choice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At `brick claude on` / `brick codex on`, when the complexity classifier is not yet configured, prompt the user to choose local (Docker sidecar) vs API (hosted Regolo) inference, asking for the Regolo key in the API case, until it is configured.

**Architecture:** Replace the narrow `ensureRegoloClassifierKey` helper with a broader `ensureClassifierCompute` in the same module. A pure status function classifies the profile as `configured | needs-key | needs-choice`; the helper renders a `p.select` (API preselected) only when unconfigured on an interactive TTY, then delegates to the existing `runCompute` for all apply/restart/env work. Both `claude/on.ts` and `codex/on.ts` already call the shared helper, so swapping it covers both commands.

**Tech Stack:** TypeScript, oclif, `@clack/prompts`, vitest.

## Global Constraints

- No em dashes in any user-facing copy or comments (house style). Use commas, colons, or parentheses.
- Menus preselect the current/recommended value via `initialValue`, and a re-selection of the unchanged value is a no-op (reuse `runCompute` / `applyCompute`, which already snapshot-and-skip).
- Never inline a literal API key into YAML; keys live in the profile `.env` only (already handled by `runCompute`).
- Non-interactive (`!process.stdin.isTTY`): never block on a prompt; warn and continue.
- Node >= 18, `"type": "module"` (use `.js` import specifiers).

---

### Task 1: Pure `classifierComputeStatus` status reader

A pure function that decides, from a parsed config object and the resolved key value, whether the classifier is already configured or what is missing. No I/O, fully unit-testable.

**Files:**
- Modify: `apps/cli/src/lib/config/regolo-key.ts`
- Test: `apps/cli/src/lib/config/regolo-key.test.ts` (create)

**Interfaces:**
- Consumes: `REGOLO_CLASSIFIER_URL` from `../claude/settings-apply.js`.
- Produces: `export type ClassifierComputeStatus = 'configured' | 'needs-key' | 'needs-choice';` and `export function classifierComputeStatus(rawConfig: any, resolvedKey: string): ClassifierComputeStatus`.
  - Returns `configured` when the config does NOT point at Regolo (local mode: no key needed).
  - Returns `configured` when it points at Regolo AND `resolvedKey.trim() !== ''`.
  - Returns `needs-key` when it points at Regolo AND the key is blank (mode already API, only the key is missing).
  - Returns `needs-choice` when the config is neither clearly local nor clearly Regolo (fresh/ambiguous), so we ask the full local-vs-api question.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/lib/config/regolo-key.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifierComputeStatus } from './regolo-key.js';
import { REGOLO_CLASSIFIER_URL, LOCAL_CLASSIFIER_URL } from '../claude/settings-apply.js';

function regoloConfig(): any {
  return { complexity_service: { base_url: REGOLO_CLASSIFIER_URL } };
}
function localConfig(): any {
  return { complexity_service: { base_url: LOCAL_CLASSIFIER_URL } };
}

describe('classifierComputeStatus', () => {
  it('is configured for a local classifier regardless of key', () => {
    expect(classifierComputeStatus(localConfig(), '')).toBe('configured');
  });

  it('is configured for Regolo when a key is present', () => {
    expect(classifierComputeStatus(regoloConfig(), 'sk-abc')).toBe('configured');
  });

  it('needs-key for Regolo when the key is blank', () => {
    expect(classifierComputeStatus(regoloConfig(), '   ')).toBe('needs-key');
  });

  it('needs-choice when the config points nowhere recognizable', () => {
    expect(classifierComputeStatus({}, '')).toBe('needs-choice');
  });

  it('also inspects skill_router.complexity_model.base_url for Regolo', () => {
    const cfg = { skill_router: { complexity_model: { base_url: REGOLO_CLASSIFIER_URL } } };
    expect(classifierComputeStatus(cfg, '')).toBe('needs-key');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && npx vitest run src/lib/config/regolo-key.test.ts`
Expected: FAIL with "classifierComputeStatus is not a function" / import error.

- [ ] **Step 3: Add the pure function to `regolo-key.ts`**

Add near the top of `apps/cli/src/lib/config/regolo-key.ts` (after imports), and add `LOCAL_CLASSIFIER_URL` is NOT needed here — only `REGOLO_CLASSIFIER_URL` (already imported). Insert:

```typescript
export type ClassifierComputeStatus = 'configured' | 'needs-key' | 'needs-choice';

/**
 * Decide, from a parsed config and the resolved Regolo key, whether the
 * complexity classifier is ready. Pure (no I/O) so it is trivially testable.
 *
 * - Points at Regolo + key present  -> configured
 * - Points at Regolo + key blank     -> needs-key (mode chosen, key missing)
 * - Points somewhere else (local)    -> configured (local needs no key)
 * - Neither clearly Regolo nor local -> needs-choice (ask local vs api)
 */
export function classifierComputeStatus(rawConfig: any, resolvedKey: string): ClassifierComputeStatus {
  const csUrl: string = rawConfig?.complexity_service?.base_url ?? '';
  const cmUrl: string = rawConfig?.skill_router?.complexity_model?.base_url ?? '';
  const pointsAtRegolo =
    csUrl.startsWith(REGOLO_CLASSIFIER_URL) || cmUrl.startsWith(REGOLO_CLASSIFIER_URL);
  const anyUrl = (csUrl || cmUrl).trim() !== '';

  if (pointsAtRegolo) {
    return resolvedKey.trim() !== '' ? 'configured' : 'needs-key';
  }
  // A concrete non-Regolo URL means a local/custom classifier: no key needed.
  if (anyUrl) return 'configured';
  return 'needs-choice';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cli && npx vitest run src/lib/config/regolo-key.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/config/regolo-key.ts apps/cli/src/lib/config/regolo-key.test.ts
git commit -m "feat(cli): pure classifierComputeStatus reader for classifier config state"
```

---

### Task 2: `ensureClassifierCompute` interactive helper

The interactive flow that reads the profile state, shows the local/api choice when unconfigured, and delegates to `runCompute`. Replaces `ensureRegoloClassifierKey`.

**Files:**
- Modify: `apps/cli/src/lib/config/regolo-key.ts`

**Interfaces:**
- Consumes: `classifierComputeStatus` (Task 1); `runCompute` from `../claude/runSettings.js`; `loadConfigRaw` from `./load.js`; `readEnvValue` from `./env-file.js`; `paths` from `./paths.js`; `LOCAL_DISCLAIMER`, `REGOLO_API_KEY_HELP`, `REGOLO_API_KEY_ENV` from `../claude/settings-apply.js`; `p` from `@clack/prompts`.
- Produces: `export async function ensureClassifierCompute(profile: string, announce?: string): Promise<void>`. Non-throwing (mirrors the old helper's contract): any read failure is a silent return so router startup is never blocked.

- [ ] **Step 1: Add the helper to `regolo-key.ts`**

Add these imports at the top of `apps/cli/src/lib/config/regolo-key.ts` (keep existing ones):

```typescript
import { runCompute } from '../claude/runSettings.js';
import { LOCAL_DISCLAIMER } from '../claude/settings-apply.js';
```

(`REGOLO_API_KEY_HELP`, `REGOLO_API_KEY_ENV`, `REGOLO_CLASSIFIER_URL` are already imported in this file.)

Append the new helper:

```typescript
/**
 * Ensure the complexity classifier is configured before the router starts.
 * When the profile is unconfigured on an interactive TTY, prompt for local vs
 * API inference (API preselected) and, for API, the Regolo key. Delegates all
 * apply/restart/env work to runCompute. Re-prompts on every `on` until the
 * classifier is configured. Never throws.
 *
 * `announce` is printed once before prompting on a freshly-created profile.
 */
export async function ensureClassifierCompute(profile: string, announce?: string): Promise<void> {
  let raw: any;
  try {
    raw = await loadConfigRaw(profile);
  } catch {
    return; // can't read config: don't block startup
  }

  const pp = paths(profile);
  const resolvedKey =
    (await readEnvValue(pp.env, REGOLO_API_KEY_ENV)) ?? process.env[REGOLO_API_KEY_ENV] ?? '';

  const status = classifierComputeStatus(raw, resolvedKey);
  if (status === 'configured') return;

  // Non-interactive (piped/CI): warn instead of hanging on a prompt.
  if (!process.stdin.isTTY) {
    warn(`${REGOLO_API_KEY_ENV} is not set; the hosted classifier falls back to "medium" until you set it.`);
    return;
  }

  if (announce) info(announce);

  // needs-key: mode is already API, only the key is missing. Keep it a plain
  // key prompt (no need to re-ask local vs api). needs-choice: ask the full
  // question with API preselected.
  let mode: 'local' | 'api';
  if (status === 'needs-key') {
    mode = 'api';
  } else {
    const choice = await p.select({
      message: 'Where should the complexity classifier run?',
      initialValue: 'api' as 'api' | 'local',
      options: [
        { value: 'api', label: 'API (hosted on Regolo)', hint: 'no GPU, needs an API key' },
        { value: 'local', label: 'Local (Docker sidecar)', hint: 'Qwen3.5-0.8B, ~1.6GB VRAM' },
      ],
    });
    if (p.isCancel(choice)) return;
    mode = choice as 'local' | 'api';
  }

  if (mode === 'local') {
    p.note(LOCAL_DISCLAIMER, 'Local inference');
    await runCompute('local', undefined, (code) => process.exit(code));
    return;
  }

  // api: ask for the key (blank allowed: router falls back to "medium").
  p.note(REGOLO_API_KEY_HELP, 'Regolo API key');
  const token = await p.password({ message: 'Regolo API key (leave blank to skip for now)' });
  if (p.isCancel(token)) return;
  const key = String(token ?? '').trim();
  if (key === '') {
    warn(`No key entered; routing falls back to "medium" until you set one.`);
    return;
  }
  await runCompute('api', { token: key }, (code) => process.exit(code));
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/cli && npm run lint`
Expected: PASS (no type errors). If `runCompute`'s `exit` param type complains, it is `(code: number) => never`; `(code) => process.exit(code)` satisfies it.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/lib/config/regolo-key.ts
git commit -m "feat(cli): ensureClassifierCompute prompts local vs api on first run"
```

---

### Task 3: Wire `ensureClassifierCompute` into `claude on` and `codex on`

Swap the call sites from the old helper to the new one. Keep `ensureRegoloClassifierKey` exported for now to avoid breaking any other importer, but the two `on` commands use the new helper.

**Files:**
- Modify: `apps/cli/src/commands/claude/on.ts:8,48`
- Modify: `apps/cli/src/commands/codex/on.ts:15,39`

**Interfaces:**
- Consumes: `ensureClassifierCompute` (Task 2).

- [ ] **Step 1: Confirm no other importer depends on the old helper**

Run: `cd apps/cli && grep -rn "ensureRegoloClassifierKey" src/`
Expected: only `src/lib/config/regolo-key.ts` (definition) and the two `on.ts` files. If more appear, update them too in this task.

- [ ] **Step 2: Update `claude/on.ts`**

Change the import on line 8 of `apps/cli/src/commands/claude/on.ts`:

```typescript
import { ensureClassifierCompute } from '../../lib/config/regolo-key.js';
```

Change the call (lines ~48-51) from `ensureRegoloClassifierKey(...)` to:

```typescript
    await ensureClassifierCompute(
      profile!,
      justCreated ? 'Set up the complexity classifier for this profile.' : undefined,
    );
```

- [ ] **Step 3: Update `codex/on.ts`**

Change the import on line 15 of `apps/cli/src/commands/codex/on.ts`:

```typescript
import { ensureClassifierCompute } from '../../lib/config/regolo-key.js';
```

The codex command has no `justCreated` flag (its `ensureDefaultCodexProfile` is idempotent and it always passes a fixed announce). Replace the `ensureRegoloClassifierKey(profile, '...')` call (lines ~39-42) with:

```typescript
    await ensureClassifierCompute(
      profile,
      'Set up the complexity classifier for this Codex profile.',
    );
```

Since `announce` prints only when the classifier is unconfigured (the helper returns early when configured), passing it unconditionally here is fine: on a configured profile the helper no-ops before reaching the `info(announce)` line.

- [ ] **Step 4: Verify build + full test suite**

Run: `cd apps/cli && npm run lint && npx vitest run`
Expected: PASS (all existing tests plus the 5 new ones from Task 1).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/claude/on.ts apps/cli/src/commands/codex/on.ts
git commit -m "feat(cli): use ensureClassifierCompute in claude/codex on"
```

---

### Task 4: Manual end-to-end verification

Not code; a checklist to run before considering the feature done. No commit unless a fix is needed.

- [ ] **Step 1: Fresh profile shows the choice**

```bash
cd apps/cli && npm run build
mv ~/.brick/profiles/claude ~/.brick/profiles/claude.bak 2>/dev/null || true
./bin/run.js claude on
```
Expected: a `select` appears, "Where should the complexity classifier run?", with **API (hosted on Regolo)** preselected.

- [ ] **Step 2: API + valid key configures it**

Pick API, paste a real `REGOLO_API_KEY`. Expected: key saved to `~/.brick/profiles/claude/.env`, router starts.
Run `./bin/run.js claude on` again. Expected: NO prompt (status `configured`).

- [ ] **Step 3: API + blank key re-prompts**

Restore a fresh profile, run `claude on`, pick API, leave the key blank. Expected: warning about "medium" fallback.
Run `claude on` again. Expected: the choice/key prompt reappears (status `needs-key`).

- [ ] **Step 4: Local path**

Fresh profile, `claude on`, pick Local. Expected: `LOCAL_DISCLAIMER` note, compose regenerated with the classifier sidecar. Run `claude on` again. Expected: no prompt (local is `configured`).

- [ ] **Step 5: Non-TTY does not hang**

```bash
echo | ./bin/run.js claude on
```
Expected: no hang; a warning that `REGOLO_API_KEY` is not set. Exit promptly.

- [ ] **Step 6: Restore your real profile**

```bash
rm -rf ~/.brick/profiles/claude && mv ~/.brick/profiles/claude.bak ~/.brick/profiles/claude 2>/dev/null || true
```

---

## Self-Review

- **Spec coverage:** first-run prompt (Task 2/3), "until configured" via `needs-key`/`needs-choice` re-prompt (Task 1 status + Task 2), API preselected (`initialValue: 'api'`, Task 2), key prompt on API (Task 2), local disclaimer + switch (Task 2 reusing `runCompute`), Claude + Codex (Task 3), non-TTY safe (Task 2). All covered.
- **Placeholder scan:** none; all steps carry real code/commands. Codex has no `justCreated` flag, so Task 3 Step 3 passes a fixed announce (safe: the helper returns before printing it when the profile is already configured).
- **Type consistency:** `ClassifierComputeStatus` values (`configured`/`needs-key`/`needs-choice`) used identically in Tasks 1-2; `runCompute(mode, api, exit)` signature matches `runSettings.ts`; `ComputeMode` is `'local' | 'api'`.
