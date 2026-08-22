import { declareIndexPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import type { ReactRNPlugin } from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';
import { openInsertTypstMath } from '../commands/math';

async function onActivate(plugin: ReactRNPlugin) {
  // Caret-anchored floating widget
  await plugin.app.registerWidget('typst_math_popup', WidgetLocation.FloatingWidget, {
    dimensions: { height: 'auto', width: '380px' },
  });

  // Caret-anchored floating popup (Alt+M or /typst)
  await plugin.app.registerCommand({
    id: 'insert-typst-math',
    name: 'Insert / Edit Typst Math',
    description: 'Convert Typst math into native RemNote LaTeX or edit existing math.',
    keywords: 'typst math latex equation edit',
    keyboardShortcut: 'alt+m',
    action: async () => {
      await openInsertTypstMath(plugin);
    },
  });
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
