import { SelectionType, type EditorRange, type RNPlugin } from '@remnote/plugin-sdk';
import { findMathElementAtRange } from '../math/remnote-math';
import { initializeConverter, latexToTypst } from '../math/converter';

export type MathEditorTarget = {
  remId: string;
  range: EditorRange;
};

export type TypstMathPopupData = {
  target: MathEditorTarget;
  initialSource?: string;
  initialError?: string;
  isEditing?: boolean;
  isBlock?: boolean;
  floatingWidgetId?: string;
};

export async function openInsertTypstMath(plugin: RNPlugin): Promise<void> {
  const existingPopupData = await plugin.storage.getSession<TypstMathPopupData>('typst_math_data');
  if (existingPopupData?.target) {
    const popupIsOpen = existingPopupData.floatingWidgetId
      ? await plugin.window.isFloatingWidgetOpen(existingPopupData.floatingWidgetId)
      : false;
    if (popupIsOpen) return;

    await plugin.storage.setSession('typst_math_data', undefined);
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
      const conversion = latexToTypst(foundMath.element.text);
      initialSource = conversion.output;
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
    left: anchorCaret ? Math.max(16, anchorCaret.left - 10) : 100,
  };

  await Promise.all([
    plugin.storage.setSession('typst_math_data', popupData),
    plugin.window.closeAllFloatingWidgets(),
  ]);

  const floatingWidgetId = await plugin.window.openFloatingWidget(
    'typst_math_popup',
    position,
    undefined,
    true,
  );
  if (floatingWidgetId) {
    await plugin.storage.setSession('typst_math_data', { ...popupData, floatingWidgetId });
  }
}
