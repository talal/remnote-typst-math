import React, { useEffect, useRef, useState } from 'react';
import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import '../style.css';
import { ConversionError, initializeConverter, typstToLatex } from '../math/converter';
import {
  createNativeLatex,
  insertRichTextAtRange,
  setMathBlockAtRange,
} from '../math/remnote-math';
import { highlightTypst } from '../math/typst-grammar';
import { type MathEditorTarget, type TypstMathPopupData } from '../commands/math';

type PopupState = {
  target: MathEditorTarget;
  initialSource: string;
  initialError?: string;
  isEditing?: boolean;
  isBlock?: boolean;
};

function readPopupState(data: unknown): PopupState | undefined {
  if (!data || typeof data !== 'object' || !('target' in data)) {
    return undefined;
  }

  const candidate = data as Partial<TypstMathPopupData>;
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
    initialError: typeof candidate.initialError === 'string' ? candidate.initialError : undefined,
    isEditing: Boolean(candidate.isEditing),
    isBlock: Boolean(candidate.isBlock),
  };
}

function formatError(error: unknown): string {
  if (error instanceof ConversionError || error instanceof Error) {
    return error.message;
  }

  return 'Unable to insert Typst math.';
}

function TypstMathPopup() {
  const plugin = usePlugin();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [popupState, setPopupState] = useState<PopupState>();
  const [source, setSource] = useState('');
  const [isBlock, setIsBlock] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const saveInFlight = useRef(false);
  const modeSwitchInFlight = useRef(false);

  useEffect(() => {
    let active = true;

    async function loadData() {
      try {
        const sessionData = await plugin.storage.getSession<unknown>('typst_math_data');
        const state = readPopupState(sessionData);

        if (!active) return;

        if (!state) {
          setError('The editor target could not be recovered.');
          return;
        }

        setPopupState(state);
        setSource(state.initialSource);
        setIsBlock(Boolean(state.isBlock));
        setError(state.initialError);
      } catch (contextError: unknown) {
        if (active) {
          setError(formatError(contextError));
        }
      }
    }

    void loadData();

    return () => {
      active = false;
    };
  }, [plugin]);

  useEffect(() => {
    if (popupState) {
      inputRef.current?.focus();
    }
  }, [popupState]);

  async function closePopup(): Promise<void> {
    try {
      const context = await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>();
      await plugin.window.closeFloatingWidget(context.floatingWidgetId);
    } catch {
      await plugin.window.closeAllFloatingWidgets();
    }
  }

  async function notify(message: string): Promise<void> {
    try {
      await plugin.app.toast(message);
    } catch {
      // A toast failure must not turn a completed Rem update into a retryable save.
    }
  }

  async function dismissPopup(): Promise<void> {
    await plugin.storage.setSession('typst_math_data', undefined);
    await closePopup();
  }

  async function updateMath(
    input: string,
    block: boolean,
    target: MathEditorTarget,
  ): Promise<void> {
    await initializeConverter();
    const conversion = typstToLatex(input, block);
    const richText = await createNativeLatex(plugin, conversion.output, block);
    const rem = await plugin.rem.findOne(target.remId);
    if (!rem) {
      throw new Error('The target Rem is no longer available. Reopen the editor and try again.');
    }

    const currentText = rem.text || [];
    const updatedText = insertRichTextAtRange(currentText, richText, target.range);
    await rem.setText(updatedText);
  }

  async function save(): Promise<void> {
    if (saveInFlight.current || modeSwitchInFlight.current) return;
    if (!popupState) {
      const message = 'The editor target is still loading. Try again.';
      setError(message);
      await notify(message);
      return;
    }

    const input = source.trim();
    if (!input) {
      setError('Enter a Typst math expression first.');
      return;
    }

    saveInFlight.current = true;
    setPending(true);
    setError(undefined);
    let committed = false;

    try {
      await updateMath(input, isBlock, popupState.target);
      committed = true;
      await dismissPopup();
    } catch (saveError: unknown) {
      const message = committed ? 'Saved, but the editor could not close.' : formatError(saveError);
      setError(message);
      await notify(committed ? message : `Typst math failed: ${message}`);
    } finally {
      saveInFlight.current = false;
      setPending(false);
    }
  }

  useEffect(() => {
    function onWindowKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        void dismissPopup();
      } else if (e.altKey && (e.key === 'm' || e.key === 'M' || e.code === 'KeyM')) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        void setBlockMode(!isBlock);
      } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [plugin, isBlock, source, popupState]);

  useEffect(() => {
    let isDark =
      window.matchMedia('(prefers-color-scheme: dark)').matches ||
      document.documentElement.classList.contains('dark') ||
      document.body.classList.contains('dark') ||
      document.documentElement.getAttribute('data-theme') === 'dark';

    if (!isDark) {
      try {
        if (
          window.parent?.document?.documentElement?.classList?.contains('dark') ||
          window.parent?.document?.body?.classList?.contains('dark') ||
          window.parent?.document?.documentElement?.getAttribute('data-theme') === 'dark'
        ) {
          isDark = true;
        }
      } catch {
        // Cross-origin iframe fallback
      }
    }

    if (isDark) {
      document.documentElement.classList.add('dark');
      document.body.classList.add('dark');
    }
  }, []);

  async function setBlockMode(nextBlock: boolean): Promise<void> {
    if (isBlock === nextBlock || saveInFlight.current || modeSwitchInFlight.current) return;

    setIsBlock(nextBlock);
    if (!popupState?.isEditing) return;

    modeSwitchInFlight.current = true;
    try {
      const rem = await plugin.rem.findOne(popupState.target.remId);
      if (!rem) {
        throw new Error('The target Rem is no longer available. Reopen the editor and try again.');
      }

      const updatedText = setMathBlockAtRange(rem.text || [], popupState.target.range, nextBlock);
      if (!updatedText) {
        throw new Error(
          'The target math element is no longer available. Reopen the editor and try again.',
        );
      }

      await rem.setText(updatedText);
      setError(undefined);
    } catch (modeError: unknown) {
      setIsBlock(!nextBlock);
      const message = formatError(modeError);
      setError(message);
      await notify(`Typst math failed: ${message}`);
    } finally {
      modeSwitchInFlight.current = false;
    }
  }

  return (
    <div className="typst-math-popup rn-clr-content-primary rn-clr-shadow-modal rn-text-label-small rn-fontweight-regular p-3 select-none transition-colors">
      <div className="relative min-h-[70px]">
        {/* Syntax Highlighting Layer */}
        <pre
          aria-hidden="true"
          className="typst-editor-highlight rn-clr-content-primary"
          dangerouslySetInnerHTML={{
            __html: highlightTypst(source || '') + (source.endsWith('\n') ? ' ' : ''),
          }}
        />
        {/* Interactive Textarea Layer */}
        <textarea
          ref={inputRef}
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
            setError(undefined);
          }}
          placeholder="e.g. mat(1, 2; 3, 4)"
          spellCheck={false}
          disabled={pending}
          rows={3}
          className="typst-editor-input"
          aria-label="Typst math source"
        />
        <a
          href="https://typst.app/docs/reference/math/"
          target="_blank"
          rel="noopener noreferrer"
          title="Typst Math Documentation"
          className="typst-popup-hover typst-popup-muted absolute top-1 right-1 z-10 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full rn-clr-content-tertiary text-[11px] rn-fontweight-semibold transition-colors"
        >
          ?
        </a>
      </div>
      {error && (
        <div
          className="my-1.5 px-1 rn-clr-content-negative rn-text-label-small rn-fontweight-medium"
          role="status"
        >
          {error}
        </div>
      )}
      <div className="flex items-center justify-between mt-2 pt-2 border-t rn-clr-border-opaque">
        {/* Segmented Control Pill Toggle with Tooltip */}
        <div className="group relative flex items-center">
          <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden -translate-x-1/2 flex-col items-center transition-opacity group-hover:flex">
            <div className="flex items-center gap-1 px-2 py-1 rounded-lg rn-clr-background-elevation-30 rn-clr-content-secondary rn-clr-shadow-menu rn-text-label-small rn-fontweight-medium border rn-clr-border-opaque whitespace-nowrap">
              <kbd className="inline-block px-1.5 py-0.5 rounded rn-clr-background-secondary rn-clr-content-primary rn-clr-border-opaque text-[10px] rn-fontweight-medium leading-none border shadow-sm">
                Alt
              </kbd>
              <span className="rn-clr-content-tertiary text-[10px]">+</span>
              <kbd className="inline-block px-1.5 py-0.5 rounded rn-clr-background-secondary rn-clr-content-primary rn-clr-border-opaque text-[10px] rn-fontweight-medium leading-none border shadow-sm">
                B
              </kbd>
            </div>
            <div className="typst-popup-tooltip-arrow w-0 h-0 border-x-4 border-x-transparent border-t-4" />
          </div>
          <div className="flex items-center p-0.5 rounded-lg rn-clr-background-secondary rn-clr-border-opaque border">
            <button
              type="button"
              onClick={() => void setBlockMode(false)}
              aria-pressed={!isBlock}
              className={`flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md transition-all cursor-pointer ${
                !isBlock
                  ? 'rn-clr-background-accent text-white rn-clr-shadow-default rn-fontweight-semibold'
                  : 'typst-popup-hover typst-popup-muted rn-clr-content-secondary rn-fontweight-medium'
              }`}
            >
              <span className={`font-mono text-[10px] ${!isBlock ? 'opacity-90' : 'opacity-70'}`}>
                (x)
              </span>
              <span>Inline</span>
            </button>
            <button
              type="button"
              onClick={() => void setBlockMode(true)}
              aria-pressed={isBlock}
              className={`flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md transition-all cursor-pointer ${
                isBlock
                  ? 'rn-clr-background-accent text-white rn-clr-shadow-default rn-fontweight-semibold'
                  : 'typst-popup-hover typst-popup-muted rn-clr-content-secondary rn-fontweight-medium'
              }`}
            >
              <span className={`font-mono text-[10px] ${isBlock ? 'opacity-90' : 'opacity-70'}`}>
                ∑
              </span>
              <span>Block</span>
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Cancel Button with Tooltip */}
          <div className="group relative flex items-center">
            <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden -translate-x-1/2 flex-col items-center transition-opacity group-hover:flex">
              <div className="flex items-center gap-1 px-2 py-1 rounded-lg rn-clr-background-elevation-30 rn-clr-content-secondary rn-clr-shadow-menu rn-text-label-small rn-fontweight-medium border rn-clr-border-opaque whitespace-nowrap">
                <kbd className="inline-block px-1.5 py-0.5 rounded rn-clr-background-secondary rn-clr-content-primary rn-clr-border-opaque text-[10px] rn-fontweight-medium leading-none border shadow-sm">
                  Esc
                </kbd>
              </div>
              <div className="typst-popup-tooltip-arrow w-0 h-0 border-x-4 border-x-transparent border-t-4" />
            </div>
            <button
              type="button"
              onClick={() => void dismissPopup()}
              disabled={pending}
              className="typst-popup-action typst-popup-hover typst-popup-muted rounded-lg px-2.5 py-1 rn-clr-content-secondary rn-fontweight-medium cursor-pointer transition-colors"
            >
              Cancel
            </button>
          </div>
          {/* Done Button with Tooltip */}
          <div className="group relative flex items-center">
            <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden -translate-x-1/2 flex-col items-center transition-opacity group-hover:flex">
              <div className="flex items-center gap-1 px-2 py-1 rounded-lg rn-clr-background-elevation-30 rn-clr-content-secondary rn-clr-shadow-menu rn-text-label-small rn-fontweight-medium border rn-clr-border-opaque whitespace-nowrap">
                <kbd className="inline-block px-1.5 py-0.5 rounded rn-clr-background-secondary rn-clr-content-primary rn-clr-border-opaque text-[10px] rn-fontweight-medium leading-none border shadow-sm">
                  ↵
                </kbd>
              </div>
              <div className="typst-popup-tooltip-arrow w-0 h-0 border-x-4 border-x-transparent border-t-4" />
            </div>
            <button
              type="button"
              onClick={() => void save()}
              disabled={pending}
              className="typst-popup-action rounded-lg rn-clr-background-accent text-white rn-clr-shadow-default px-3.5 py-1 rn-fontweight-semibold transition-all duration-150 flex items-center gap-1 cursor-pointer"
            >
              <span>{pending ? (popupState?.isEditing ? 'Saving…' : 'Inserting…') : 'Done'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

renderWidget(TypstMathPopup);
