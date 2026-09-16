import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { SquareAutocomplete, SquareMultiAutocomplete } from '../config/editor.js';

const choices = [
  { name: 'alpha', message: 'Alpha model' },
  { name: 'beta', message: 'Beta model' },
  { name: 'gamma', message: 'Gamma model' },
];

async function makePrompt(PromptClass: any, options: Record<string, unknown>): Promise<any> {
  const prompt = new PromptClass({
    name: 'value',
    message: 'Choose',
    choices: choices.map((choice) => ({ ...choice })),
    show: false,
    stdout: new PassThrough(),
    symbols: { indicator: { on: '■', off: '□' }, prefix: ' ' },
    ...options,
  });
  await prompt.initialize();
  return prompt;
}

describe('searchable square menus', () => {
  it('makes the single-select filled square follow focus and submits on Enter', async () => {
    const prompt = await makePrompt(SquareAutocomplete, { multiple: false, initial: 1 });
    expect(prompt.choices.map((choice: any) => prompt.indicator(choice))).toEqual(['□', '■', '□']);

    await prompt.down();
    expect(prompt.focused.name).toBe('gamma');
    expect(prompt.choices.map((choice: any) => prompt.indicator(choice))).toEqual(['□', '□', '■']);
    expect(await prompt.renderChoice(prompt.focused, prompt.index)).toContain('│');

    const enabledBeforeSpace = prompt.choices.map((choice: any) => choice.enabled);
    await prompt.space(' ');
    expect(prompt.choices.map((choice: any) => choice.enabled)).toEqual(enabledBeforeSpace);

    const submitted = new Promise((resolve) => prompt.once('submit', resolve));
    await prompt.submit();
    await expect(submitted).resolves.toBe('gamma');
  });

  it('filters and restores single-select choices without creating selection state', async () => {
    const prompt = await makePrompt(SquareAutocomplete, { multiple: false, initial: 0 });
    await prompt.append('g');
    await prompt.append('a');
    await prompt.append('m');
    expect(prompt.choices.map((choice: any) => choice.name)).toEqual(['gamma']);
    expect(prompt.indicator(prompt.focused)).toContain('■');

    await prompt.delete();
    await prompt.delete();
    await prompt.delete();
    expect(prompt.choices.map((choice: any) => choice.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('keeps multiple selections while filtering and only toggles them with Space', async () => {
    const prompt = await makePrompt(SquareMultiAutocomplete, {
      multiple: true,
      initial: ['alpha', 'gamma'],
    });
    expect(prompt.choices.map((choice: any) => prompt.indicator(choice))).toEqual(['■', '□', '■']);
    expect(await prompt.renderChoice(prompt.focused, prompt.index)).toContain('│');

    await prompt.down();
    await prompt.space();
    expect(prompt.selected.map((choice: any) => choice.name)).toEqual(['alpha', 'beta', 'gamma']);

    await prompt.append('g');
    await prompt.append('a');
    await prompt.append('m');
    expect(prompt.choices.map((choice: any) => choice.name)).toEqual(['gamma']);
    expect(prompt.selected.map((choice: any) => choice.name)).toEqual(['alpha', 'beta', 'gamma']);
    await prompt.delete();
    await prompt.delete();
    await prompt.delete();
    expect(prompt.selected.map((choice: any) => choice.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('never renders circular selection markers', async () => {
    const single = await makePrompt(SquareAutocomplete, { multiple: false });
    const multiple = await makePrompt(SquareMultiAutocomplete, { multiple: true });
    const markers = [single, multiple]
      .flatMap((prompt) => prompt.choices.map((choice: any) => prompt.indicator(choice)))
      .join('');
    expect(markers).not.toMatch(/[○●◯◉]/);
  });
});
