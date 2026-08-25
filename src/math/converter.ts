// WASM engine built from crates/engine (npm run build:wasm); the tylax
// dependency is pinned in crates/engine/Cargo.toml.
// public/wasm/tylax.js and public/wasm/tylax_bg.wasm are regenerated together.
//
// The engine exports a minimal surface: conversions take math source (plus the
// inline/block distinction) and return a string or throw; all conversion
// options are fixed policy on the Rust side.
export type ConversionResult = {
  output: string;
};

type TylaxModule = {
  default: (input?: unknown) => Promise<unknown>;
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

const tylaxModulePath = './wasm/tylax.js';
const explicitSpaceMarkerBase = 'REMNOTEEXPLICITSPACEMARKER';
const nonBreakingSpaceMarkerBase = 'REMNOTENOBREAKSPACEMARKER';

// Generous headroom: vec(...) needs four cycles to converge; most others two.
const MAX_VERIFICATION_CYCLES = 6;

// --- Conversion cost guards -------------------------------------------------
//
// Tylax's conversion cost is superlinear on pathological inputs (fuzzing found
// exponential blowups in Typst → LaTeX once deeply nested scripts combine with
// its `/* LaTeX Error: ... */` recovery comments). A conversion that runs away
// would freeze RemNote's main thread with no way to interrupt WASM, so inputs
// beyond human-authored scale are refused up front with a structured error.
// The caps sit far above anything real math produces (typical expressions are
// well under 2 KB at bracket depth < 20).
const MAX_CONVERSION_INPUT_LENGTH = 16_000;
const MAX_CONVERSION_NESTING_DEPTH = 64;

// Tylax signals unsupported constructs by embedding this comment in its
// output. Such output is already non-canonical, and re-converting it is the
// known path to runaway cost, so verified-latex refuses instead of cycling it.
const tylaxErrorCommentPattern = /\/\*\s*LaTeX Error\b/;

// Backstop for the verification loop: every cycle re-converts the previous
// stage's output, so pathological inputs can compound growth across cycles
// even when no error marker appears. Anything larger than the input cap can
// no longer be human-authored math, so stop before feeding it to the engine.
const MAX_VERIFICATION_INTERMEDIATE_LENGTH = MAX_CONVERSION_INPUT_LENGTH;

/**
 * Maximum bracket nesting depth of a math source, treating backslash-escaped
 * characters as inert (LaTeX `\{` literals must not count).
 */
function maxNestingDepth(source: string): number {
  let depth = 0;
  let maxDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
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

const relationOperatorCharacters = '!<=>:|+*/~^-';
const namedRelationOperators: Record<string, string> = {
  approx: 'approx',
  colon: 'colon',
  divides: 'divides',
  in: 'in',
  'in.not': 'in.not',
  prop: 'prop',
  'subset.eq': 'subset.eq',
  'supset.eq': 'supset.eq',
  tilde: 'tilde.op',
};

function createUniqueMarker(source: string, base: string): string {
  let marker = base;
  while (source.includes(marker)) {
    marker += 'X';
  }
  return marker;
}

function findMatchingDelimiter(
  source: string,
  openingIndex: number,
  opening: string,
  closing: string,
): number {
  let depth = 0;

  for (let index = openingIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }

    if (char === opening) {
      depth += 1;
    } else if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function findLatexTextArguments(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const textCommand = /\\text\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = textCommand.exec(source))) {
    const openingIndex = match.index + match[0].length - 1;
    const closingIndex = findMatchingDelimiter(source, openingIndex, '{', '}');
    if (closingIndex !== -1) {
      ranges.push([match.index, closingIndex]);
    }
  }

  return ranges;
}
function extractLatexTextContents(source: string): string[] {
  const contents: string[] = [];

  for (const [start, end] of findLatexTextArguments(source)) {
    const openingIndex = source.indexOf('{', start);
    if (openingIndex !== -1 && openingIndex < end) {
      contents.push(source.slice(openingIndex + 1, end));
    }
  }

  return contents;
}

function unescapeLatexTextContent(content: string): string {
  const escapedCharacters = '\\{}[]"#$%&_ ';
  let normalized = '';

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const nextCharacter = content[index + 1];

    if (character === '\\' && nextCharacter && escapedCharacters.includes(nextCharacter)) {
      normalized += nextCharacter;
      index += 1;
    } else {
      normalized += character;
    }
  }

  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
}

