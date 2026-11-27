// >>> brick opencode managed plugin (do not edit) >>>
// OpenCode V2 server plugin shipped by the Brick CLI. It refreshes the model
// inventory of the already-configured `brick` provider from the local router's
// `/v1/models` endpoint. It never registers a provider: the CLI owns the
// managed `provider.brick` block in opencode.json.
import { Model, Plugin, Provider } from "@opencode/plugin";

const PROVIDER_ID = "brick";
const REFRESH_TIMEOUT_MS = 3000;

function routerBaseURL(provider) {
  const settings = provider && provider.settings;
  if (settings && typeof settings.baseURL === "string") return settings.baseURL;
  return undefined;
}

function modelEntries(body) {
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.models)) return body.models;
  return [];
}

/**
 * Read the configured `brick` provider, fetch `<baseURL>/models` and replace its
 * source model inventory. `fetchImpl` is injectable so callers (and tests) can
 * supply their own fetch without touching the network.
 */
export async function refreshBrickModels(ctx, fetchImpl = globalThis.fetch) {
  const provider = await ctx.provider.get({ providerID: PROVIDER_ID });
  if (!provider) return; // the provider is configured by the CLI; nothing to refresh yet
  const baseURL = routerBaseURL(provider);
  if (!baseURL) return;

  const url = `${baseURL.replace(/\/+$/, "")}/models`;
  const options = {};
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    options.signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
  }
  const response = await fetchImpl(url, options);
  if (!response || !response.ok) {
    throw new Error(`GET ${url} failed with status ${response ? response.status : "unknown"}`);
  }
  const body = await response.json();

  const ids = [];
  for (const entry of modelEntries(body)) {
    const id = entry && (entry.id || entry.slug);
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return;

  const providerID = Provider.ID.make(PROVIDER_ID);
  const models = ids.map((id) => ({ ...Model.Info.default(providerID, Model.ID.make(id)), name: id }));
  await ctx.provider.transform((editor) => {
    editor.models.set(PROVIDER_ID, models);
  });
}

export default Plugin.define({
  id: 'brick',
  async setup(ctx) {
    try {
      await refreshBrickModels(ctx);
    } catch (error) {
      // A stopped router must never block OpenCode startup.
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[brick] could not refresh models from the router: ${reason}`);
    }
  },
});
