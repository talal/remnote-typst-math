// Pure TypeScript Typst Math Engine.
// Full Typst math grammar -> KaTeX LaTeX emitter + canonical KaTeX -> Typst decompiler.
import * as tsEngine from './engine/index';

export type ConversionResult = {
  output: string;
};

export type ConverterEngine = {
  typstToLatex: (input: string, blockMathMode: boolean) => string;
  latexToTypst: (input: string) => string;
  detectFormat: (input: string) => string;
};

export type DetectedFormat = 'latex' | 'typst' | 'unknown';

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionError';
  }
}

// Generous headroom: vec(...) needs four cycles to converge; most others two.
const MAX_VERIFICATION_CYCLES = 6;

// --- Conversion cost guards -------------------------------------------------
//
// Refuse inputs beyond human-authored scale up front with a structured error.
// The caps sit far above anything real math produces (typical expressions are
// well under 2 KB at bracket depth < 20).
const MAX_CONVERSION_INPUT_LENGTH = 16_000;
const MAX_CONVERSION_NESTING_DEPTH = 64;

// Signals unsupported recovery comments (legacy Tylax output; the pure-TS
// engine never emits these, but injected mocks and foreign tools might).
const errorCommentPattern = /\/\*\s*LaTeX Error\b/;

// Backstop for the verification loop: every cycle re-converts the previous
// stage's output, so pathological inputs can compound growth across cycles.
const MAX_VERIFICATION_INTERMEDIATE_LENGTH = MAX_CONVERSION_INPUT_LENGTH;

/**
 * Maximum bracket nesting depth of a math source, treating backslash-escaped
 * characters as inert (LaTeX `\{` literals must not count) and ignoring
 * brackets inside strings and comments.
 */
function maxNestingDepth(source: string): number {
  let depth = 0;
  let maxDepth = 0;
  let inString = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (inString) {
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    // Line comments run to end of line; block comments run to the closer.
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 ? source.length : close + 1;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      if (depth > maxDepth) {
        maxDepth = depth;
      }
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
    }
  }

  return maxDepth;
}

function assertWithinConversionLimits(
  source: string,
  direction: 'Typst → LaTeX' | 'LaTeX → Typst',
): void {
  if (source.length > MAX_CONVERSION_INPUT_LENGTH) {
    throw new ConversionError(
      `${direction}: expression is too large to convert (${source.length} characters; the limit is ${MAX_CONVERSION_INPUT_LENGTH}).`,
    );
  }
  const depth = maxNestingDepth(source);
  if (depth > MAX_CONVERSION_NESTING_DEPTH) {
    throw new ConversionError(
      `${direction}: expression is nested too deeply to convert safely (depth ${depth}; the limit is ${MAX_CONVERSION_NESTING_DEPTH}).`,
    );
  }
}
// ---------------------------------------------------------------------------

/**
 * Refuse LaTeX with unbalanced braces (backslash-escaped braces are inert).
 * Stray closers like `}` can otherwise survive the fixed-point loop as stable
 * garbage — e.g. `}vec(x, y, z)` verified to `} \begin{pmatrix}…` — which
 * KaTeX cannot parse.
 */
function assertBalancedBraces(latex: string): void {
  const refuse = (): never => {
    throw new ConversionError(
      'This expression contains unbalanced braces and cannot be stored as LaTeX.',
    );
  };
  let depth = 0;
  for (let index = 0; index < latex.length; index += 1) {
    const char = latex[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth < 0) refuse();
    }
  }
  if (depth !== 0) refuse();
}

const defaultEngine: ConverterEngine = {
  typstToLatex: (input: string, blockMathMode: boolean) =>
    tsEngine.typstToLatex(input, blockMathMode),
  latexToTypst: (input: string) => tsEngine.latexToTypst(input),
  detectFormat: (input: string) => tsEngine.detectFormat(input),
};

let initializedModule: ConverterEngine = defaultEngine;

export function setInitializedModule(module: ConverterEngine): void {
  initializedModule = module;
}

export function resetInitializedModule(): void {
  initializedModule = defaultEngine;
}

export async function initializeConverter(): Promise<void> {
  // Pure TypeScript engine is synchronous and ready immediately.
  return Promise.resolve();
}

/**
 * Classify stored math content before conversion. Returns 'unknown' for
 * ambiguous or empty input so callers keep their existing LaTeX-first path.
 */
export function detectFormat(source: string): DetectedFormat {
  const cleanSource = source.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!cleanSource) {
    return 'unknown';
  }

  const detected = getInitializedModule().detectFormat(cleanSource);
  return detected === 'latex' || detected === 'typst' ? detected : 'unknown';
}

function getInitializedModule(): ConverterEngine {
  return initializedModule;
}