function markLatexSpaces(
  source: string,
  explicitSpaceMarker: string,
  nonBreakingSpaceMarker: string,
): string {
  const textArgumentRanges = findLatexTextArguments(source);
  let markedSource = '';

  for (let index = 0; index < source.length;) {
    const nextCharacter = source[index + 1];
    const nextNextCharacter = source[index + 2];
    const insideTextArgument = textArgumentRanges.some(
      ([start, end]) => index >= start && index <= end,
    );
    const isControlSpace =
      source[index] === '\\' &&
      (nextCharacter === ' ' ||
        nextCharacter === '\t' ||
        nextCharacter === '\r' ||
        nextCharacter === '\n') &&
      (index === 0 || source[index - 1] !== '\\') &&
      !insideTextArgument;
    const isNonBreakingSpace =
      !insideTextArgument &&
      ((source[index] === '~' && (index === 0 || source[index - 1] !== '\\')) ||
        (source[index] === '\\' &&
          nextCharacter === '~' &&
          (nextNextCharacter === undefined ||
            nextNextCharacter === ' ' ||
            nextNextCharacter === '\t' ||
            nextNextCharacter === '\r' ||
            nextNextCharacter === '\n')));

    if (isControlSpace) {
      markedSource += `\\text{${explicitSpaceMarker}}`;
      index += 1;
      while (
        source[index] === ' ' ||
        source[index] === '\t' ||
        source[index] === '\r' ||
        source[index] === '\n'
      ) {
        index += 1;
      }
      continue;
    }

    if (isNonBreakingSpace) {
      markedSource += `\\text{${nonBreakingSpaceMarker}}`;
      index += source[index] === '\\' ? 2 : 1;
      while (
        source[index] === ' ' ||
        source[index] === '\t' ||
        source[index] === '\r' ||
        source[index] === '\n'
      ) {
        index += 1;
      }
      continue;
    }

    markedSource += source[index];
    index += 1;
  }

  return markedSource;
}
function normalizeTylaxRelationClasses(source: string): string {
  const normalized = source.replace(/class\("relation",\s*([^()]*)\)/g, (match, value: string) => {
    const relationName = value.trim();
    const namedRelation = namedRelationOperators[relationName];
    if (namedRelation) {
      return namedRelation;
    }

    const operator = relationName.replace(/\s+/g, '');
    if (
      !operator ||
      operator.split('').some((character) => !relationOperatorCharacters.includes(character))
    ) {
      return match;
    }

    return operator;
  });

  return normalized.replace(/(^|[\s({,;])tilde(?=$|[\s)},;])/g, '$1tilde.op');
}

function normalizeTylaxBracketFunctions(source: string): string {
  const callPrefix = '#underline[';
  let normalized = '';
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf(callPrefix, cursor);
    if (start === -1) {
      normalized += source.slice(cursor);
      break;
    }

    const openingIndex = start + callPrefix.length - 1;
    const closingIndex = findMatchingDelimiter(source, openingIndex, '[', ']');
    if (closingIndex === -1) {
      normalized += source.slice(cursor);
      break;
    }

    normalized += source.slice(cursor, start);
    normalized += `underline(${source.slice(openingIndex + 1, closingIndex)})`;
    cursor = closingIndex + 1;
  }

  return normalized;
}

/**
 * Collapse redundant `upright(upright(...))` nesting produced by round-tripping
 * `\mathrm{\mathbf{...}}`: Tylax maps both `\mathrm` and `\mathbf` to
 * `upright(...)` wrappers, so every edit cycle would otherwise add a layer and
 * the LaTeX would never reach a stable form.
 */
function normalizeRedundantUprightNesting(source: string): string {
  let normalized = source;

  for (;;) {
    const index = normalized.indexOf('upright(upright(');
    if (index === -1) {
      return normalized;
    }

    const outerOpen = index + 'upright'.length;
    const innerTokenStart = outerOpen + 1;
    const innerOpen = innerTokenStart + 'upright'.length;
    const innerClose = findMatchingDelimiter(normalized, innerOpen, '(', ')');
    const outerClose = findMatchingDelimiter(normalized, outerOpen, '(', ')');
    if (innerClose === -1 || outerClose === -1) {
      return normalized;
    }

    const innerContent = normalized.slice(innerOpen + 1, innerClose);
    normalized =
      normalized.slice(0, index) + `upright(${innerContent})` + normalized.slice(outerClose + 1);
  }
}

function normalizeTylaxText(
  source: string,
  explicitSpaceMarker: string,
  nonBreakingSpaceMarker: string,
  latexTextContents: string[],
): string {
  const textCall = '#text[';
  let normalized = '';
  let cursor = 0;
  let textIndex = 0;

  while (cursor < source.length) {
    const start = source.indexOf(textCall, cursor);
    if (start === -1) {
      normalized += source.slice(cursor);
      break;
    }

    const openingIndex = start + textCall.length - 1;
    const closingIndex = findMatchingDelimiter(source, openingIndex, '[', ']');
    if (closingIndex === -1) {
      normalized += source.slice(cursor);
      break;
    }

    const content = source.slice(openingIndex + 1, closingIndex);
    const latexContent = latexTextContents[textIndex];
    const isExplicitSpace = content === explicitSpaceMarker || latexContent === explicitSpaceMarker;
    const isNonBreakingSpace =
      content === nonBreakingSpaceMarker || latexContent === nonBreakingSpaceMarker;
    const textContent =
      latexContent === undefined ? content : unescapeLatexTextContent(latexContent);

    normalized += source.slice(cursor, start);
    normalized += isExplicitSpace
      ? 'space'
      : isNonBreakingSpace
        ? 'space.nobreak'
        : JSON.stringify(textContent);
    cursor = closingIndex + 1;
    textIndex += 1;
  }

  return normalized;
}

