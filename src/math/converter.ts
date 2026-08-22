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
    const rawResult = module.latexToTypstWithOptions(cleanSource, {
      full_document: false,
      pretty: false,
      no_preamble: true,
    });
    const result = convert(rawResult, 'LaTeX → Typst');

    // Strip wrapping $...$ if Tylax outputs it for display math
    let output = result.output.trim();
    if (output.startsWith('$') && output.endsWith('$') && output.length >= 2) {
      output = output.slice(1, -1).trim();
    }

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
