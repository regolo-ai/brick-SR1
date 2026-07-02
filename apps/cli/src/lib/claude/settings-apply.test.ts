import { describe, it, expect } from 'vitest';
import {
  applyComputeToConfig,
  LOCAL_CLASSIFIER_URL,
  REGOLO_CLASSIFIER_URL,
  REGOLO_CLASSIFIER_MODEL,
} from './settings-apply.js';

const REGOLO_BEARER = '${REGOLO_API_KEY}';

function baseConfig(): any {
  return {
    complexity_service: {
      enabled: true,
      base_url: LOCAL_CLASSIFIER_URL,
      bearer_token: '${BRICK_CLASSIFIER_TOKEN}',
      auto_spawn: true,
    },
    skill_router: {
      complexity_model: {
        model_id: 'regolo/brick-complexity-pro',
        timeout_seconds: 8,
      },
    },
  };
}

describe('applyComputeToConfig — api (Regolo hosted)', () => {
  it('points complexity_service at the hosted Regolo classifier with an env-ref token', () => {
    const obj = baseConfig();
    applyComputeToConfig(obj, 'api');

    const cs = obj.complexity_service;
    expect(cs.enabled).toBe(true);
    expect(cs.base_url).toBe(REGOLO_CLASSIFIER_URL);
    expect(cs.protocol).toBe('openai');
    expect(cs.model_name).toBe(REGOLO_CLASSIFIER_MODEL);
    // The literal key must never be inlined — only the env reference.
    expect(cs.bearer_token).toBe(REGOLO_BEARER);
    expect(cs.auto_spawn).toBe(false);
  });

  it('mirrors the api settings onto skill_router.complexity_model', () => {
    const obj = baseConfig();
    applyComputeToConfig(obj, 'api');

    const cm = obj.skill_router.complexity_model;
    expect(cm.base_url).toBe(REGOLO_CLASSIFIER_URL);
    expect(cm.protocol).toBe('openai');
    expect(cm.model_name).toBe(REGOLO_CLASSIFIER_MODEL);
    expect(cm.bearer_token).toBe(REGOLO_BEARER);
  });

  it('allows overriding base_url/model for an advanced custom endpoint', () => {
    const obj = baseConfig();
    applyComputeToConfig(obj, 'api', { baseUrl: 'https://custom.example.com', model: 'my-model' });

    expect(obj.complexity_service.base_url).toBe('https://custom.example.com');
    expect(obj.complexity_service.model_name).toBe('my-model');
    // token is still the env ref regardless of custom endpoint
    expect(obj.complexity_service.bearer_token).toBe(REGOLO_BEARER);
  });
});

describe('applyComputeToConfig — local', () => {
  it('points at the local classifier and strips the api-only fields', () => {
    const obj = baseConfig();
    // First make it "api" so the api-only fields are present...
    applyComputeToConfig(obj, 'api');
    // ...then switch back to local and confirm they are removed.
    applyComputeToConfig(obj, 'local');

    const cs = obj.complexity_service;
    expect(cs.base_url).toBe(LOCAL_CLASSIFIER_URL);
    expect(cs.auto_spawn).toBe(true);
    expect(cs.protocol).toBeUndefined();
    expect(cs.model_name).toBeUndefined();
    expect(cs.bearer_token).toBeUndefined();

    const cm = obj.skill_router.complexity_model;
    expect(cm.base_url).toBe(LOCAL_CLASSIFIER_URL);
    expect(cm.protocol).toBeUndefined();
    expect(cm.model_name).toBeUndefined();
    expect(cm.bearer_token).toBeUndefined();
  });

  it('does not crash when skill_router.complexity_model is absent', () => {
    const obj: any = { complexity_service: { enabled: true } };
    expect(() => applyComputeToConfig(obj, 'api')).not.toThrow();
    expect(obj.complexity_service.base_url).toBe(REGOLO_CLASSIFIER_URL);
  });
});
