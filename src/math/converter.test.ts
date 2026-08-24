import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as tylax from '../../public/wasm/tylax.js';
import {
  initSync,
  latexToTypstWithOptions,
  typstToLatexWithOptions,
} from '../../public/wasm/tylax.js';
import {
  ConversionError,
  latexToTypst as wrapLatexToTypst,
  setInitializedModule,
  typstToLatex as wrapTypstToLatex,
} from './converter';
import {
  findMathElementAtRange,
  insertRichTextAtRange,
  isNativeLatexElement,
} from './remnote-math';
import { highlightTypst } from './typst-grammar';

beforeAll(() => {
  initSync({
    module: readFileSync(resolve(process.cwd(), 'public/wasm/tylax_bg.wasm')),
  });
  setInitializedModule(tylax as any);
});

type RawConversionResult = {
  output: string;
  success: boolean;
  error?: string;
};

function typstToLatexRaw(source: string): RawConversionResult {
  return typstToLatexWithOptions(source, {
    full_document: false,
    block_math_mode: false,
  }) as RawConversionResult;
}

function latexToTypstRaw(source: string): RawConversionResult {
  return latexToTypstWithOptions(source, {
    full_document: false,
    pretty: false,
    no_preamble: true,
  }) as RawConversionResult;
}
function generateBidirectionalFuzzCorpus(seed: number, count: number): string[] {
  const atoms = ['x', 'y', 'z', 'a', 'b', 'n', 'alpha', 'beta', 'RR', 'NN', '0', '1', '2', 'pi'];
  const operators = ['+', '-', '=', '<', '>', '<=', '>=', '!=', ':=', '->', '<=>', 'in', 'times'];
  const textValues = [
    'is natural',
    'if',
    'otherwise',
    'a [b] c',
    'quote " text',
    'units: kg',
    'left { right }',
  ];
  const corpus = [
    'cal(A) := { x in RR | x space "is natural" }',
    'x space "a [b] c"',
    'x space "a {b} c"',
    `x space ${JSON.stringify('quote " text')}`,
  ];
  let state = seed >>> 0;

  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const left = atoms[state % atoms.length];
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const right = atoms[state % atoms.length];
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const operator = operators[state % operators.length];
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const textLiteral = JSON.stringify(textValues[state % textValues.length]);

    switch (index % 6) {
      case 0:
        corpus.push(`${left} ${operator} ${right}`);
        break;
      case 1:
        corpus.push(`${left}^(${right})`);
        break;
      case 2:
        corpus.push(`${left} / ${right}`);
        break;
      case 3:
        corpus.push(`sqrt(${left} + ${right})`);
        break;
      case 4:
        corpus.push(`${left} space ${textLiteral}`);
        break;
      default:
        corpus.push(`{ ${left} ${operator} ${right} | ${right} space ${textLiteral} }`);
        break;
    }
  }

  return corpus;
}

