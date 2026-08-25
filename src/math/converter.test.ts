import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as tylax from '../../public/wasm/tylax.js';
import { initSync } from '../../public/wasm/tylax.js';
import {
  ConversionError,
  detectFormat,
  latexToTypst as wrapLatexToTypst,
  setInitializedModule,
  typstToLatex as wrapTypstToLatex,
  typstToVerifiedLatex,
} from './converter';
import {
  findMathElementAtRange,
  insertRichTextAtRange,
  isNativeLatexElement,
  setMathBlockAtRange,
} from './remnote-math';
import { highlightTypst } from './typst-grammar';

beforeAll(() => {
  initSync({
    module: readFileSync(resolve(process.cwd(), 'public/wasm/tylax_bg.wasm')),
  });
  setInitializedModule(tylax as any);
});

// Engine conversion behavior (conversion table, multiline alignment, lenient
// passthrough) and bidirectional fuzzing live in crates/engine/tests/engine.rs
// and run via `cargo test --workspace`.

describe('Engine Format Detection & Diagnostics', () => {
  it('classifies unambiguous LaTeX and Typst and defers ambiguous sources to unknown', () => {
    expect(detectFormat('\\frac{a}{b}')).toBe('latex');
    expect(detectFormat('\\alpha + \\beta')).toBe('latex');
    expect(detectFormat('#set text(size: 10pt)')).toBe('typst');
    expect(detectFormat('x + y')).toBe('unknown');
    // Bare Typst math without strong indicators must not be misclassified.
    expect(detectFormat('sum_(i=1)^n i')).toBe('unknown');
  });

  it('returns unknown for empty or whitespace-only input instead of throwing', () => {
    expect(detectFormat('')).toBe('unknown');
    expect(detectFormat('   \n\t  ')).toBe('unknown');
  });
});

describe('Save-Time Round-Trip Verification', () => {
  const realModule = tylax;

  afterEach(() => {
    setInitializedModule(realModule);
  });

  it('accepts ordinary expressions that reach a fixed point after one cycle', () => {
    const result = typstToVerifiedLatex('sum_(i=1)^n i');
    expect(result.output).toContain('sum');

    const multiline = typstToVerifiedLatex('x &= 1 \\\n&= 2', true);
    expect(multiline.output).toContain('\\begin{aligned}');
  });

  it('normalizes first-try constructs to a stable fixed point instead of refusing them', () => {
    // These need one normalization cycle before their LaTeX is stable; the
    // stored form must be the fixed point, not the raw first conversion.
    for (const source of ['vec(1, 2, 3)', 'bold(A)', 'lim_(x -> 0) f(x)']) {
      const stored = typstToVerifiedLatex(source).output;

      expect(stored).not.toBe('');
      // Whatever form was stored must reproduce itself across another cycle.
      expect(wrapTypstToLatex(wrapLatexToTypst(stored).output).output).toBe(stored);
    }
  });

  it('returns the reached fixed point when stabilization takes multiple cycles', () => {
    setInitializedModule({
      default: async () => undefined,
      // 'A' converts to 'B'; only 'B' reverses (to 'C'); 'C' is a fixed point.
      typstToLatex: (input: string) => (input === 'A' ? 'B' : input),
      latexToTypst: (input: string) => (input === 'B' ? 'C' : input),
      detectFormat: () => 'latex',
    } as any);

    expect(typstToVerifiedLatex('A').output).toBe('C');
  });

  it('accepts the normalized forms of every repair-chain construct', () => {
    // Each output of latexToTypst's normalization chain must itself verify.
    for (const source of [
      'x space "is natural"',
      'x space.nobreak y',
      'underline(x)',
      'x approx y',
      'x tilde.op y',
    ]) {
      expect(() => typstToVerifiedLatex(source)).not.toThrow();
    }
  });

  it('rejects expressions whose LaTeX keeps mutating across conversion cycles', () => {
    setInitializedModule({
      default: async () => undefined,
      typstToLatex: (input: string) => input,
      latexToTypst: (input: string) => `${input}!`,
      detectFormat: () => 'latex',
    } as any);

    expect(() => typstToVerifiedLatex('A')).toThrow(/edit cycle/);
  });

  it('passes through conversion errors untouched while verifying', () => {
    setInitializedModule({
      default: async () => undefined,
      typstToLatex: () => {
        throw new Error('boom');
      },
      latexToTypst: (input: string) => input,
      detectFormat: () => 'latex',
    } as any);

    expect(() => typstToVerifiedLatex('A')).toThrow(ConversionError);
    expect(() => typstToVerifiedLatex('A')).toThrow(/boom/);
  });

  it('refuses verification when the reverse leg degrades into error comments', () => {
    // Tylax signals unsupported constructs by embedding `/* LaTeX Error: ... */`
    // in its output. Such degraded output is non-canonical, and re-converting
    // it is the known trigger for runaway engine cost, so saving must be
    // refused instead of silently accepted.
    setInitializedModule({
      default: async () => undefined,
      typstToLatex: (input: string) => input,
      latexToTypst: (input: string) => `${input} /* LaTeX Error: } */`,
      detectFormat: () => 'latex',
    } as any);

    expect(() => typstToVerifiedLatex('A')).toThrow(ConversionError);
    expect(() => typstToVerifiedLatex('A')).toThrow(/does not support/);
  });

  it('refuses verification whose intermediates compound past the size cap', () => {
    setInitializedModule({
      default: async () => undefined,
      typstToLatex: (input: string) => `${input}${input}`,
      latexToTypst: (input: string) => `${input}${input}`,
      detectFormat: () => 'latex',
    } as any);

    expect(() => typstToVerifiedLatex('A'.repeat(2_000))).toThrow(/keeps expanding/);
  });

  it('refuses fuzz-found subscript-prime poison through the real engine', () => {
    // Minimized fuzzer artifacts (oom-/timeout- classes): dense `_'<garbage>`
    // chains whose reverse leg degrades into tylax error comments. The save
    // path must reject them quickly instead of re-entering the engine.
    const fffd = String.fromCharCode(0xfffd);
    const poison = [
      '_',
      String.fromCharCode(0x15),
      "_'",
      fffd,
      "_'__'",
      fffd,
      fffd,
      "_'ts_''___",
      fffd,
      "_'ts(_'_1'___'_'_4&heta_1'___'_'__",
    ].join('');
    expect(() => typstToVerifiedLatex(poison)).toThrow(ConversionError);
  });
});

