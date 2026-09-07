import type { RichTextInterface } from '@remnote/plugin-sdk';
import { initializeConverter, typstToLatex, typstToVerifiedLatex } from '../math/converter';
import {
  findMathElementAtRange,
  insertRichTextAtRange,
  setMathBlockAtRange,
} from '../math/remnote-math';
import { type MathEditorTarget } from '../commands/math';

export type PopupSessionDescriptor = {
  target: MathEditorTarget;
  initialSource: string;
  isEditing: boolean;
  isBlock: boolean;
};

/**
 * Validate handoff data written by the opening command. Returns undefined for
 * anything malformed so the widget can surface a recovery error instead of
 * operating on a corrupt target.
 */
export function parseSessionDescriptor(data: unknown): PopupSessionDescriptor | undefined {
  if (!data || typeof data !== 'object' || !('target' in data)) {
    return undefined;
  }

  const candidate = data as Partial<PopupSessionDescriptor>;
  const target = candidate.target as
    | { remId?: unknown; range?: { start?: unknown; end?: unknown } }
    | undefined;
  const range = target?.range;
  if (
    target === undefined ||
    typeof target !== 'object' ||
    typeof target.remId !== 'string' ||
    target.remId.length === 0 ||
    range === undefined ||
    typeof range !== 'object' ||
    typeof range.start !== 'number' ||
    typeof range.end !== 'number' ||
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end < 0 ||
    range.start > range.end
  ) {
    return undefined;
  }

  return {
    target: { remId: target.remId, range: { start: range.start, end: range.end } },
    initialSource: typeof candidate.initialSource === 'string' ? candidate.initialSource : '',
    isEditing: Boolean(candidate.isEditing),
    isBlock: Boolean(candidate.isBlock),
  };
}

/** The target Rem as the session sees it: readable and writable rich text. */
export type RemHandle = {
  text: RichTextInterface;
  write(text: RichTextInterface): Promise<void>;
};

/** Plugin-facing ports. Everything environment-specific is behind this seam. */
export type EditorSessionHost = {
  /** Open the target Rem, or undefined when it has vanished. */
  openRem(remId: string): Promise<RemHandle | undefined>;
  /** Build the native RemNote LaTeX element to insert. */
  createLatexElement(latex: string, block: boolean): Promise<RichTextInterface>;
  /** Surface a transient failure notice. */
  notify(message: string): Promise<void>;
  /** Dismiss the editor: close the widget and clear handoff state. */
  dismiss(): Promise<void>;
};

/** View-facing callbacks so the React component can mirror session state. */
export type SessionEffects = {
  onError(message: string | undefined): void;
  onPending(pending: boolean): void;
  onBlockChanged(block: boolean): void;
};

const MISSING_REM_MESSAGE =
  'The target Rem is no longer available. Reopen the editor and try again.';
const MISSING_MATH_MESSAGE =
  'The target math element is no longer available. Reopen the editor and try again.';

export function describeError(error: unknown, fallback = 'Unable to insert Typst math.'): string {
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
}

/**
 * Headless owner of the editing session's state transitions: live preview,
 * save flow, no-op edit guard, inline/block toggling, and dismissal ordering.
 * The React component is a thin view over this class, which makes every
 * behavior unit testable against mock ports.
 */
export class EditorSession {
  readonly target: MathEditorTarget;
  readonly isEditing: boolean;
  source: string;
  isBlock: boolean;

  private readonly host: EditorSessionHost;
  private readonly effects: SessionEffects;
  private readonly initialSource: string;
  private readonly initialIsBlock: boolean;
  private saving = false;
  private toggling = false;

  private currentRange: { start: number; end: number };
  private hasInsertedMath: boolean;
  private initialRemText?: RichTextInterface;
  private hasModifiedRem = false;
  private lastLiveLatex?: string;
  private lastLiveBlock?: boolean;
  private liveUpdateTimer?: ReturnType<typeof setTimeout>;

