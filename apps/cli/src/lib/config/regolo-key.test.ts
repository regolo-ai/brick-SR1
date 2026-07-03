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
