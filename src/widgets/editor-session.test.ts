import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as tylax from '../../public/wasm/tylax.js';
import { initSync } from '../../public/wasm/tylax.js';
import type { RichTextInterface } from '@remnote/plugin-sdk';
import { setInitializedModule } from '../math/converter';
import {
  EditorSession,
  parseSessionDescriptor,
  type EditorSessionHost,
  type PopupSessionDescriptor,
  type SessionEffects,
} from './editor-session';

beforeAll(() => {
  initSync({
    module: readFileSync(resolve(process.cwd(), 'public/wasm/tylax_bg.wasm')),
  });
  setInitializedModule(tylax as any);
});

type HostCalls = {
  writes: RichTextInterface[];
  latex: string[];
  toasts: string[];
  dismissed: number;
  opened: number;
};

function makeHost(
  options: {
    remText?: RichTextInterface;
    missing?: boolean;
    failWrite?: boolean;
    gateLatex?: (release: () => void) => void;
  } = {},
): { host: EditorSessionHost; calls: HostCalls; releaseLatex: () => void } {
  const calls: HostCalls = {
    writes: [],
    latex: [],
    toasts: [],
    dismissed: 0,
    opened: 0,
  };

  let release!: () => void;
  const gated = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  options.gateLatex?.(release);

  const host: EditorSessionHost = {
    openRem: async () => {
      calls.opened += 1;
      if (options.missing) return undefined;
      return {
        text: options.remText ?? [],
        write: async (text) => {
          if (options.failWrite) throw new Error('write failed');
          calls.writes.push(text);
        },
      };
    },
    createLatexElement: async (latex, block) => {
      calls.latex.push(latex);
      if (options.gateLatex) await gated;
      // The real host returns a RichText array (see createNativeLatex).
      return [{ i: 'x', text: latex, block }];
    },
    notify: async (message) => {
      calls.toasts.push(message);
    },
    dismiss: async () => {
      calls.dismissed += 1;
    },
  };

  return { host, calls, releaseLatex: release };
}

function makeEffects() {
  const calls = {
    errors: [] as (string | undefined)[],
    pending: [] as boolean[],
    blocks: [] as boolean[],
  };
  const effects: SessionEffects = {
    onError: (message) => calls.errors.push(message),
    onPending: (pending) => calls.pending.push(pending),
    onBlockChanged: (block) => calls.blocks.push(block),
  };
  return { effects, calls };
}

function makeDescriptor(overrides: Partial<PopupSessionDescriptor> = {}): PopupSessionDescriptor {
  return {
    target: { remId: 'rem-1', range: { start: 0, end: 0 } },
    initialSource: 'x^2',
    isEditing: true,
    isBlock: false,
    ...overrides,
  };
}

describe('parseSessionDescriptor', () => {
  it('accepts well-formed handoff data and normalizes optional fields', () => {
    const descriptor = parseSessionDescriptor({
      target: { remId: 'r', range: { start: 1, end: 2 } },
      initialSource: 'x^2',
      isEditing: true,
      isBlock: false,
    });

    expect(descriptor).toEqual({
      target: { remId: 'r', range: { start: 1, end: 2 } },
      initialSource: 'x^2',
      isEditing: true,
      isBlock: false,
    });

    expect(parseSessionDescriptor({ target: { remId: 'r', range: { start: 0, end: 0 } } })).toEqual(
      {
        target: { remId: 'r', range: { start: 0, end: 0 } },
        initialSource: '',
        isEditing: false,
        isBlock: false,
      },
    );
  });

  it('rejects malformed or missing targets', () => {
    expect(parseSessionDescriptor(undefined)).toBeUndefined();
    expect(parseSessionDescriptor(null)).toBeUndefined();
    expect(parseSessionDescriptor({})).toBeUndefined();
    expect(parseSessionDescriptor({ target: { remId: 'r' } })).toBeUndefined();
    expect(
      parseSessionDescriptor({ target: { remId: 'r', range: { start: 'a', end: 0 } } }),
    ).toBeUndefined();
  });
});