describe('Converter Module Wrapper & Sanitization', () => {
  it('throws ConversionError on empty or whitespace-only input', () => {
    expect(() => wrapTypstToLatex('')).toThrow(ConversionError);
    expect(() => wrapTypstToLatex('   \n\t  ')).toThrow(ConversionError);
    expect(() => wrapLatexToTypst('')).toThrow(ConversionError);
    expect(() => wrapLatexToTypst('   \t  ')).toThrow(ConversionError);
  });

  it('refuses oversized input before reaching the engine', () => {
    // Runaway conversions freeze RemNote's main thread with no way to
    // interrupt WASM; human-authored math never approaches this scale.
    const oversized = 'x+'.repeat(9_000); // 18k chars > 16k limit
    expect(() => wrapTypstToLatex(oversized)).toThrow(/too large/);
    expect(() => wrapLatexToTypst(oversized)).toThrow(/too large/);
  });

  it('refuses pathologically nested input before reaching the engine', () => {
    const deep = '('.repeat(80) + 'x' + ')'.repeat(80);
    expect(() => wrapTypstToLatex(deep)).toThrow(/nested too deeply/);
    expect(() => wrapLatexToTypst(deep)).toThrow(/nested too deeply/);
  });

  it('counts LaTeX escaped braces as inert when measuring nesting', () => {
    // \{ \} literals are characters, not grouping, and must not inflate depth.
    const escapedBraces = '\\{'.repeat(100) + 'x';
    expect(wrapLatexToTypst(escapedBraces).output).toBeDefined();
  });

  it('still converts large but flat expressions within the limits', () => {
    const wide = '_x'.repeat(500); // 1000 chars, depth 0
    const result = wrapTypstToLatex(wide);
    expect(result.output).toContain('x');
  });

  it('strips zero-width characters (ZWSP) before conversion', () => {
    const withZwsp = '\u200Bx^2\u200D + \uFEFFy^2';
    const result = wrapTypstToLatex(withZwsp);
    expect(result.output).toContain('x^2');
    expect(result.output).toContain('y^2');
    expect(result.output).not.toContain('\u200B');
    expect(result.output).not.toContain('\uFEFF');
  });

  it('canonicalizes alignment environments to aligned in both modes', () => {
    const code = 'x &= 1 \\\n&= 2';

    for (const isBlock of [false, true]) {
      const result = wrapTypstToLatex(code, isBlock);
      expect(result.output).toContain('\\begin{aligned}');
      expect(result.output).toContain('\\end{aligned}');
      expect(result.output).not.toContain('\\begin{align}');
      expect(result.output).not.toContain('\\begin{align*}');
    }
  });

  it('strips enclosing $...$ produced by display LaTeX conversions', () => {
    const result = wrapLatexToTypst('\\sum_{i=1}^n i');
    expect(result.output.startsWith('$')).toBe(false);
    expect(result.output.endsWith('$')).toBe(false);
  });

  it('converts matrix delimiter options cleanly', () => {
    const result = wrapTypstToLatex('mat(delim: "[", 1, 2; 3, 4)');
    expect(result.output).toContain('bmatrix');
  });

  it('converts piecewise cases cleanly', () => {
    const result = wrapTypstToLatex('cases(1 "if" x > 0, 0 "otherwise")');
    expect(result.output).toContain('cases');
    expect(result.output).toContain('\\text{if}');
  });
  it('round-trips explicit spaces, text, and custom relations', () => {
    const source = 'cal(A) := { x in RR | x space "is natural" }';
    const latex = wrapTypstToLatex(source);

    const result = wrapLatexToTypst(latex.output);

    expect(result.output).toBe(source);
  });

  it('converts Tylax text brackets into a Typst string', () => {
    const result = wrapLatexToTypst('\\text{[is natural]}');

    expect(result.output).toBe('"is natural"');
  });

  it('restores LaTeX control spaces without inventing ordinary spaces', () => {
    const explicitSpace = wrapLatexToTypst('x \\ y');
    const ordinaryText = wrapLatexToTypst('x \\text{is natural}');

    expect(explicitSpace.output).toBe('x space y');
    expect(ordinaryText.output).toBe('x "is natural"');
  });
  it('normalizes named relations, sim, and underline artifacts', () => {
    const namedRelation = wrapLatexToTypst('x \\mathrel{\\approx} y');
    const simRelation = wrapLatexToTypst('x \\sim y');
    const underline = wrapLatexToTypst('\\underline{x}');

    expect(namedRelation.output).toBe('x approx y');
    expect(simRelation.output).toBe('x tilde.op y');
    expect(underline.output).toBe('underline(x)');
    expect(wrapTypstToLatex(underline.output).output).toBe('\\underline{x}');
  });

  it('collapses redundant font wrapper nesting from mathrm-mathbf round-trips', () => {
    // \mathrm and \mathbf both map through upright(...); the engine
    // canonicalizes to the shortest render-identical form.
    expect(wrapLatexToTypst('\\mathrm{\\mathbf{A}}').output).toBe('bold(A)');
    expect(wrapLatexToTypst('\\mathrm{\\mathrm{\\mathbf{A}}}').output).toBe('bold(A)');
  });

  it('preserves non-breaking spaces across round-trips', () => {
    const result = wrapLatexToTypst('x~y');

    expect(result.output).toBe('x space.nobreak y');
    expect(wrapTypstToLatex(result.output).output).toBe('x \\~ y');
  });
  it('round-trips \\infty through its engine-default spelling', () => {
    const result = wrapLatexToTypst('\\infty');

    expect(result.output).toBe('infinity');
    expect(wrapTypstToLatex(result.output).output).toBe('\\infty');
  });
});

