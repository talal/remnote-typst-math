export type ConversionResult = {
  output: string;
  warnings: string[];
};

type TylaxRawResult = {
  output?: unknown;
  success?: unknown;
  error?: unknown;
  warnings?: unknown;
};

type TylaxModule = {
  default: (input?: unknown) => Promise<unknown>;
  typstToLatexWithOptions: (input: string, options: Record<string, unknown>) => unknown;
  latexToTypstWithOptions: (input: string, options: Record<string, unknown>) => unknown;
};

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionError';
  }
}

const tylaxModulePath = './wasm/tylax.js';
const explicitSpaceMarkerBase = 'REMNOTEEXPLICITSPACEMARKER';
const nonBreakingSpaceMarkerBase = 'REMNOTENOBREAKSPACEMARKER';

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

function getInitializedModule(): TylaxModule {
  if (!initializedModule) {
    throw new ConversionError(
      'The Tylax converter is not initialized. Call initializeConverter() first.',
    );
  }

  return initializedModule;
}

function convert(
  rawResult: unknown,
  direction: 'Typst → LaTeX' | 'LaTeX → Typst',
): ConversionResult {
  if (!rawResult || typeof rawResult !== 'object') {
    throw new ConversionError(`${direction} returned an invalid result.`);
  }

  const result = rawResult as TylaxRawResult;
  const output = typeof result.output === 'string' ? result.output : '';
  const warnings = Array.isArray(result.warnings)
    ? result.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];

  if (result.success === false) {
    const message = typeof result.error === 'string' ? result.error : 'Unknown conversion error.';
    throw new ConversionError(`${direction} failed: ${message}`);
  }

  if (!output.trim()) {
    throw new ConversionError(`${direction} returned no output.`);
  }

  return { output, warnings };
}

export function typstToLatex(source: string, isBlock = false): ConversionResult {
  const cleanSource = source.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!cleanSource) {
    throw new ConversionError('Typst math input cannot be empty.');
  }

  const module = getInitializedModule();
  try {
    const rawResult = module.typstToLatexWithOptions(cleanSource, {
      full_document: false,
      block_math_mode: isBlock,
    });
    const result = convert(rawResult, 'Typst → LaTeX');

    // KaTeX inline math does not allow top-level \begin{align}. Convert to \begin{aligned} for inline mode.
    let output = result.output;
    if (!isBlock) {
      output = output
        .replace(/\\begin\{align\*?\}/g, '\\begin{aligned}')
        .replace(/\\end\{align\*?\}/g, '\\end{aligned}');
    }

    return { ...result, output };
  } catch (error: unknown) {
    throw toConversionError(error, 'Typst → LaTeX conversion failed');
  }
}

export function latexToTypst(source: string): ConversionResult {
  const cleanSource = source.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!cleanSource) {
    throw new ConversionError('LaTeX math input cannot be empty.');
  }

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
    const rawResult = module.latexToTypstWithOptions(sourceWithSpaceMarkers, {
      full_document: false,
      pretty: false,
      no_preamble: true,
    });
    const result = convert(rawResult, 'LaTeX → Typst');

    // Strip wrapping $...$ if Tylax outputs it for display math.
    let output = result.output.trim();
    if (output.startsWith('$') && output.endsWith('$') && output.length >= 2) {
      output = output.slice(1, -1).trim();
    }

    output = normalizeTylaxRelationClasses(output);
    output = normalizeTylaxBracketFunctions(output);
    output = normalizeTylaxText(
      output,
      explicitSpaceMarker,
      nonBreakingSpaceMarker,
      latexTextContents,
    );

    return { ...result, output };
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
