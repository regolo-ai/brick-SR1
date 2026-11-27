import { MultiSelectPrompt, Prompt } from '@clack/core';
import * as clack from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';
import pc from 'picocolors';

export * from '@clack/prompts';

type PromptOption<Value> = {
  value: Value;
  label?: string;
  hint?: string;
};

type PromptTransport = {
  /** Optional streams are useful for embedding and prompt-level tests. */
  input?: Readable;
  output?: Writable;
};

const MARKERS = {
  selected: '■',
  unselected: '□',
} as const;

function optionLabel<Value>(option: PromptOption<Value>): string {
  return option.label ?? String(option.value);
}

function optionLine<Value>(option: PromptOption<Value>, selected: boolean, focused: boolean): string {
  const marker = selected ? pc.cyan(MARKERS.selected) : pc.dim(MARKERS.unselected);
  const label = focused ? pc.cyan(pc.bold(optionLabel(option))) : pc.dim(optionLabel(option));
  const hint = option.hint ? ` ${pc.dim(`(${option.hint})`)}` : '';
  return `${marker} ${label}${hint}`;
}

function visibleOptions<Value>(options: PromptOption<Value>[], cursor: number, maxItems?: number): Array<[PromptOption<Value>, number]> {
  const limit = Math.max(maxItems ?? options.length, 1);
  if (options.length <= limit) return options.map((option, index) => [option, index]);
  const start = Math.max(0, Math.min(cursor - Math.floor(limit / 2), options.length - limit));
  return options.slice(start, start + limit).map((option, index) => [option, start + index]);
}

function promptHeader(state: Prompt['state'], message: string): string {
  const symbol = state === 'cancel' ? pc.red('■') : state === 'submit' ? pc.cyan('◇') : pc.cyan('◆');
  return `${pc.gray('│')}\n${symbol}  ${message}\n`;
}

/** Single-choice prompts use the filled square as their focus indicator. */
export function select<Value>(opts: clack.SelectOptions<Value> & PromptTransport): Promise<Value | symbol> {
  let cursor = opts.options.findIndex((option) => option.value === opts.initialValue);
  if (cursor < 0) cursor = 0;

  const prompt = new Prompt({
    input: opts.input,
    output: opts.output,
    initialValue: undefined,
    render() {
      const state = this.state;
      const lines = visibleOptions(opts.options, cursor, opts.maxItems)
        .map(([option, index]) => optionLine(option, index === cursor, index === cursor));
      const body = lines.join(`\n${pc.cyan('│')}  `);

      if (state === 'submit') {
        const option = opts.options[cursor];
        return `${promptHeader(state, opts.message)}${pc.gray('│')}  ${optionLine(option, true, false)}`;
      }
      if (state === 'cancel') {
        return `${promptHeader(state, opts.message)}${pc.gray('│')}  ${pc.strikethrough(pc.dim(optionLabel(opts.options[cursor])))}`;
      }
      if (state === 'error') {
        return `${promptHeader(state, opts.message)}${pc.yellow('│')}  ${body}\n${pc.yellow('└')}  ${pc.yellow(this.error)}`;
      }
      return `${promptHeader(state, opts.message)}${pc.cyan('│')}  ${body}\n${pc.cyan('└')}`;
    },
  }, false);

  prompt.value = opts.options[cursor]?.value;
  prompt.on('cursor', (action) => {
    switch (action) {
      case 'left':
      case 'up':
        cursor = cursor === 0 ? opts.options.length - 1 : cursor - 1;
        break;
      case 'down':
      case 'right':
        cursor = cursor === opts.options.length - 1 ? 0 : cursor + 1;
        break;
    }
    prompt.value = opts.options[cursor]?.value;
  });

  return prompt.prompt() as Promise<Value | symbol>;
}

export function multiselect<Value>(opts: clack.MultiSelectOptions<Value> & PromptTransport): Promise<Value[] | symbol> {
  const prompt = new MultiSelectPrompt({
    input: opts.input,
    output: opts.output,
    options: opts.options,
    initialValues: opts.initialValues,
    cursorAt: opts.cursorAt,
    required: opts.required ?? true,
    validate(values) {
      return opts.required !== false && values.length === 0
        ? 'Select at least one option with Space before confirming.'
        : undefined;
    },
    render() {
      const lines = visibleOptions(this.options, this.cursor, opts.maxItems)
        .map(([option, index]) => optionLine(option, this.value.includes(option.value), index === this.cursor));
      const body = lines.join(`\n${pc.cyan('│')}  `);
      const state = this.state;

      if (state === 'submit') {
        const selected = this.options.filter((option) => this.value.includes(option.value));
        return `${promptHeader(state, opts.message)}${pc.gray('│')}  ${selected.map((option) => optionLine(option, true, false)).join(pc.dim(', ')) || pc.dim('none')}`;
      }
      if (state === 'cancel') {
        const selected = this.options.filter((option) => this.value.includes(option.value));
        return `${promptHeader(state, opts.message)}${pc.gray('│')}  ${pc.strikethrough(pc.dim(selected.map(optionLabel).join(', ')))}`;
      }
      if (state === 'error') {
        return `${promptHeader(state, opts.message)}${pc.yellow('│')}  ${body}\n${pc.yellow('└')}  ${pc.yellow(this.error)}`;
      }
      return `${promptHeader(state, opts.message)}${pc.cyan('│')}  ${body}\n${pc.cyan('└')}`;
    },
  });

  return prompt.prompt() as Promise<Value[] | symbol>;
}

export const squareMarkers = MARKERS;
