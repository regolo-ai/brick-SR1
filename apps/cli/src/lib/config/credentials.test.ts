import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateCredential } from './credentials.js';

describe('credential validation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the OpenAI-compatible models probe and never leaks the token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await validateCredential('https://example.test/v1', 'top-secret');
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer top-secret' },
    }));
  });

  it('uses Anthropic native headers and endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await validateCredential('https://api.anthropic.com', 'top-secret', 'anthropic');
    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', expect.objectContaining({
      headers: { 'x-api-key': 'top-secret', 'anthropic-version': '2023-06-01' },
    }));
  });

  it.each([401, 403])('sanitizes rejected-key errors (%i)', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
    await expect(validateCredential('https://example.test/v1', 'top-secret')).rejects.toThrow(status === 401 ? 'API key was rejected' : 'Access to the configured model was denied');
    await expect(validateCredential('https://example.test/v1', 'top-secret')).rejects.not.toThrow('top-secret');
  });

  it('blocks malformed responses and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await expect(validateCredential('https://example.test/v1', 'top-secret')).rejects.toThrow('Invalid response');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout top-secret')));
    await expect(validateCredential('https://example.test/v1', 'top-secret')).rejects.toThrow('Could not reach');
  });
});

describe('Regolo authenticated model validation', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('probes the selected model instead of the public catalog', async () => {
    const probe = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] })));
    vi.stubGlobal('fetch', probe);
    await validateCredential('https://api.regolo.ai/v1', 'secret', 'openai', 'configured-model');
    expect(probe).toHaveBeenCalledWith('https://api.regolo.ai/v1/chat/completions', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      body: JSON.stringify({ model: 'configured-model', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false }),
    }));
  });
  it.each([[401, 'rejected'], [403, 'Access'], [404, 'unavailable'], [429, 'quota'], [402, 'quota']])('sanitizes HTTP %s', async (status, reason) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('secret', { status: Number(status) }))));
    await expect(validateCredential('https://api.regolo.ai', 'secret', 'openai', 'model')).rejects.toThrow(String(reason));
    await expect(validateCredential('https://api.regolo.ai', 'secret', 'openai', 'model')).rejects.not.toThrow('secret');
  });
});
