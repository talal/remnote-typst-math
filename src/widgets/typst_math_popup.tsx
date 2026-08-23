import React, { useEffect, useRef, useState } from 'react';
import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import '../style.css';
import { ConversionError, initializeConverter, typstToLatex } from '../math/converter';
import { createNativeLatex, insertRichTextAtRange } from '../math/remnote-math';
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

  async function dismissAllFloatingWidgets(): Promise<void> {
    await plugin.storage.setSession('typst_math_data', undefined);
    await plugin.window.closeAllFloatingWidgets();
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

  async function toggleTypstPopup(): Promise<void> {
    if (saveInFlight.current || modeSwitchInFlight.current) return;

    const input = source.trim();
    if (!popupState?.isEditing || !input) {
      await dismissAllFloatingWidgets();
      return;
    }

    saveInFlight.current = true;
    setPending(true);
    setError(undefined);

    try {
      await updateMath(input, isBlock, popupState.target);
      await dismissAllFloatingWidgets();
    } catch (toggleError: unknown) {
      const message = formatError(toggleError);
      setError(message);
      await notify(`Typst math failed: ${message}`);
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
        void toggleTypstPopup();
      } else if (e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        void setBlockMode(!isBlock);
      } else if ((e.altKey || e.ctrlKey || e.metaKey) && e.key === 'Enter') {
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

    if (!popupState?.isEditing || !source.trim()) return;

    modeSwitchInFlight.current = true;
    try {
      await updateMath(source.trim(), nextBlock, popupState.target);
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
    <div className="typst-math-popup p-3 rounded-xl shadow-[0_12px_32px_rgba(0,0,0,0.35)] border border-gray-200 dark:border-[#3a3a46] bg-white dark:bg-[#2b2b33] text-gray-900 dark:text-[#f3f3f8] font-sans text-xs select-none transition-colors">
      <div className="relative min-h-[70px]">
        {/* Syntax Highlighting Layer */}
        <pre
          aria-hidden="true"
          className="typst-editor-highlight text-gray-900 dark:text-[#f3f3f8]"
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
          className="absolute top-1 right-1 z-10 w-5 h-5 flex items-center justify-center rounded-full text-gray-400 dark:text-[#9e9eb2] hover:text-gray-200 hover:bg-white/10 text-[11px] font-bold transition-colors cursor-pointer"
        >
          ?
        </a>
      </div>
      {error && (
        <div
          className="my-1.5 px-1 text-[11px] text-rose-500 dark:text-rose-400 font-medium"
          role="status"
        >
          {error}
        </div>
      )}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-900/[0.06] dark:border-[#353542]">
        {/* Segmented Control Pill Toggle with Tooltip */}
        <div className="group relative flex items-center">
          <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:flex flex-col items-center z-50 transition-opacity">
            <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white dark:bg-[#1a1a24] text-gray-500 dark:text-[#9e9eb2] text-[11px] font-medium shadow-lg border border-gray-200/80 dark:border-white/15 whitespace-nowrap">
              <kbd className="inline-block px-1.5 py-0.5 rounded font-sans text-[10px] font-medium leading-none bg-black/5 dark:bg-[#323242] text-gray-500 dark:text-[#f3f3f8] border border-gray-200/90 dark:border-white/30 shadow-sm">
                Alt
              </kbd>
              <span className="text-gray-400 text-[10px]">+</span>
              <kbd className="inline-block px-1.5 py-0.5 rounded font-sans text-[10px] font-medium leading-none bg-black/5 dark:bg-[#323242] text-gray-500 dark:text-[#f3f3f8] border border-gray-200/90 dark:border-white/30 shadow-sm">
                B
              </kbd>
            </div>
            <div className="w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-white dark:border-t-[#1a1a24]" />
          </div>
          <div className="flex items-center p-0.5 rounded-lg bg-black/5 dark:bg-[#202027] border border-gray-200/70 dark:border-[#3a3a48]">
            <button
              type="button"
              onClick={() => void setBlockMode(false)}
              className={`flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md transition-all cursor-pointer ${
                !isBlock
                  ? 'bg-[#5e79ff] text-white shadow-sm font-semibold'
                  : 'text-gray-500 dark:text-[#9e9eb2] hover:text-gray-800 dark:hover:text-white font-medium'
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
              className={`flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md transition-all cursor-pointer ${
                isBlock
                  ? 'bg-[#5e79ff] text-white shadow-sm font-semibold'
                  : 'text-gray-500 dark:text-[#9e9eb2] hover:text-gray-800 dark:hover:text-white font-medium'
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
            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:flex flex-col items-center z-50 transition-opacity">
              <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white dark:bg-[#1a1a24] text-gray-500 dark:text-[#9e9eb2] text-[11px] font-medium shadow-lg border border-gray-200/80 dark:border-white/15 whitespace-nowrap">
                <kbd className="inline-block px-1.5 py-0.5 rounded font-sans text-[10px] font-medium leading-none bg-black/5 dark:bg-[#323242] text-gray-500 dark:text-[#f3f3f8] border border-gray-200/90 dark:border-white/30 shadow-sm">
                  Esc
                </kbd>
              </div>
              <div className="w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-white dark:border-t-[#1a1a24]" />
            </div>
            <button
              type="button"
              onClick={() => void dismissPopup()}
              disabled={pending}
              className="rounded-lg px-2.5 py-1 text-xs font-medium text-gray-500 dark:text-[#9e9eb2] hover:text-gray-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
          {/* Done Button with Tooltip */}
          <div className="group relative flex items-center">
            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:flex flex-col items-center z-50 transition-opacity">
              <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white dark:bg-[#1a1a24] text-gray-500 dark:text-[#9e9eb2] text-[11px] font-medium shadow-lg border border-gray-200/80 dark:border-white/15 whitespace-nowrap">
                <kbd className="inline-block px-1.5 py-0.5 rounded font-sans text-[10px] font-medium leading-none bg-black/5 dark:bg-[#323242] text-gray-500 dark:text-[#f3f3f8] border border-gray-200/90 dark:border-white/30 shadow-sm">
                  Alt
                </kbd>
                <span className="text-gray-400 text-[10px]">+</span>
                <kbd className="inline-block px-1.5 py-0.5 rounded font-sans text-[10px] font-medium leading-none bg-black/5 dark:bg-[#323242] text-gray-500 dark:text-[#f3f3f8] border border-gray-200/90 dark:border-white/30 shadow-sm">
                  ↵
                </kbd>
              </div>
              <div className="w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-white dark:border-t-[#1a1a24]" />
            </div>
            <button
              type="button"
              onClick={() => void save()}
              disabled={pending}
              className="rounded-lg bg-[#5e79ff] hover:bg-[#4d6cf5] active:bg-[#3d5ee8] px-3.5 py-1 text-xs font-semibold text-white shadow transition-all duration-150 flex items-center gap-1 cursor-pointer disabled:opacity-50"
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
