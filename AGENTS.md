# RemNote Typst Math Plugin — Developer & Agent Guide

## Overview

This repository is a RemNote plugin that enables users to write mathematics using **Typst math syntax** while storing and rendering them using **RemNote's native LaTeX math elements**.

### Architecture Pipeline

```text
Creation:
User Input (Typst Math)
       ↓
Pure TypeScript Engine (src/math/engine → typstToLatex)
       ↓
RemNote Native RichText Element ({ i: "x", text: latex, block: false })
       ↓
RemNote Native Math Renderer (KaTeX)

Editing:
Caret / Selection on Math Element ({ i: "x", text: latex })
       ↓
Pure TypeScript Engine (src/math/engine → latexToTypst)
       ↓
Floating Widget Pre-filled with Typst Source
       ↓
Update Rem at target range via rem.setText()
```

## Project Structure

- `src/`
  - `commands/math.ts`: Target editor & selection capture, math element detection (`detectFormat` dispatch), command definitions.
  - `math/converter.ts`: Converter wrapper; input sanitization; cost guards; save-time round-trip verification (`typstToVerifiedLatex`).
  - `math/engine/`: Pure TypeScript Typst Math engine covering the complete Typst math grammar.
    - `types.ts`: AST definitions for Typst math constructs.
    - `symbols.ts`: Bidirectional symbol, operator, function, arrow, shorthand, and space tables.
    - `lexer.ts`: Typst math tokenizer (identifies symbols, shorthand ops, primes, dot-paths, strings).
    - `parser.ts`: Pratt parser with Typst precedence rules, trivia tracking for function calls vs juxtaposition, unparenthesizing, and builder helpers (`mat`, `vec`, `cases`).
    - `emitter.ts`: KaTeX LaTeX code generator (automatic `aligned` wrapping, delimiter styling, font commands, script ordering).
    - `decompiler.ts`: Canonical KaTeX LaTeX to Typst decompiler for editing existing math.
    - `index.ts`: Unified engine facade (`typstToLatex`, `latexToTypst`, `detectFormat`).
  - `math/remnote-math.ts`: RichText helpers, native LaTeX element detection, `findMathElementAtRange`, and `insertRichTextAtRange` algorithm.
  - `math/typst-grammar.ts`: Prism.js syntax highlighting grammar and tokenizer for Typst math code.
  - `widgets/index.tsx`: Main plugin entrypoint (registers commands, widgets, and background listeners).
  - `widgets/typst_math_popup.tsx`: Caret-anchored floating widget for typing/editing Typst math expressions.
  - `widgets/editor-session.ts`: Headless editor-session controller (save flow, no-op guard, mode toggles, dismissal ordering) behind injected plugin ports; the widget component is a thin view over it.
  - `style.css`: Core Tailwind directives, Shadow DOM resets, and Prism syntax highlighting styling.
  - `env.d.ts`: Ambient TypeScript declarations for CSS side-effect imports.
- `public/`
  - `manifest.json`: RemNote plugin manifest with permissions and metadata.
- `vite.config.ts`: Vite+ toolchain configuration (Vitest, Oxlint, Oxfmt, type-aware checking).
- `scripts/`
  - `bench-conversion.ts`: Save-path conversion benchmark against the pure TypeScript engine.
  - `fuzz-conversion.ts`: Seeded grammar fuzzer for the engine (fixed-point, artifact, and brace-balance oracles; `npm run fuzz`).

## Development Workflow & Commands

The development environment already exposes repository-local and Nix-provided tools in `PATH`. Do not use `npx` or `nix develop --command`.

Do not run `playwright install` or attempt to download browser binaries; Playwright browsers are already installed and configured by the Nix development shell (`pkgs.playwright-driver.browsers` and `PLAYWRIGHT_BROWSERS_PATH` in `flake.nix`).

Plugin:

