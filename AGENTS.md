# RemNote Typst Math Plugin — Developer & Agent Guide

## Overview

This repository is a RemNote plugin that enables users to write mathematics using **Typst math syntax** while storing and rendering them using **RemNote's native LaTeX math elements**.

### Architecture Pipeline

```text
Creation:
User Input (Typst Math)
       ↓
Tylax WASM (typstToLatex)
       ↓
RemNote Native RichText Element ({ i: "x", text: latex, block: false })
       ↓
RemNote Native Math Renderer (KaTeX)

Editing:
Caret / Selection on Math Element ({ i: "x", text: latex })
       ↓
Tylax WASM (latexToTypst)
       ↓
Floating Widget Pre-filled with Typst Source
       ↓
Update Rem at target range via rem.setText()
```

---

## Project Structure

- `src/`
  - `commands/math.ts`: Target editor & selection capture, math element detection, command definitions.
  - `math/converter.ts`: Tylax WebAssembly module loader, error handling, and conversion functions (`typstToLatex`, `latexToTypst`).
  - `math/remnote-math.ts`: RichText helpers, native LaTeX element detection, `findMathElementAtRange`, and `insertRichTextAtRange` algorithm.
  - `math/typst-grammar.ts`: Prism.js syntax highlighting grammar and tokenizer for Typst math code.
  - `widgets/index.tsx`: Main plugin entrypoint (registers commands, widgets, and background listeners).
  - `widgets/typst_math_popup.tsx`: Caret-anchored floating widget for typing/editing Typst math expressions.
  - `style.css`: Core Tailwind directives, Shadow DOM resets, and Prism syntax highlighting styling.
  - `env.d.ts`: Ambient TypeScript declarations for CSS side-effect imports.
- `public/`
  - `manifest.json`: RemNote plugin manifest with permissions and metadata.
  - `wasm/`: Pre-compiled Tylax WASM binary (`tylax_bg.wasm`) and JS binding (`tylax.js`).
- `vite.config.ts`: Vite+ toolchain configuration (Vitest, Oxlint, Oxfmt, type-aware checking).
- `src/math/converter.test.ts`: Vitest test suites (WASM conversions, RichText manipulation, syntax highlighting).

---

## Development Workflow & Commands

- **Run Quality Gate (Format, Lint, Types)**: `npm run check` (Runs `vp check` with Oxlint, Oxfmt & TS Go type checker)
- **Run Tests**: `npm test` (Runs `vp test` via Vitest)
- **Code Formatting**: `npm run fmt` (`vp fmt` via Oxfmt)
- **Linting**: `npm run lint` (`vp lint` via Oxlint)
- **Type Checking Only**: `npm run check-types` (`vp check --no-fmt --no-lint`)
- **Start Dev Server**: `npm run dev` (Runs webpack-dev-server on port 8080 with HMR)
- **Production Build & Zip**: `npm run build` (Validates plugin manifest, bundles with Webpack, and packages `PluginZip.zip`)

---

## RemNote SDK Quirks & Critical Guidelines

1. **Floating Widget Lifecycle & Positioning**:
   - Registered as `WidgetLocation.FloatingWidget`.
   - Anchored directly beneath the active cursor using `plugin.editor.getCaretPosition()` and `plugin.window.openFloatingWidget()`.
   - Closes automatically when clicking outside or via `plugin.window.closeAllFloatingWidgets()`.
   - State/target data is passed seamlessly via `plugin.storage.setSession('typst_math_data', popupData)`.
   - Any database/Rem updates (e.g., `rem.setText`) must occur **before** closing.

2. **Inserting RichText into Editors**:
   - `plugin.editor.insertRichText()` relies on active editor focus in the main window. When an iframe popup is focused, `insertRichText()` will silently fail.
   - Instead, capture `MathEditorTarget` (`remId` and `EditorRange`) before opening the popup, fetch `const rem = await plugin.rem.findOne(target.remId)`, and update `rem.setText(insertRichTextAtRange(rem.text, richText, target.range))`.

3. **Bidirectional WASM Translation**:
   - Clean, standard LaTeX is stored natively in RemNote without auxiliary comments or metadata.
   - When editing any math element, Tylax WASM's `latexToTypst` parses the LaTeX on the fly and pre-populates the floating editor with clean Typst math.

4. **Native LaTeX Schema**:
   - Inline math: `{ i: "x", text: "\\sum_{i=1}^n i", block: false }`
   - Block math: `{ i: "x", text: "\\sum_{i=1}^n i", block: true }`

5. **Testing in Live Chrome with CDP**:
   - To inspect or interact with the running browser session:
     - `playwright-cli attach --cdp=http://localhost:9222`
     - `chrome-devtools list_pages` / `chrome-devtools list_console_messages`

6. **Floating Widget Shortcuts**:
   - `Alt+M`: Toggle Typst editor open/closed (saving before close if editing)
   - `Alt+B`: Toggle between inline `(x)` and block `∑` math modes
   - `Alt+Enter` (or `Ctrl/Cmd+Enter`): Save & insert/update math into Rem
   - `Esc`: Dismiss editor without saving