let initializationPromise: Promise<TylaxModule> | undefined;
let initializedModule: TylaxModule | undefined;

async function loadTylax(): Promise<TylaxModule> {
  // Static import cannot work: webpack copies this browser asset to public/wasm.
  const module = (await import(
    /* webpackIgnore: true */
    tylaxModulePath
  )) as unknown as TylaxModule;

  if (typeof module.default !== 'function') {
    throw new ConversionError('Tylax WASM module has no initializer.');
  }

  await module.default();
  return module;
}

export function setInitializedModule(module: TylaxModule): void {
  initializedModule = module;
}

export async function initializeConverter(): Promise<void> {
  if (initializedModule) {
    return;
  }

  if (!initializationPromise) {
    initializationPromise = loadTylax().catch((error: unknown) => {
      initializationPromise = undefined;
      throw toConversionError(error, 'Unable to initialize Tylax WASM');
    });
  }

  initializedModule = await initializationPromise;
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

function getInitializedModule(): TylaxModule {
  if (!initializedModule) {
    throw new ConversionError(
      'The Tylax converter is not initialized. Call initializeConverter() first.',
    );
  }

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
    // Alignment canonicalization to \begin{aligned} happens engine-side.
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
 * Refusals: a persistent mutation (saving it would corrupt the math on every
 * future edit), and a reverse leg that degrades into tylax error comments
 * (already lossy, and re-converting such output risks runaway engine cost).
 */
export function typstToVerifiedLatex(source: string, isBlock = false): ConversionResult {
  const result = typstToLatex(source, isBlock);
  let current = result.output;

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

    // A degraded reverse conversion means the round trip already lost
    // fidelity; re-entering Typst → LaTeX with error-recovery output is also
    // the known trigger for runaway engine cost. Refuse instead of cycling.
    if (tylaxErrorCommentPattern.test(reverseTypst)) {
      throw new ConversionError(
        'This expression contains constructs the converter does not support, and saving it could corrupt the math on a future edit.',
      );
    }

    // Same divergence backstop applies before the reversed form re-enters the
    // engine, so cap violations never surface as swappable "leg failed" cases.
    if (reverseTypst.length > MAX_VERIFICATION_INTERMEDIATE_LENGTH) {
      throw new ConversionError(
        'This expression keeps expanding as it is converted back and forth, which indicates malformed math rather than a storable expression.',
      );
    }

    let next: string;
    try {
      next = typstToLatex(reverseTypst, isBlock).output;
    } catch {
      // The forward leg failed on the reversed form, so instability cannot
      // be proven either way. Accept the current form rather than blocking
      // a legitimate save.
      return { output: current };
    }

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
    const explicitSpaceMarker = createUniqueMarker(cleanSource, explicitSpaceMarkerBase);
    const nonBreakingSpaceMarker = createUniqueMarker(cleanSource, nonBreakingSpaceMarkerBase);
    const sourceWithSpaceMarkers = markLatexSpaces(
      cleanSource,
      explicitSpaceMarker,
      nonBreakingSpaceMarker,
    );
    const latexTextContents = extractLatexTextContents(sourceWithSpaceMarkers);
    // Engine options are fixed policy on the Rust side (shorthands on, simple
    // fractions as slashes, `infinity` spelling, lenient unknowns, no preamble).
    let output = module.latexToTypst(sourceWithSpaceMarkers).trim();
    if (output.startsWith('$') && output.endsWith('$') && output.length >= 2) {
      output = output.slice(1, -1).trim();
    }

    output = normalizeTylaxRelationClasses(output);
    output = normalizeTylaxBracketFunctions(output);
    output = normalizeRedundantUprightNesting(output);
    output = normalizeTylaxText(
      output,
      explicitSpaceMarker,
      nonBreakingSpaceMarker,
      latexTextContents,
    );

    return { output };
  } catch (error: unknown) {
    throw toConversionError(error, 'LaTeX → Typst conversion failed');
  }
}

function toConversionError(error: unknown, prefix: string): ConversionError {
  if (error instanceof ConversionError) {
    return error;
  }

  if (error instanceof Error && error.message) {
    return new ConversionError(`${prefix}: ${error.message}`);
  }

  return new ConversionError(prefix);
}
