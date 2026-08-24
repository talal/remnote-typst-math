# RemNote Typst Math Plugin

Write math in RemNote using [Typst math syntax](https://typst.app/docs/reference/math/) instead of LaTeX.

## What This Plugin Does

Writing mathematical expressions in standard LaTeX can often be verbose, repetitive, and hard to read while typing. [Typst](https://typst.app/) offers a clean, elegant, and concise syntax for mathematical typesetting.

This plugin bridges the two worlds:

- **Write Typst Math**: Type mathematical formulas with Typst's streamlined syntax (e.g., `sum_(i=1)^n i` or `mat(1, 2; 3, 4)`).
- **Fast, Local WASM Engine**: Powered by WebAssembly for instant, zero-latency conversion without external servers.
- **Native RemNote Math**: Stored and rendered as RemNote native KaTeX math elements (`{ i: "x", text: latex, block: boolean }`).
- **Inline & Block Math Modes**: Seamlessly toggle between inline and multiline block math with automatic KaTeX environment alignment (`aligned` vs `align`).
- **Clean Storage**: No auxiliary comments, proprietary metadata, or special markup saved in your notes.
- **Instant Bidirectional Editing**: Place your cursor on _any_ existing LaTeX math element and press <kbd>Alt</kbd> + <kbd>M</kbd>—it is automatically parsed and pre-filled in clean Typst syntax for editing.

## How to Use

### 1. Inserting New Math

1. Place your cursor anywhere in a Rem.
2. Press <kbd>Alt</kbd> + <kbd>M</kbd> (or use the slash command `/typst`).
3. Type your formula using Typst syntax in the popup.
4. Press <kbd>Enter</kbd> or click **Done** to insert it.

### 2. Editing Existing Math

1. Move your cursor onto (or select) any existing math equation in a Rem.
2. Press <kbd>Alt</kbd> + <kbd>M</kbd>.
3. The popup opens pre-filled with the converted Typst math source.
4. Edit the formula and press <kbd>Enter</kbd> or click **Done** to save.

### 3. Toggling Between Inline and Block Mode

- Click the **(x) Inline** or **∑ Block** buttons or press <kbd>Alt</kbd> + <kbd>B</kbd>.

## Keyboard Shortcuts

<!-- dprint-ignore-start -->
<!-- prettier-ignore-start -->
| Shortcut | Action |
| <kbd>Alt</kbd> + <kbd>M</kbd> | Open the Typst math popup; if already open, keep it open and focus the editor |
| <kbd>Alt</kbd> + <kbd>B</kbd> | Toggle between inline and block math modes |
| <kbd>Enter</kbd> | Save and then close the popup |
| <kbd>Shift</kbd> + <kbd>Enter</kbd> | Insert a new line |
| <kbd>Esc</kbd> | Cancel and dismiss the popup without saving |
<!-- prettier-ignore-end -->
<!-- dprint-ignore-end -->

## Syntax Examples

<!-- dprint-ignore-start -->
<!-- prettier-ignore-start -->
| What you want | Typst Syntax (typed in popup) | Rendered LaTeX (stored in RemNote) |
| :--- | :--- | :--- |
| **Fractions** | `a / b` | `\frac{a}{b}` |
| **Summations** | `sum_(i=1)^n i` | `\sum_{i=1}^{n} i` |
| **Integrals** | `integral_0^oo e^(-x^2) dif x` | `\int_{0}^{\infty} e^{-x^2} dx` |
| **Matrices** | `mat(1, 2; 3, 4)` | `\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}` |
| **Square Roots** | `sqrt(x^2 + y^2)` | `\sqrt{x^2 + y^2}` |
| **Cases / Systems** | `f(x) = cases(1 "if" x > 0, 0 "otherwise")` | `f(x) = \begin{cases} 1 & \text{if } x > 0 \\ 0 & \text{otherwise} \end{cases}` |
| **Multiline Alignment** | `x &= 1 \ &= 2` | `\begin{aligned} x &= 1 \\ &= 2 \end{aligned}` |
<!-- prettier-ignore-end -->
<!-- dprint-ignore-end -->

## Credits

Special thanks to [Tylax](https://github.com/lucifer1004/tylax) by [Gabriel Wu (lucifer1004)](https://github.com/lucifer1004), without which this plugin would not be possible. Tylax provides the powerful, bidirectional Typst ↔ LaTeX WebAssembly conversion engine used in this plugin.

Tylax is distributed under the Apache-2.0 license. The bundled license is included in [`public/wasm/LICENSE`](public/wasm/LICENSE).
