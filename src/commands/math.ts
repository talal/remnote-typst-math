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
    if (popupIsOpen) return;

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
    await rem.setText([...(rem.text || [])]);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    anchorCaret = (await plugin.editor.getCaretPosition()) ?? initialCaret;
  }

  const position = {
    top: anchorCaret ? anchorCaret.bottom + 6 : 100,
    left: anchorCaret ? clampToViewport(Math.max(16, anchorCaret.left - 10)) : 100,
  };

  await Promise.all([
    plugin.storage.setSession(TYPST_MATH_SESSION_KEY, popupData),
    plugin.window.closeAllFloatingWidgets(),
  ]);

  const floatingWidgetId = await plugin.window.openFloatingWidget(
    'typst_math_popup',
    position,
    undefined,
    true,
  );
  if (floatingWidgetId) {
    await plugin.storage.setSession(TYPST_MATH_SESSION_KEY, { ...popupData, floatingWidgetId });
  }
}
