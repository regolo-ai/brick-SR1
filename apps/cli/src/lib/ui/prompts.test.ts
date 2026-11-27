import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { multiselect, select } from './prompts.js';

function promptStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = '';
  const chunks: string[] = [];
  output.on('data', (chunk) => {
    const text = String(chunk);
    rendered += text;
    chunks.push(text);
  });
  return { input, output, rendered: () => rendered, chunks: () => chunks };
}

describe('square selection prompts', () => {
  it('renders exactly one filled square at the initial focus and no circular markers', async () => {
    const { input, output, rendered } = promptStreams();
    const answer = select({
      message: 'Pick one',
      options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }],
      input,
      output,
    });
    const initialFrame = rendered();
    expect(initialFrame.match(/[□■]/g)).toHaveLength(2);
    expect(initialFrame.match(/■/g)).toHaveLength(1);
    expect(initialFrame).not.toMatch(/[○●◯◉]/);

    input.write('\r');
    await expect(answer).resolves.toBe('one');

    expect(rendered()).toContain('■');
    expect(rendered()).toContain('□');
    expect(rendered()).not.toMatch(/[○●◯◉]/);
  });

  it('moves the filled square with focus and ignores Space as a selection action', async () => {
    const { input, output, chunks } = promptStreams();
    const answer = select({
      message: 'Pick one',
      options: [{ value: 'one' }, { value: 'two' }],
      input,
      output,
    });
    input.write(' ');
    input.write('\x1b[B');
    await new Promise((resolve) => setImmediate(resolve));
    const latestMenu = chunks().filter((chunk) => chunk.includes('□')).at(-1) ?? '';
    expect(latestMenu.match(/■/g)).toHaveLength(1);
    input.write('\r');
    await expect(answer).resolves.toBe('two');
  });

  it('uses initialValue only to set the initial focus and confirms it with Enter', async () => {
    const { input, output } = promptStreams();
    const answer = select({
      message: 'Pick one',
      options: [{ value: 'one' }, { value: 'two' }],
      initialValue: 'two',
      input,
      output,
    });
    input.write('\r');
    await expect(answer).resolves.toBe('two');
  });

  it('toggles multiple values with Space and returns their values unchanged', async () => {
    const { input, output } = promptStreams();
    const answer = multiselect({
      message: 'Pick many',
      options: [{ value: 'one' }, { value: 'two' }, { value: 'three' }],
      input,
      output,
    });
    input.write(' ');
    input.write('\x1b[B');
    input.write(' ');
    input.write('\r');
    await expect(answer).resolves.toEqual(['one', 'two']);
  });

  it('keeps multiple initial values selected until Enter confirms them', async () => {
    const { input, output, rendered } = promptStreams();
    const answer = multiselect({
      message: 'Pick many',
      options: [{ value: 'one' }, { value: 'two' }, { value: 'three' }],
      initialValues: ['one', 'three'],
      input,
      output,
    });
    expect(rendered().match(/■/g)).toHaveLength(2);
    expect(rendered()).not.toMatch(/[○●◯◉]/);
    input.write('\r');
    await expect(answer).resolves.toEqual(['one', 'three']);
  });
});
