import type { RichTextInterface } from '@remnote/plugin-sdk';
import { initializeConverter, typstToVerifiedLatex } from '../math/converter';
import { insertRichTextAtRange, setMathBlockAtRange } from '../math/remnote-math';
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
  if (
    !candidate.target ||
    typeof candidate.target !== 'object' ||
    typeof candidate.target.remId !== 'string' ||
    !candidate.target.range ||
    typeof candidate.target.range.start !== 'number' ||
    typeof candidate.target.range.end !== 'number'
  ) {
    return undefined;
  }

  return {
    target: candidate.target,
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
 * Headless owner of the editing session's state transitions: save flow,
 * no-op edit guard, inline/block toggling, and dismissal ordering. The React
 * component is a thin view over this class, which makes every behavior unit
 * testable against mock ports.
 */
export class EditorSession {
  readonly target: MathEditorTarget;
  readonly isEditing: boolean;
  source: string;
  isBlock: boolean;

  private readonly host: EditorSessionHost;
  private readonly effects: SessionEffects;
  private readonly initialSource: string;
  private saving = false;
  private toggling = false;

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
  }

  setSource(next: string): void {
    this.source = next;
    this.effects.onError(undefined);
  }

  /** Enter key: verify-and-write the math, or close untouched edits. */
  async save(): Promise<void> {
    if (this.saving || this.toggling) return;

    const input = this.source.trim();
    if (!input) {
      this.effects.onError('Enter a Typst math expression first.');
      return;
    }

    // No-op edit guard: an unchanged source must never rewrite stored math,
    // since round-tripping through the engine can silently degrade LaTeX it
    // does not fully support.
    if (this.isEditing && input === this.initialSource.trim()) {
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
   * Inline/block toggle. In edit mode the environment swap is committed
   * immediately (not on save), rolling back the visual state on failure.
   */
  async toggleBlock(next: boolean): Promise<void> {
    if (this.isBlock === next || this.saving || this.toggling) return;

    this.isBlock = next;
    this.effects.onBlockChanged(next);
    if (!this.isEditing) return;

    this.toggling = true;
    try {
      const rem = await this.host.openRem(this.target.remId);
      if (!rem) {
        throw new Error(MISSING_REM_MESSAGE);
      }

      const updatedText = setMathBlockAtRange(rem.text, this.target.range, next);
      if (!updatedText) {
        throw new Error(MISSING_MATH_MESSAGE);
      }

      await rem.write(updatedText);
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

  /** Escape key or Cancel button: drop the editor without writing. */
  async dismiss(): Promise<void> {
    await this.host.dismiss();
  }

  private async writeMath(input: string): Promise<void> {
    await initializeConverter();
    const conversion = typstToVerifiedLatex(input, this.isBlock);
    const element = await this.host.createLatexElement(conversion.output, this.isBlock);

    const rem = await this.host.openRem(this.target.remId);
    if (!rem) {
      throw new Error(MISSING_REM_MESSAGE);
    }

    await rem.write(insertRichTextAtRange(rem.text, element, this.target.range));
  }
}
