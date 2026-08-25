import { declareIndexPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import type { ReactRNPlugin } from '@remnote/plugin-sdk';
import '../style.css';
import { openInsertTypstMath } from '../commands/math';
import { initializeConverter } from '../math/converter';

async function onActivate(plugin: ReactRNPlugin) {
  // Pre-warm WASM converter in the background so opening/converting is instant
  void initializeConverter().catch(() => {});

  // Caret-anchored floating widget
  await plugin.app.registerWidget('typst_math_popup', WidgetLocation.FloatingWidget, {
    dimensions: { height: 'auto', width: '380px' },
  });

  // Caret-anchored floating popup (Alt+M or /typst)
  await plugin.app.registerCommand({
    // Keep in sync with the id in public/manifest.json. plugin.id is typed as
    // string | undefined, so the namespace pins the manifest id at build time.
    id: `typst-math.insert-typst-math`,
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