  constructor(
    host: EditorSessionHost,
    effects: SessionEffects,
    descriptor: PopupSessionDescriptor,
  ) {
    this.host = host;
    this.effects = effects;
    this.target = descriptor.target;
    this.isEditing = descriptor.isEditing;
    this.source = descriptor.initialSource;
    this.initialSource = descriptor.initialSource;
    this.isBlock = descriptor.isBlock;
    this.initialIsBlock = descriptor.isBlock;

    this.currentRange = { ...descriptor.target.range };
    this.hasInsertedMath = descriptor.isEditing;
  }

  setSource(next: string): void {
    this.source = next;
    this.effects.onError(undefined);
    this.scheduleLiveUpdate();
  }

  private scheduleLiveUpdate(delayMs = 80): void {
    if (this.liveUpdateTimer) {
      clearTimeout(this.liveUpdateTimer);
    }
    this.liveUpdateTimer = setTimeout(() => {
      this.liveUpdateTimer = undefined;
      void this.flushLiveUpdate();
    }, delayMs);
  }

  /**
   * Immediately converts the current source on the fly and updates the Rem in
   * real-time, powering RemNote's native live math preview in the document.
   */
  async flushLiveUpdate(): Promise<void> {
    if (this.liveUpdateTimer) {
      clearTimeout(this.liveUpdateTimer);
      this.liveUpdateTimer = undefined;
    }

    if (this.saving || this.toggling) return;

    const input = this.source.trim();
    if (!input) {
      if (!this.isEditing && this.hasInsertedMath && this.initialRemText) {
        try {
          const rem = await this.host.openRem(this.target.remId);
          if (rem) {
            await rem.write(this.initialRemText);
            this.hasInsertedMath = false;
            this.hasModifiedRem = false;
            this.currentRange = { ...this.target.range };
            this.lastLiveLatex = undefined;
          }
        } catch {
          // ignore
        }
      }
      return;
    }

    let latex: string;
    try {
      latex = typstToLatex(input, this.isBlock).output;
    } catch {
      // Incomplete or invalid syntax while typing: keep existing preview
      return;
    }

    // Skip redundant writes if neither LaTeX nor block mode changed
    if (latex === this.lastLiveLatex && this.isBlock === this.lastLiveBlock) {
      return;
    }

    try {
      const rem = await this.host.openRem(this.target.remId);
      if (!rem) return;

      if (this.initialRemText === undefined) {
        this.initialRemText = [...rem.text];
      }

      const mathMatch = findMathElementAtRange(rem.text, this.currentRange);
      const targetRange = mathMatch ? mathMatch.range : this.currentRange;

      const element = await this.host.createLatexElement(latex, this.isBlock);
      const updatedText = insertRichTextAtRange(rem.text, element, targetRange);

      await rem.write(updatedText);
      this.hasModifiedRem = true;
      this.lastLiveLatex = latex;
      this.lastLiveBlock = this.isBlock;

      this.currentRange = {
        start: targetRange.start,
        end: targetRange.start + 1,
      };
      this.hasInsertedMath = true;
    } catch {
      // Best-effort live preview: errors are kept silent until explicit save
    }
  }

  /** Enter key: verify-and-write the math, or close untouched edits. */
  async save(): Promise<void> {
    if (this.liveUpdateTimer) {
      clearTimeout(this.liveUpdateTimer);
      this.liveUpdateTimer = undefined;
    }

    if (this.saving || this.toggling) return;

    const input = this.source.trim();
    if (!input) {
      this.effects.onError('Enter a Typst math expression first.');
      return;
    }

    // No-op edit guard: an unchanged source must never rewrite stored math,
    // since round-tripping through the engine can silently degrade LaTeX it
    // does not fully support.
    if (
      this.isEditing &&
      input === this.initialSource.trim() &&
      this.isBlock === this.initialIsBlock
    ) {
      if (this.hasModifiedRem && this.initialRemText !== undefined) {
        try {
          const rem = await this.host.openRem(this.target.remId);
          if (rem) {
            await rem.write(this.initialRemText);
          }
        } catch {
          // ignore
        }
      }
      this.hasModifiedRem = false;
      await this.dismiss();
      return;
    }

    this.saving = true;
    this.effects.onPending(true);
    this.effects.onError(undefined);
    let committed = false;

    try {
      await this.writeMath(input);
      committed = true;
      this.hasModifiedRem = false; // Successfully committed, do not revert on dismiss
      await this.dismiss();
    } catch (saveError: unknown) {
      const message = committed
        ? 'Saved, but the editor could not close.'
        : describeError(saveError);
      this.effects.onError(message);
      await this.host.notify(committed ? message : `Typst math failed: ${message}`);
    } finally {
      this.saving = false;
      this.effects.onPending(false);
    }
  }