- **Run Quality Gate (Format, Lint, Types)**: `npm run check` (Runs `vp check` with Oxlint, Oxfmt & TS Go type checker)
- **Run Tests (TypeScript)**: `npm run test` (Runs `vp test` via Vitest)
- **Code Formatting**: `npm run fmt` (`vp fmt` via Oxfmt)
- **Linting**: `npm run lint` (`vp lint` via Oxlint)
- **Type Checking Only**: `npm run check-types` (`vp check --no-fmt --no-lint`)
- **Start Dev Server**: `npm run dev` (Runs webpack-dev-server on port 8080 with HMR)
- **Production Build & Zip**: `npm run build` (Validates plugin manifest, bundles with Webpack, and packages `PluginZip.zip`)
- **Benchmark Conversion Cost**: `npm run bench` (Times the full save path — one Typst → LaTeX conversion plus the bounded verification legs — against the pure TypeScript engine; typical expressions stay under 0.1 ms.)
- **Fuzz Conversion Engine**: `npm run fuzz` (Seeded grammar fuzz of the TypeScript engine with fixed-point/artifact/brace-balance oracles; `--seconds=N`, `--iterations=N`, `--seed=N`. Also via `just fuzz` with `FUZZ_TIME`.)

## Safety

- Do not create commits, push, or modify Git state unless explicitly asked.
- Do not install tools globally.
- Put generated plans, reports, logs, and other temporary artifacts under `.agents/scratch/`.
- Do not introduce Node.js or Electron runtime dependencies.

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

3. **Bidirectional Translation & Engine Policy**:
   - Clean, standard LaTeX is stored natively in RemNote without auxiliary comments or metadata.
   - The engine surface carries math source (+ inline/block flag); UI code must use the converter wrappers in `math/converter.ts`, never raw engine calls or option objects.
   - The pure TypeScript engine (`src/math/engine/`) covers the full Typst math grammar via a Pratt parser with Typst precedence rules (Fraction > Juxtaposition), trivia tracking (distinguishing function calls from juxtaposition), unparenthesizing semantics (`math_unparen`), and builders for `mat`, `vec`, and `cases`.
   - The emitter (`emitter.ts`) outputs clean KaTeX LaTeX with automatic `\begin{aligned}` wrapping for multiline/aligned math, delimiter canonicalization (`\begin{pmatrix}`, `\begin{bmatrix}`, etc.), script ordering (primes precede subscripts `f'_1`), upright/bold font wrapping, and spacing primitives (`\ `, `~`, `\quad`).
   - The canonical decompiler (`decompiler.ts`) recovers clean Typst source from existing RemNote KaTeX math elements when re-opening math for editing.
   - When editing any math element, the wrapper detects whether the stored content is LaTeX (`detectFormat`) and pre-populates the floating editor with normalized Typst source. Non-LaTeX content is pre-filled verbatim instead of force-converted.
   - Pressing Enter on an untouched editor (editing mode, unchanged source) closes the popup without rewriting the Rem, so stored math is never degraded by a lossy no-op round-trip.
   - Saving runs a fixed-point round-trip verification (`typstToVerifiedLatex`): expressions whose LaTeX mutates across a conversion cycle are refused with an error instead of being written.
   - Conversion cost guards in `math/converter.ts` refuse inputs beyond human-authored scale (length/nesting caps) and malformed recovery comments.

4. **Engine Convergence & Testing**:
   - All parser, emitter, and decompiler logic lives in `src/math/engine/`.
   - Testing runs 100% headless outside of a browser or RemNote instance using Vitest (`npm run test` or `vp test`).
   - The test suite covers all 266+ symbols, all 22 shorthands, all 28 standard functions, cases variants, matrix/vector delimiters, operator precedence, accents, and round-trip invariance.
   - `scripts/fuzz-conversion.ts` (`npm run fuzz`) extends coverage with seeded grammar fuzzing: every accepted save must be a verification fixed point, with no engine artifacts or unbalanced braces.

5. **Native LaTeX Schema**:
   - Inline math: `{ i: "x", text: "\\sum_{i=1}^n i", block: false }`
   - Block math: `{ i: "x", text: "\\sum_{i=1}^n i", block: true }`

6. **Testing in Live Chrome with CDP**:
   - To inspect or interact with the running browser session:
     - `playwright-cli attach --cdp=http://localhost:9222`
     - `chrome-devtools list_pages` / `chrome-devtools list_console_messages`

7. **Floating Widget Shortcuts**:
   - `Alt+M`: Open the Typst editor; repeated presses keep the existing popup open
   - `Alt+B`: Toggle between inline `(x)` and block `∑` math modes
   - `Enter`: Save & insert/update math into Rem
   - `Esc`: Dismiss editor without saving
