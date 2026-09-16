import { describe, it, expect } from 'vitest';
import {
  applyComputeToConfig,
  REGOLO_CLASSIFIER_URL,
  REGOLO_CLASSIFIER_MODEL,
} from './classifier.js';

const REGOLO_BEARER = '${REGOLO_API_KEY}';

function baseConfig(): any {
  return {
    complexity_service: {
      enabled: true,
      base_url: 'http://127.0.0.1:8094',
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
    expect(cs.auto_spawn).toBeUndefined();
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
    // Custom classifiers retain an independent credential.
    expect(obj.complexity_service.bearer_token).toBe('${COMPLEXITY_API_KEY}');
  });
});

describe('applyComputeToConfig — local', () => {
  it('rejects the retired local mode before changing the profile', () => {
    const obj = baseConfig();
    const before = structuredClone(obj);
    expect(() => applyComputeToConfig(obj, 'local' as any)).toThrow('retired');
    expect(obj).toEqual(before);
  });

  it('does not crash when skill_router.complexity_model is absent', () => {
    const obj: any = { complexity_service: { enabled: true } };
    expect(() => applyComputeToConfig(obj, 'api')).not.toThrow();
    expect(obj.complexity_service.base_url).toBe(REGOLO_CLASSIFIER_URL);
  });
});