describe('Tylax Math WASM Low-level Conversions', () => {
  it.each([
    ['x^2', 'x'],
    ['a / b', 'frac'],
    ['sqrt(x)', 'sqrt'],
    ['sum_(i=1)^n i', 'sum'],
    ['integral_0^oo e^(-x^2) dif x', 'int'],
    ['mat(1, 2; 3, 4)', 'matrix'],
    ['vec(1, 2, 3)', 'vec'],
    ['lim_(x -> 0) (sin(x)) / x', 'lim'],
    ['nabla times bold(E) = - partial(bold(B)) / partial(t)', 'nabla'],
    ['forall x exists y (x < y)', 'forall'],
  ])('converts %s to LaTeX containing %s', (source, expectedFragment) => {
    const result = typstToLatexRaw(source);
    expect(result.success).toBe(true);
    expect(result.output).toContain(expectedFragment);
  });

  it('converts representative LaTeX to Typst', () => {
    const result = latexToTypstRaw('\\frac{1}{2} + \\alpha');
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/frac|\//);
    expect(result.output).toMatch(/alpha|α/);
  });

  it('reports a structured result for invalid input', () => {
    const result = typstToLatexRaw('frac(');
    expect(result).toHaveProperty('success');
    expect(typeof result.output).toBe('string');
  });

  it('converts multiline aligned math in inline and block modes', () => {
    const multilineTypst = `sum_(k=0)^n k
    &= 1 + ... + n \\
    &= (n(n+1)) / 2`;

    const blockRes = typstToLatexWithOptions(multilineTypst, {
      full_document: false,
      block_math_mode: true,
    }) as RawConversionResult;
    expect(blockRes.output).toContain('align');

    const rawInline = typstToLatexWithOptions(multilineTypst, {
      full_document: false,
      block_math_mode: false,
    }) as RawConversionResult;
    const inlineKaTeX = rawInline.output
      .replace(/\\begin\{align\*?\}/g, '\\begin{aligned}')
      .replace(/\\end\{align\*?\}/g, '\\end{aligned}');
    expect(inlineKaTeX).toContain('aligned');

    const backToTypst = latexToTypstWithOptions(inlineKaTeX, {
      full_document: false,
      pretty: false,
      no_preamble: true,
    }) as RawConversionResult;
    expect(backToTypst.output).toContain('sum_');
  });
});

describe('Converter Module Wrapper & Sanitization', () => {
  it('throws ConversionError on empty or whitespace-only input', () => {
    expect(() => wrapTypstToLatex('')).toThrow(ConversionError);
    expect(() => wrapTypstToLatex('   \n\t  ')).toThrow(ConversionError);
    expect(() => wrapLatexToTypst('')).toThrow(ConversionError);
    expect(() => wrapLatexToTypst('   \t  ')).toThrow(ConversionError);
  });

  it('strips zero-width characters (ZWSP) before conversion', () => {
    const withZwsp = '\u200Bx^2\u200D + \uFEFFy^2';
    const result = wrapTypstToLatex(withZwsp);
    expect(result.output).toContain('x^2');
    expect(result.output).toContain('y^2');
    expect(result.output).not.toContain('\u200B');
    expect(result.output).not.toContain('\uFEFF');
  });

  it('translates begin{align} to begin{aligned} in inline mode and preserves align in block mode', () => {
    const code = 'x &= 1 \\\n&= 2';
    const inlineResult = wrapTypstToLatex(code, false);
    expect(inlineResult.output).toContain('\\begin{aligned}');
    expect(inlineResult.output).toContain('\\end{aligned}');
    expect(inlineResult.output).not.toContain('\\begin{align}');

    const blockResult = wrapTypstToLatex(code, true);
    expect(blockResult.output).toContain('align');
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

  it('preserves non-breaking spaces across round-trips', () => {
    const result = wrapLatexToTypst('x~y');

    expect(result.output).toBe('x space.nobreak y');
    expect(wrapTypstToLatex(result.output).output).toBe('x \\~ y');
  });
  it('keeps a deterministic fuzz corpus stable across repeated round-trips', () => {
    const corpus = generateBidirectionalFuzzCorpus(0x5eed1234, 96);

    corpus.forEach((source, index) => {
      const label = `fuzz case ${index}: ${source}`;
      let firstLatex: string;
      let firstTypst: string;
      let secondLatex: string;
      let secondTypst: string;

      try {
        firstLatex = wrapTypstToLatex(source).output;
        firstTypst = wrapLatexToTypst(firstLatex).output;
        secondLatex = wrapTypstToLatex(firstTypst).output;
        secondTypst = wrapLatexToTypst(secondLatex).output;
      } catch (error: unknown) {
        throw new Error(`${label} failed: ${String(error)}`);
      }

      expect(firstTypst, label).not.toContain('#text[');
      expect(firstTypst, label).not.toContain('class("relation",');
      expect(secondTypst, label).toBe(firstTypst);
      expect(secondLatex, label).toBe(firstLatex);
    });
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
