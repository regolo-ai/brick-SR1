import { isRegoloEndpoint } from './credentials.js';

export const REGOLO_CLASSIFIER_URL = 'https://api.regolo.ai';
export const REGOLO_CLASSIFIER_MODEL = 'brick-complexity-pro';
export const REGOLO_API_KEY_ENV = 'REGOLO_API_KEY';
export type ComputeMode = 'api';

/** Configure the classifier API, keeping its two routing consumers in sync. */
export function applyComputeToConfig(
  obj: any,
  mode: ComputeMode,
  api?: { baseUrl?: string; model?: string; protocol?: 'brick' | 'openai' }
): void {
  if (mode !== 'api') throw new Error('Local complexity inference was retired; configure the classifier API.');
  const apiBaseUrl = api?.baseUrl || REGOLO_CLASSIFIER_URL;
  const apiModel = api?.model || REGOLO_CLASSIFIER_MODEL;
  const apiBearer = '${' + (isRegoloEndpoint(apiBaseUrl) ? REGOLO_API_KEY_ENV : 'COMPLEXITY_API_KEY') + '}';

  const cs = (obj.complexity_service && typeof obj.complexity_service === 'object')
    ? obj.complexity_service
    : {};
  cs.enabled = true;
  cs.base_url = apiBaseUrl;
  cs.protocol = api?.protocol ?? 'openai';
  cs.model_name = apiModel;
  cs.bearer_token = apiBearer;
  delete cs.auto_spawn;
  obj.complexity_service = cs;

  // The skill router's complexity_model.base_url takes precedence in Go, so
  // keep it in sync when the block exists.
  const cm = obj.skill_router?.complexity_model;
  if (cm && typeof cm === 'object') {
    cm.base_url = cs.base_url;
    cm.protocol = cs.protocol;
    cm.model_name = apiModel;
    cm.bearer_token = apiBearer;
  }
}
