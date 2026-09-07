import { SelectionType, type EditorRange, type RNPlugin } from '@remnote/plugin-sdk';
import { findMathElementAtRange } from '../math/remnote-math';
import { detectFormat, initializeConverter, latexToTypst } from '../math/converter';

export const TYPST_MATH_SESSION_KEY = 'typst_math_data';

export type MathEditorTarget = {
  remId: string;
  range: EditorRange;
};

export type TypstMathPopupData = {
  target: MathEditorTarget;
  initialSource?: string;
  isEditing?: boolean;
  isBlock?: boolean;
  floatingWidgetId?: string;
};

// Keep in sync with the widget registration width in widgets/index.tsx.
const POPUP_WIDTH_PX = 380;
const POPUP_HEIGHT_PX = 200;

function clampToViewport(left: number): number {
  try {
    // The caret rect is measured against the main window, which owns the
    // viewport the floating widget renders in.
    const viewportWidth = window.parent.innerWidth;
    return Math.min(left, Math.max(16, viewportWidth - POPUP_WIDTH_PX - 16));
  } catch {
    // Cross-origin main window: skip clamping rather than misplace the popup.
    return left;
  }
}

function calculatePopupTop(anchorCaret?: { top: number; bottom: number }): number {
  if (!anchorCaret) return 100;
  try {
    const viewportHeight = window.parent.innerHeight;
    const defaultTop = anchorCaret.bottom + 6;
    if (
      defaultTop + POPUP_HEIGHT_PX > viewportHeight &&
      anchorCaret.top - POPUP_HEIGHT_PX - 6 > 0
    ) {
      return Math.max(16, anchorCaret.top - POPUP_HEIGHT_PX - 6);
    }
    return defaultTop;
  } catch {
    return anchorCaret.bottom + 6;
  }
}

let openInFlight: Promise<void> | undefined;

export async function openInsertTypstMath(plugin: RNPlugin): Promise<void> {
  // Rapid repeat invocations (e.g. a held-down Alt+M) must not race the
  // session-storage writes; serialize them behind the first open.
  openInFlight ??= invokeOpen(plugin).finally(() => {
    openInFlight = undefined;
  });
  return openInFlight;
}

async function invokeOpen(plugin: RNPlugin): Promise<void> {
  const existingPopupData =
    await plugin.storage.getSession<TypstMathPopupData>(TYPST_MATH_SESSION_KEY);
  if (existingPopupData?.target) {
    const popupIsOpen = existingPopupData.floatingWidgetId
      ? await plugin.window.isFloatingWidgetOpen(existingPopupData.floatingWidgetId)
      : false;
    if (popupIsOpen) {
      await plugin.messaging.broadcast('focus');
      return;
    }

    await plugin.storage.setSession(TYPST_MATH_SESSION_KEY, undefined);
  }

  const [selection, initialCaret] = await Promise.all([
    plugin.editor.getSelection(),
    plugin.editor.getCaretPosition(),
  ]);

  if (!selection || selection.type !== SelectionType.Text) {
    await plugin.app.toast('Focus an editor before inserting Typst math.');
    return;
  }

  const rem = await plugin.rem.findOne(selection.remId);
  if (!rem) {
    await plugin.app.toast('The selected Rem is no longer available.');
    return;
  }

  const foundMath = findMathElementAtRange(rem.text || [], selection.range);

  let target: MathEditorTarget;
  let initialSource = '';
  let isEditing = false;
  let isBlock = false;

  if (foundMath) {
    target = {
      remId: selection.remId,
      range: foundMath.range,
    };
    isEditing = true;
    isBlock = Boolean(foundMath.element.block);
    try {
      await initializeConverter();
      // Content written by other tools may not be LaTeX at all; pre-fill such
      // elements verbatim instead of force-converting them.
      const storedText = foundMath.element.text;
      initialSource =
        detectFormat(storedText) === 'typst' ? storedText : latexToTypst(storedText).output;
    } catch {
      initialSource = foundMath.element.text;
    }
  } else {
    target = {
      remId: selection.remId,
      range: selection.range,
    };
  }

  const popupData: TypstMathPopupData = {
    target,
    initialSource,
    isEditing,
    isBlock,
  };

  let anchorCaret = initialCaret;
  if (foundMath) {
    // A programmatic text update dismisses RemNote's native LaTeX sub-editor before
    // the floating Typst editor takes focus. Preserve the stored RichText unchanged.
    try {
      await rem.setText([...(rem.text || [])]);
    } catch (setTextError: unknown) {
      const message = setTextError instanceof Error ? setTextError.message : 'update failed';
      await plugin.app.toast(`Could not prepare the math editor: ${message}`);
      return;
    }
    // `requestAnimationFrame` may never fire in a backgrounded tab: race it
    // against a timeout so the popup still opens instead of stalling.
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      try {
        requestAnimationFrame(() => done());
      } catch {
        done();
      }
      setTimeout(done, 300);
    });
    try {
      anchorCaret = (await plugin.editor.getCaretPosition()) ?? initialCaret;
    } catch {
      anchorCaret = initialCaret;
    }
  }

  const position = {
    top: calculatePopupTop(anchorCaret),
    left: anchorCaret ? clampToViewport(Math.max(16, anchorCaret.left - 10)) : 100,
  };

  if (existingPopupData?.floatingWidgetId) {
    try {
      await plugin.window.closeFloatingWidget(existingPopupData.floatingWidgetId);
    } catch {
      // ignore
    }
  }

  await plugin.storage.setSession(TYPST_MATH_SESSION_KEY, popupData);

  const floatingWidgetId = await plugin.window.openFloatingWidget(
    'typst_math_popup',
    position,
    undefined,
    true,
  );
  if (floatingWidgetId) {
    await plugin.storage.setSession(TYPST_MATH_SESSION_KEY, { ...popupData, floatingWidgetId });
  } else {
    // The widget never opened: clear the handoff so the next Alt+M starts
    // fresh, and tell the user instead of looking dead.
    await plugin.storage.setSession(TYPST_MATH_SESSION_KEY, undefined);
    await plugin.app.toast('Could not open the Typst math editor. Try again.');
  }
}