describe('RichText Insertion & Selection Edge Cases', () => {
  const sampleLatex = { i: 'x' as const, text: '\\sum_{i=1}^n i', block: false };
  const blockLatex = { i: 'x' as const, text: '\\int_0^1 x dx', block: true };

  it('inserts into empty or undefined rich text', () => {
    expect(insertRichTextAtRange(undefined, [sampleLatex], { start: 0, end: 0 })).toEqual([
      sampleLatex,
    ]);
    expect(insertRichTextAtRange([], [sampleLatex], { start: 0, end: 0 })).toEqual([sampleLatex]);
  });

  it('inserts at the beginning of a string', () => {
    const result = insertRichTextAtRange(['world'], [sampleLatex], { start: 0, end: 0 });
    expect(result).toEqual([sampleLatex, 'world']);
  });

  it('inserts in the middle of a string', () => {
    const result = insertRichTextAtRange(['hello world'], [sampleLatex], { start: 6, end: 6 });
    expect(result).toEqual(['hello ', sampleLatex, 'world']);
  });

  it('inserts at the end of a string', () => {
    const result = insertRichTextAtRange(['hello'], [sampleLatex], { start: 5, end: 5 });
    expect(result).toEqual(['hello', sampleLatex]);
  });

  it('replaces a selected range of text', () => {
    const result = insertRichTextAtRange(['replace me please'], [sampleLatex], {
      start: 0,
      end: 10,
    });
    expect(result).toEqual([sampleLatex, ' please']);
  });

  it('replaces an existing math element with another without duplicating', () => {
    const richText = ['prefix ', sampleLatex, ' suffix'];
    const updated = insertRichTextAtRange(richText, [blockLatex], { start: 7, end: 8 });
    expect(updated).toEqual(['prefix ', blockLatex, ' suffix']);
  });

  it('toggles an existing math element, leaving the aligned environment untouched', () => {
    const inlineAligned = {
      i: 'x' as const,
      text: String.raw`\begin{aligned}x &= 1\end{aligned}`,
      block: false,
    };
    const richText = ['prefix ', inlineAligned, ' suffix'];

    const block = setMathBlockAtRange(richText, { start: 7, end: 8 }, true);
    expect(block).toEqual(['prefix ', { ...inlineAligned, block: true }, ' suffix']);

    expect(setMathBlockAtRange(block!, { start: 7, end: 8 }, false)).toEqual(richText);
    expect(setMathBlockAtRange(richText, { start: 0, end: 1 }, true)).toBeUndefined();
  });

  it('handles rich text containing complex Rem references and formatted objects', () => {
    const remRef = { i: 'q' as const, _id: 'rem_123' };
    const boldText = { i: 'm' as const, text: 'bold text' };
    const richText = ['start ', remRef, ' middle ', boldText, ' end'];

    const result = insertRichTextAtRange(richText, [sampleLatex], { start: 6, end: 6 });
    expect(result).toEqual(['start ', sampleLatex, remRef, ' middle ', boldText, ' end']);
  });

  it('inserts after atomic rich text elements at their right boundary', () => {
    const remRef = { i: 'q' as const, _id: 'rem_123' };
    const richText = ['before ', remRef, ' after'];

    const result = insertRichTextAtRange(richText, [sampleLatex], { start: 8, end: 8 });

    expect(result).toEqual(['before ', remRef, sampleLatex, ' after']);
  });

  it('does not select math when the caret is in surrounding whitespace', () => {
    const richText = [' ', sampleLatex, ' '];

    expect(findMathElementAtRange(richText, { start: 0, end: 0 })).toBeUndefined();
  });

  it('identifies native latex elements accurately', () => {
    expect(isNativeLatexElement(sampleLatex)).toBe(true);
    expect(isNativeLatexElement(blockLatex)).toBe(true);
    expect(isNativeLatexElement('plain text')).toBe(false);
    expect(isNativeLatexElement({ i: 'm', text: 'formatted' })).toBe(false);
    expect(isNativeLatexElement({ i: 'q', _id: '123' })).toBe(false);
    expect(isNativeLatexElement(null)).toBe(false);
    expect(isNativeLatexElement(123)).toBe(false);
  });

  it('finds existing math element among multiple math elements in the same Rem', () => {
    const math1 = { i: 'x' as const, text: 'a^2', block: false };
    const math2 = { i: 'x' as const, text: 'b^2', block: false };
    const math3 = { i: 'x' as const, text: 'c^2', block: true };
    const richText = ['Formula: ', math1, ' + ', math2, ' = ', math3];

    // Caret in plain text before math (offset 3)
    const inText = findMathElementAtRange(richText, { start: 3, end: 3 });
    expect(inText).toBeUndefined();

    // Caret on math1 (offset 9)
    const found1 = findMathElementAtRange(richText, { start: 9, end: 9 });
    expect(found1?.element.text).toBe('a^2');
    expect(found1?.range).toEqual({ start: 9, end: 10 });

    // Caret on math2 (offset 13)
    const found2 = findMathElementAtRange(richText, { start: 13, end: 13 });
    expect(found2?.element.text).toBe('b^2');

    // Caret on math3 (offset 17)
    const found3 = findMathElementAtRange(richText, { start: 17, end: 17 });
    expect(found3?.element.text).toBe('c^2');
    expect(found3?.element.block).toBe(true);
  });

  it('finds math element when caret is inside LaTeX sub-editor character offsets', () => {
    const mathElem = { i: 'x' as const, text: '\\sum_{i=1}^n i', block: false };
    const richText = ['hello ', mathElem, ' world'];

    // Sub-editor offset inside the LaTeX string
    const clickedInside = findMathElementAtRange(richText, { start: 15, end: 15 });
    expect(clickedInside).toBeDefined();
    expect(clickedInside?.element.text).toBe('\\sum_{i=1}^n i');
    expect(clickedInside?.range).toEqual({ start: 6, end: 7 });
  });

  it('ignores plain-text carets that merely sit after a long math element', () => {
    const mathElem = { i: 'x' as const, text: '\\sum_{i=1}^n i', block: false };
    const richText = [mathElem, ' end'];

    // Standard offsets deep inside trailing text must not be remapped into
    // the preceding math element's expanded span.
    expect(findMathElementAtRange(richText, { start: 2, end: 2 })).toBeUndefined();
    expect(findMathElementAtRange(richText, { start: 3, end: 4 })).toBeUndefined();
  });

  it('keeps resolving sub-editor offsets despite the plain-text guard', () => {
    const mathElem = { i: 'x' as const, text: '\\sum_{i=1}^n i', block: false };

    expect(findMathElementAtRange([mathElem], { start: 9, end: 9 })?.element.text).toBe(
      '\\sum_{i=1}^n i',
    );
    expect(findMathElementAtRange(['hi ', mathElem], { start: 12, end: 12 })?.element.text).toBe(
      '\\sum_{i=1}^n i',
    );
  });

  it('does not capture plain text sitting between two math elements', () => {
    const math1 = { i: 'x' as const, text: 'a^2', block: false };
    const math2 = { i: 'x' as const, text: 'b^2', block: false };

    expect(findMathElementAtRange([math1, ' + ', math2], { start: 2, end: 2 })).toBeUndefined();
  });
});