export function typstToLatex(source: string, isBlock = false): ConversionResult {
  const cleanSource = source.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!cleanSource) {
    throw new ConversionError('Typst math input cannot be empty.');
  }
  assertWithinConversionLimits(cleanSource, 'Typst → LaTeX');

  const module = getInitializedModule();
  try {
    const output = module.typstToLatex(cleanSource, isBlock);
    return { output };
  } catch (error: unknown) {
    throw toConversionError(error, 'Typst → LaTeX conversion failed');
  }
}

/**
 * Convert Typst to LaTeX and store the nearest stable form across conversion
 * cycles. Fresh user input frequently needs one normalization cycle before
 * its LaTeX reproduces itself when edited and re-saved (e.g. vec(...) ->
 * overrightarrow(...)), so cycles are walked until a fixed point is found.
 */
export function typstToVerifiedLatex(source: string, isBlock = false): ConversionResult {
  const result = typstToLatex(source, isBlock);
  let current = result.output;
  assertBalancedBraces(current);

  for (let cycle = 0; cycle < MAX_VERIFICATION_CYCLES; cycle += 1) {
    // Growth across cycles means the round trip is diverging, not stabilizing.
    if (current.length > MAX_VERIFICATION_INTERMEDIATE_LENGTH) {
      throw new ConversionError(
        'This expression keeps expanding as it is converted back and forth, which indicates malformed math rather than a storable expression.',
      );
    }

    let reverseTypst: string;
    try {
      reverseTypst = latexToTypst(current).output;
    } catch {
      // The reverse leg is unsupported for this construct, so instability
      // cannot be proven either way. Accept the current form rather than
      // blocking a legitimate save.
      return { output: current };
    }

    if (errorCommentPattern.test(reverseTypst)) {
      throw new ConversionError(
        'This expression contains constructs the converter does not support, and saving it could corrupt the math on a future edit.',
      );
    }

    if (hasShreddedWords(source, reverseTypst)) {
      throw new ConversionError(
        'This expression contains unrecognized symbols or constructs that do not survive round-trip conversion.',
      );
    }

    if (reverseTypst.length > MAX_VERIFICATION_INTERMEDIATE_LENGTH) {
      throw new ConversionError(
        'This expression keeps expanding as it is converted back and forth, which indicates malformed math rather than a storable expression.',
      );
    }

    let next: string;
    try {
      next = typstToLatex(reverseTypst, isBlock).output;
    } catch {
      return { output: current };
    }

    assertBalancedBraces(next);
    if (next === current) {
      return { output: current };
    }
    current = next;
  }

  throw new ConversionError(
    'This expression does not survive an edit cycle: converting it back and forth keeps changing the underlying LaTeX, so saving it now could corrupt it on a future edit.',
  );
}

export function latexToTypst(source: string): ConversionResult {
  const cleanSource = source.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!cleanSource) {
    throw new ConversionError('LaTeX math input cannot be empty.');
  }
  assertWithinConversionLimits(cleanSource, 'LaTeX → Typst');

  const module = getInitializedModule();
  try {
    // Strip display/inline math fences (`$$…$$`, `$…$`, possibly nested).
    let output = module.latexToTypst(cleanSource).trim();
    for (let pass = 0; pass < 3; pass += 1) {
      if (output.length >= 2 && output.startsWith('$') && output.endsWith('$')) {
        output = output.slice(1, -1).trim();
      } else {
        break;
      }
    }
    return { output };
  } catch (error: unknown) {
    throw toConversionError(error, 'LaTeX → Typst conversion failed');
  }
}

function toConversionError(error: unknown, prefix: string): ConversionError {
  if (error instanceof ConversionError) {
    return error;
  }

  // Deep operator chains (e.g. thousands of `a+a+…` with no brackets) can
  // overflow the call stack despite passing the bracket-depth guard. Report
  // those as complexity refusals instead of leaking engine internals.
  if (error instanceof RangeError) {
    return new ConversionError(
      `${prefix}: expression is too complex to convert safely (reduce chaining or nesting).`,
    );
  }

  if (error instanceof Error && error.message) {
    return new ConversionError(`${prefix}: ${error.message}`);
  }

  return new ConversionError(prefix);
}

function hasShreddedWords(original: string, decompiled: string): boolean {
  const idents = original.match(/[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*/g) || [];
  for (const ident of idents) {
    if (ident.length < 2 && !ident.includes('.')) continue;
    const chars = ident.split('').map((c) => (c === '.' ? '\\s*\\.\\s*' : c));
    const shreddedPattern = new RegExp(`\\b${chars.join('\\s+')}\\b`);
    if (shreddedPattern.test(decompiled) && !shreddedPattern.test(original)) {
      return true;
    }
  }
  return false;
}
