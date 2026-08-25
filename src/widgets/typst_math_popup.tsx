import React, { useEffect, useRef, useState } from 'react';
import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import '../style.css';
import { createNativeLatex } from '../math/remnote-math';
import { highlightTypst } from '../math/typst-grammar';
import { TYPST_MATH_SESSION_KEY } from '../commands/math';
import {
  EditorSession,
  describeError,
  parseSessionDescriptor,
  type EditorSessionHost,
  type PopupSessionDescriptor,
  type SessionEffects,
} from './editor-session';

function TypstMathPopup() {
  const plugin = usePlugin();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const [descriptor, setDescriptor] = useState<PopupSessionDescriptor>();
  const [session, setSession] = useState<EditorSession>();
  // `source` and `isBlock` mirror the session for rendering; the session is
  // authoritative and pushes changes back through the effects callbacks.
  const [source, setSource] = useState('');
  const [isBlock, setIsBlock] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadData() {
      try {
        const sessionData = await plugin.storage.getSession<unknown>(TYPST_MATH_SESSION_KEY);
        const parsed = parseSessionDescriptor(sessionData);

        if (!active) return;

        if (!parsed) {
          setError('The editor target could not be recovered.');
          return;
        }

        const host: EditorSessionHost = {
          openRem: async (remId) => {
            const rem = await plugin.rem.findOne(remId);
            if (!rem) return undefined;
            return { text: rem.text || [], write: (text) => rem.setText(text) };
          },
          createLatexElement: (latex, block) => createNativeLatex(plugin, latex, block),
          notify: async (message) => {
            try {
              await plugin.app.toast(message);
            } catch {
              // A toast failure must not turn a completed Rem update into a retryable save.
            }
          },
          dismiss: async () => {
            await plugin.storage.setSession(TYPST_MATH_SESSION_KEY, undefined);
            await closePopup();
          },
        };

        const effects: SessionEffects = {
          onError: setError,
          onPending: setPending,
          onBlockChanged: setIsBlock,
        };

        const editorSession = new EditorSession(host, effects, parsed);
        setDescriptor(parsed);
        setSession(editorSession);
        setSource(editorSession.source);
        setIsBlock(editorSession.isBlock);
      } catch (contextError: unknown) {
        if (active) {
          setError(describeError(contextError));
        }
      }
    }

    void loadData();

    return () => {
      active = false;
    };
  }, [plugin]);

  useEffect(() => {
    if (descriptor) {
      inputRef.current?.focus();
    }
  }, [descriptor]);

  // The highlight layer overlays the textarea without native scrolling, so it
  // must mirror the textarea's scrollTop to stay aligned with the caret.
  function syncHighlightScroll(): void {
    if (inputRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = inputRef.current.scrollTop;
    }
  }

  useEffect(() => {
    syncHighlightScroll();
  }, [source]);

  async function closePopup(): Promise<void> {
    try {
      const context = await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>();
      await plugin.window.closeFloatingWidget(context.floatingWidgetId);
    } catch {
      await plugin.window.closeAllFloatingWidgets();
    }
  }

  /** Dismissal path when no session exists yet (target failed to load). */
  async function dismissDirect(): Promise<void> {
    await plugin.storage.setSession(TYPST_MATH_SESSION_KEY, undefined);
    await closePopup();
  }

  function toggleBlock(next: boolean): void {
    if (!session) {
      setIsBlock(next);
      return;
    }
    void session.toggleBlock(next);
  }

  function save(): void {
    if (!session) {
      const message = 'The editor target is still loading. Try again.';
      setError(message);
      void sessionlessNotify(message);
      return;
    }
    void session.save();
  }

  async function sessionlessNotify(message: string): Promise<void> {
    try {
      await plugin.app.toast(message);
    } catch {
      // Ignore: toasts are best-effort.
    }
  }

  useEffect(() => {
    function onWindowKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        void (session ? session.dismiss() : dismissDirect());
      } else if (e.altKey && (e.key === 'm' || e.key === 'M' || e.code === 'KeyM')) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleBlock(!isBlock);
      } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        save();
      }
    }
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  });

  useEffect(() => {
    function isInDarkTheme(doc: Document): boolean {
      return (
        doc.documentElement.classList.contains('dark') ||
        doc.body.classList.contains('dark') ||
        doc.documentElement.getAttribute('data-theme') === 'dark'
      );
    }

    // Prefer RemNote's own theme signals over the OS preference: the app can
    // be light while the OS is dark.
    let isDark = isInDarkTheme(document);
    if (!isDark) {
      try {
        isDark = isInDarkTheme(window.parent.document);
      } catch {
        // Cross-origin iframe: the parent document is inaccessible.
      }
    }
    if (!isDark) {
      isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    if (isDark) {
      document.documentElement.classList.add('dark');
      document.body.classList.add('dark');
    }
  }, []);

  return (
    <div className="typst-math-popup rn-clr-content-primary rn-clr-shadow-modal rn-text-label-small rn-fontweight-regular p-3 select-none transition-colors">
      <div className="relative min-h-[70px]">
        {/* Syntax Highlighting Layer */}
        <pre
          ref={highlightRef}
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
            session?.setSource(event.target.value);
          }}
          onScroll={syncHighlightScroll}
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
              onClick={() => toggleBlock(false)}
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
              onClick={() => toggleBlock(true)}
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
              onClick={() => void (session ? session.dismiss() : dismissDirect())}
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
              onClick={() => save()}
              disabled={pending}
              className="typst-popup-action rounded-lg rn-clr-background-accent text-white rn-clr-shadow-default px-3.5 py-1 rn-fontweight-semibold transition-all duration-150 flex items-center gap-1 cursor-pointer"
            >
              <span>{pending ? (descriptor?.isEditing ? 'Saving…' : 'Inserting…') : 'Done'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

renderWidget(TypstMathPopup);
