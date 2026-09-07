import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RichTextInterface } from '@remnote/plugin-sdk';
import { resetInitializedModule, setInitializedModule } from '../math/converter';
import {
  EditorSession,
  parseSessionDescriptor,
  type EditorSessionHost,
  type PopupSessionDescriptor,
  type SessionEffects,
} from './editor-session';

beforeEach(() => {
  resetInitializedModule();
});

afterEach(() => {
  resetInitializedModule();
  vi.useRealTimers();
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

  let currentText: RichTextInterface = options.remText ? [...options.remText] : [];

  const host: EditorSessionHost = {
    openRem: async () => {
      calls.opened += 1;
      if (options.missing) return undefined;
      return {
        get text() {
          return currentText;
        },
        write: async (text) => {
          if (options.failWrite) throw new Error('write failed');
          currentText = [...text];
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

  it('rejects inverted, negative, and non-integer ranges', () => {
    expect(
      parseSessionDescriptor({ target: { remId: 'r', range: { start: 5, end: 2 } } }),
    ).toBeUndefined();
    expect(
      parseSessionDescriptor({ target: { remId: 'r', range: { start: -1, end: 2 } } }),
    ).toBeUndefined();
    expect(
      parseSessionDescriptor({ target: { remId: 'r', range: { start: 1.5, end: 2 } } }),
    ).toBeUndefined();
    expect(
      parseSessionDescriptor({ target: { remId: 'r', range: { start: NaN, end: 2 } } }),
    ).toBeUndefined();
    expect(
      parseSessionDescriptor({ target: { remId: '', range: { start: 0, end: 0 } } }),
    ).toBeUndefined();
  });
});

describe('EditorSession save flow', () => {
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

  it('does not treat save as no-op if block mode was toggled even if source is unchanged', async () => {
    const { host, calls } = makeHost();
    const { effects } = makeEffects();
    const session = new EditorSession(
      host,
      effects,
      makeDescriptor({ initialSource: 'x', isBlock: false }),
    );

    session.isBlock = true;
    await session.save();

    expect(calls.dismissed).toBe(1);
    expect(calls.latex).toEqual(['x']);
    expect(calls.writes).toEqual([[{ i: 'x', text: 'x', block: true }]]);
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

describe('EditorSession live preview and rollback', () => {
  it('debounces rapid typing into a single on-the-fly live write', async () => {
    vi.useFakeTimers();
    const { host, calls } = makeHost({ remText: ['intro '] });
    const { effects } = makeEffects();
    const session = new EditorSession(
      host,
      effects,
      makeDescriptor({
        target: { remId: 'rem-1', range: { start: 6, end: 6 } },
        isEditing: false,
        initialSource: '',
      }),
    );

    session.setSource('x');
    session.setSource('x +');
    session.setSource('x + y');

    expect(calls.writes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(80);

    expect(calls.writes).toHaveLength(1);
    expect(calls.writes[0]).toEqual(['intro ', { i: 'x', text: 'x + y', block: false }]);
  });

  it('ignores incomplete Typst syntax silently during live updates', async () => {
    const { host, calls } = makeHost({ remText: ['intro '] });
    const { effects } = makeEffects();
    const session = new EditorSession(
      host,
      effects,
      makeDescriptor({
        target: { remId: 'rem-1', range: { start: 6, end: 6 } },
        isEditing: false,
        initialSource: '',
      }),
    );

    session.setSource('x');
    await session.flushLiveUpdate();
    expect(calls.writes).toHaveLength(1);

    // Typing unclosed matrix function call (incomplete syntax)
    session.setSource('mat(1, 2');
    await session.flushLiveUpdate();

    // No new write, no error toast thrown
    expect(calls.writes).toHaveLength(1);
    expect(calls.toasts).toHaveLength(0);
  });

  it('reverts the Rem to the original state when cancelled after live updates', async () => {
    const originalText: RichTextInterface = ['intro ', ' outro'];
    const { host, calls } = makeHost({ remText: originalText });
    const { effects } = makeEffects();
    const session = new EditorSession(
      host,
      effects,
      makeDescriptor({
        target: { remId: 'rem-1', range: { start: 6, end: 6 } },
        isEditing: false,
        initialSource: '',
      }),
    );

    session.setSource('alpha + beta');
    await session.flushLiveUpdate();

    expect(calls.writes).toHaveLength(1);
    expect(calls.writes[0]).toEqual([
      'intro ',
      { i: 'x', text: String.raw`\alpha + \beta`, block: false },
      ' outro',
    ]);

    // User hits Escape / Cancel
    await session.dismiss();

    expect(calls.dismissed).toBe(1);
    expect(calls.writes.at(-1)).toEqual(originalText);
  });

  it('reverts edited math back to its pristine original state on cancel', async () => {
    const pristineMath = { i: 'x' as const, text: 'a_0', block: false };
    const originalText: RichTextInterface = ['pre ', pristineMath, ' post'];
    const { host, calls } = makeHost({ remText: originalText });
    const { effects } = makeEffects();
    const session = new EditorSession(
      host,
      effects,
      makeDescriptor({
        target: { remId: 'rem-1', range: { start: 4, end: 5 } },
        isEditing: true,
        initialSource: 'a_0',
      }),
    );

    session.setSource('b_1 + c_2');
    await session.flushLiveUpdate();

    expect(calls.writes).toHaveLength(1);
    expect(calls.writes[0]).toEqual(['pre ', { i: 'x', text: 'b_1 + c_2', block: false }, ' post']);

    // Cancel
    await session.dismiss();

    expect(calls.dismissed).toBe(1);
    expect(calls.writes.at(-1)).toEqual(originalText);
  });

  it('commits verified math on save and does not roll back on subsequent dismissal', async () => {
    const originalText: RichTextInterface = ['intro '];
    const { host, calls } = makeHost({ remText: originalText });
    const { effects } = makeEffects();
    const session = new EditorSession(
      host,
      effects,
      makeDescriptor({
        target: { remId: 'rem-1', range: { start: 6, end: 6 } },
        isEditing: false,
        initialSource: '',
      }),
    );

    session.setSource('x^2');
    await session.save();

    expect(calls.dismissed).toBe(1);
    expect(calls.writes[0]).toEqual(['intro ', { i: 'x', text: 'x^2', block: false }]);

    // Dismissal after save does not revert
    await session.dismiss();
    expect(calls.writes).toHaveLength(1);
  });

  it('removes previewed math when user clears input during insertion', async () => {
    const originalText: RichTextInterface = ['start'];
    const { host, calls } = makeHost({ remText: originalText });
    const { effects } = makeEffects();
    const session = new EditorSession(
      host,
      effects,
      makeDescriptor({
        target: { remId: 'rem-1', range: { start: 5, end: 5 } },
        isEditing: false,
        initialSource: '',
      }),
    );

    session.setSource('x');
    await session.flushLiveUpdate();
    expect(calls.writes).toHaveLength(1);

    // User deletes everything
    session.setSource('');
    await session.flushLiveUpdate();

    expect(calls.writes).toHaveLength(2);
    expect(calls.writes[1]).toEqual(originalText);
  });

  it('live-toggles block mode immediately when live math is active', async () => {
    const { host, calls } = makeHost({ remText: ['pre '] });
    const { effects } = makeEffects();
    const session = new EditorSession(
      host,
      effects,
      makeDescriptor({
        target: { remId: 'rem-1', range: { start: 4, end: 4 } },
        isEditing: false,
        initialSource: '',
      }),
    );

    session.setSource('x');
    await session.flushLiveUpdate();
    expect(calls.writes).toHaveLength(1);
    expect(calls.writes[0][1]).toMatchObject({ block: false });

    await session.toggleBlock(true);
    expect(calls.writes).toHaveLength(2);
    expect(calls.writes[1][1]).toMatchObject({ block: true });
  });
});

describe('EditorSession block-mode toggling', () => {
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

  it('reverts modified Rem on dispose when popup unmounts on outside click', async () => {
    const initialText = ['prefix '];
    const { host, calls } = makeHost({ remText: initialText });
    const { effects } = makeEffects();
    const session = new EditorSession(
      host,
      effects,
      makeDescriptor({ target: { remId: 'rem-1', range: { start: 7, end: 7 } } }),
    );

    session.setSource('x + y');
    await session.flushLiveUpdate();
    expect(calls.writes.length).toBeGreaterThan(0);

    session.dispose();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls.writes.at(-1)).toEqual(initialText);
  });

  it('restores initial Rem text when reverting back to initial source on save', async () => {
    const initialLatex = { i: 'x' as const, text: 'a + b', block: false };
    const initialText = ['pre ', initialLatex, ' post'];
    const { host, calls } = makeHost({ remText: initialText });
    const { effects } = makeEffects();
    const session = new EditorSession(
      host,
      effects,
      makeDescriptor({
        target: { remId: 'rem-1', range: { start: 4, end: 5 } },
        initialSource: 'a + b',
        isEditing: true,
      }),
    );

    session.setSource('x + y');
    await session.flushLiveUpdate();
    expect(calls.writes.length).toBeGreaterThan(0);

    session.setSource('a + b');
    await session.save();

    expect(calls.writes.at(-1)).toEqual(initialText);
    expect(calls.dismissed).toBe(1);
  });

  it('does not revert Rem text when disposed while save is in flight', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });

    const initialText = ['prefix '];
    const { calls } = makeHost({ remText: initialText });
    const { effects } = makeEffects();
    const host: EditorSessionHost = {
      openRem: async () => ({
        text: [...initialText],
        write: async (text) => {
          calls.writes.push(text);
          await writeGate;
        },
      }),
      createLatexElement: async (latex, isBlock) => [
        { i: 'x' as const, text: latex, block: isBlock },
      ],
      notify: async () => undefined,
      dismiss: async () => {
        calls.dismissed += 1;
      },
    };

    const session = new EditorSession(
      host,
      effects,
      makeDescriptor({ target: { remId: 'rem-1', range: { start: 7, end: 7 } } }),
    );

    session.setSource('x + y');
    const savePromise = session.save();
    session.dispose();
    releaseWrite();
    await savePromise;

    expect(calls.writes.at(-1)).not.toEqual(initialText);
  });
});