  /**
   * Inline/block toggle. In edit mode or when live math is active, the
   * environment swap is committed immediately (not on save), rolling back the
   * visual state on failure.
   */
  async toggleBlock(next: boolean): Promise<void> {
    if (this.isBlock === next) return;
    if (this.saving || this.toggling) {
      // Surface feedback instead of silently swallowing rapid Alt+B presses.
      await this.host.notify('Still working — try the mode toggle again in a moment.');
      return;
    }

    this.isBlock = next;
    this.effects.onBlockChanged(next);

    if (this.hasInsertedMath) {
      this.toggling = true;
      try {
        const rem = await this.host.openRem(this.target.remId);
        if (!rem) {
          throw new Error(MISSING_REM_MESSAGE);
        }

        if (this.initialRemText === undefined) {
          this.initialRemText = [...rem.text];
        }

        const mathMatch = findMathElementAtRange(rem.text, this.currentRange);
        const targetRange = mathMatch ? mathMatch.range : this.currentRange;

        const updatedText = setMathBlockAtRange(rem.text, targetRange, next);
        if (!updatedText) {
          throw new Error(MISSING_MATH_MESSAGE);
        }

        await rem.write(updatedText);
        this.currentRange = {
          start: targetRange.start,
          end: targetRange.start + 1,
        };
        this.hasModifiedRem = true;
        this.lastLiveBlock = next;
        this.effects.onError(undefined);
      } catch (modeError: unknown) {
        this.isBlock = !next;
        this.effects.onBlockChanged(this.isBlock);
        const message = describeError(modeError);
        this.effects.onError(message);
        await this.host.notify(`Typst math failed: ${message}`);
      } finally {
        this.toggling = false;
      }
    }
  }

  /** Escape key or Cancel button: drop the editor and revert any live writes. */
  async dismiss(): Promise<void> {
    if (this.liveUpdateTimer) {
      clearTimeout(this.liveUpdateTimer);
      this.liveUpdateTimer = undefined;
    }

    if (this.hasModifiedRem && this.initialRemText !== undefined) {
      try {
        const rem = await this.host.openRem(this.target.remId);
        if (rem) {
          await rem.write(this.initialRemText);
        }
      } catch {
        // Best-effort revert on cancellation
      }
      this.hasModifiedRem = false;
    }

    await this.host.dismiss();
  }

  dispose(): void {
    if (this.liveUpdateTimer) {
      clearTimeout(this.liveUpdateTimer);
      this.liveUpdateTimer = undefined;
    }

    if (this.saving) return;

    if (this.hasModifiedRem && this.initialRemText !== undefined) {
      const remId = this.target.remId;
      const initialText = this.initialRemText;
      this.hasModifiedRem = false;
      void this.host
        .openRem(remId)
        .then((rem) => {
          if (rem) {
            void rem.write(initialText).catch(() => {});
          }
        })
        .catch(() => {});
    }
  }

  private async writeMath(input: string): Promise<void> {
    await initializeConverter();
    const conversion = typstToVerifiedLatex(input, this.isBlock);
    const element = await this.host.createLatexElement(conversion.output, this.isBlock);

    const rem = await this.host.openRem(this.target.remId);
    if (!rem) {
      throw new Error(MISSING_REM_MESSAGE);
    }

    if (this.initialRemText === undefined) {
      this.initialRemText = [...rem.text];
    }

    const mathMatch = findMathElementAtRange(rem.text, this.currentRange);
    const targetRange = mathMatch ? mathMatch.range : this.currentRange;

    await rem.write(insertRichTextAtRange(rem.text, element, targetRange));
    this.currentRange = {
      start: targetRange.start,
      end: targetRange.start + 1,
    };
    this.hasInsertedMath = true;
  }
}