describe('EditorSession save flow', () => {
  afterEach(() => {
    setInitializedModule(tylax as any);
  });

  it('closes without writing when an unchanged source is saved', async () => {
    const { host, calls } = makeHost();
    const { effects, calls: effectCalls } = makeEffects();
    const session = new EditorSession(host, effects, makeDescriptor());

    await session.save();

    expect(calls.dismissed).toBe(1);
    expect(calls.latex).toHaveLength(0);
    expect(calls.writes).toHaveLength(0);
    expect(calls.toasts).toHaveLength(0);
    expect(effectCalls.pending).toEqual([]);
  });

  it('blocks empty input with an inline error and stays open', async () => {
    const { host, calls } = makeHost();
    const { effects, calls: effectCalls } = makeEffects();
    const session = new EditorSession(host, effects, makeDescriptor());

    session.setSource('   ');
    await session.save();

    expect(effectCalls.errors.at(-1)).toBe('Enter a Typst math expression first.');
    expect(calls.dismissed).toBe(0);
  });

  it('writes verified math and dismisses after a successful save', async () => {
    const { host, calls } = makeHost();
    const { effects, calls: effectCalls } = makeEffects();
    const session = new EditorSession(host, effects, makeDescriptor());

    session.setSource('x + y');
    await session.save();

    expect(calls.writes[0]).toEqual([{ i: 'x', text: 'x + y', block: false }]);
    expect(calls.dismissed).toBe(1);
    expect(calls.toasts).toHaveLength(0);
    expect(effectCalls.errors.at(-1)).toBeUndefined();
    expect(effectCalls.pending.at(-1)).toBe(false);
  });

  it('keeps the editor open with a specific error when the Rem vanished', async () => {
    const { host, calls } = makeHost({ missing: true });
    const { effects, calls: effectCalls } = makeEffects();
    const session = new EditorSession(host, effects, makeDescriptor());

    session.setSource('x + y');
    await session.save();

    expect(effectCalls.errors.at(-1)).toMatch(/no longer available/);
    expect(calls.dismissed).toBe(0);
    expect(calls.toasts[0]).toContain('Typst math failed:');
  });

  it('reports round-trip instability instead of writing mutating LaTeX', async () => {
    setInitializedModule({
      default: async () => undefined,
      typstToLatex: (input: string) => input,
      latexToTypst: (input: string) => `${input}!`,
      detectFormat: () => 'latex',
    } as any);

    const { host, calls } = makeHost();
    const { effects, calls: effectCalls } = makeEffects();
    const session = new EditorSession(host, effects, makeDescriptor());

    session.setSource('A');
    await session.save();

    expect(calls.writes).toHaveLength(0);
    expect(calls.dismissed).toBe(0);
    expect(effectCalls.errors.at(-1)).toMatch(/edit cycle/);
  });

  it('ignores Enter while a save is already in flight', async () => {
    let latexCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });

    const host: EditorSessionHost = {
      openRem: async () => ({ text: [], write: async () => undefined }),
      createLatexElement: async (latex) => {
        latexCalls += 1;
        await gate;
        return [{ i: 'x' as const, text: latex, block: false }];
      },
      notify: async () => undefined,
      dismiss: async () => undefined,
    };
    const { effects } = makeEffects();
    const session = new EditorSession(host, effects, makeDescriptor());

    session.setSource('x + y');
    const first = session.save();
    const second = session.save();
    release();
    await Promise.all([first, second]);

    expect(latexCalls).toBe(1);
  });
});

describe('EditorSession block-mode toggling', () => {
  afterEach(() => {
    setInitializedModule(tylax as any);
  });

  const alignedElement = {
    i: 'x' as const,
    text: String.raw`\begin{aligned}x &= 1\end{aligned}`,
    block: false,
  };

  it('commits the block flag immediately in edit mode, preserving aligned', async () => {
    const { host, calls } = makeHost({ remText: ['pre ', alignedElement, ' post'] });
    const { effects, calls: effectCalls } = makeEffects();
    const session = new EditorSession(
      host,
      effects,
      makeDescriptor({ target: { remId: 'rem-1', range: { start: 4, end: 5 } }, isEditing: true }),
    );

    await session.toggleBlock(true);

    expect(session.isBlock).toBe(true);
    expect(effectCalls.blocks.at(-1)).toBe(true);
    expect(calls.writes[0]).toEqual([
      'pre ',
      { i: 'x', text: String.raw`\begin{aligned}x &= 1\end{aligned}`, block: true },
      ' post',
    ]);
    expect(calls.dismissed).toBe(0);
  });

  it('rolls the toggle back when the commit fails', async () => {
    const { host, calls } = makeHost({
      remText: ['pre ', alignedElement, ' post'],
      failWrite: true,
    });
    const { effects, calls: effectCalls } = makeEffects();
    const session = new EditorSession(
      host,
      effects,
      makeDescriptor({ target: { remId: 'rem-1', range: { start: 4, end: 5 } }, isEditing: true }),
    );

    await session.toggleBlock(true);

    expect(session.isBlock).toBe(false);
    expect(effectCalls.blocks).toEqual([true, false]);
    expect(calls.writes).toHaveLength(0);
    expect(calls.toasts[0]).toContain('Typst math failed:');
  });

  it('only flips the flag outside edit mode without touching the Rem', async () => {
    const { host, calls } = makeHost();
    const { effects, calls: effectCalls } = makeEffects();
    const session = new EditorSession(host, effects, makeDescriptor({ isEditing: false }));

    await session.toggleBlock(true);

    expect(session.isBlock).toBe(true);
    expect(effectCalls.blocks).toEqual([true]);
    expect(calls.opened).toBe(0);
    expect(calls.writes).toHaveLength(0);
  });
});