describe('Typst Prism Syntax Highlighting Edge Cases', () => {
  it('highlights typst math functions and parameters', () => {
    const html = highlightTypst('mat(delim: #none, 1, 2; 3, 4)');
    expect(html).toContain('token function');
    expect(html).toContain('token parameter');
    expect(html).toContain('token builtin');
    expect(html).toContain('token number');
  });

  it('highlights typst math operators and symbols', () => {
    const html = highlightTypst('sum_(i=1)^n alpha_i != 0');
    expect(html).toContain('token function');
    expect(html).toContain('token operator');
    expect(html).toContain('token symbol');
    expect(html).toContain('token number');
  });

  it('does not falsely highlight functions when part of a longer word', () => {
    const html = highlightTypst('summary + alphabet + matrices');
    expect(html).not.toContain('<span class="token function">sum</span>mary');
    expect(html).not.toContain('<span class="token symbol">alpha</span>bet');
    expect(html).not.toContain('<span class="token function">mat</span>rices');
  });

  it('correctly tokenizes numbers with unit suffixes', () => {
    const html = highlightTypst('12pt + 2.5em + 180deg');
    expect(html).toContain('<span class="token number">12pt</span>');
    expect(html).toContain('<span class="token number">2.5em</span>');
    expect(html).toContain('<span class="token number">180deg</span>');
  });

  it('highlights comments and strings with special symbols without corrupting grammar', () => {
    const html = highlightTypst('// comment with x + y\n"string with a/b"');
    expect(html).toContain('token comment');
    expect(html).toContain('token string');
  });
});
