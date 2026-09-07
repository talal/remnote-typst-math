// Seeded grammar fuzzer for the TypeScript conversion engine.
//
// Exercises the SHIPPED save path (`typstToVerifiedLatex`) plus the reverse
// leg (`latexToTypst`) with generated and corpus-mutated inputs. Refusals
// (ConversionError) are PASSes — the engine is allowed to reject what it
// cannot faithfully convert. Only *accepted* bad output fails:
//
//   1. fixed-point: re-running latexToTypst + typstToLatex must reproduce the
//      stored LaTeX (a future edit must not mutate it);
//   2. artifacts: no `undefined`, `NaN`, `[object`, or `LaTeX Error` text;
//   3. brace balance: `{`/`}` balanced counting backslash-escapes as inert;
//   4. error discipline: only `Error` instances escape (no raw throws).
//
// Usage: npm run fuzz -- --seconds=120 --iterations=100000 --seed=1
//   --seconds=N     wall-clock budget (default 120, 0 = off)
//   --iterations=N  case budget (default 100000, 0 = unbounded); the run
//                   stops at whichever budget binds first
//   --seed=N        PRNG seed for deterministic replays (default 1)
import { latexToTypst, typstToLatex, typstToVerifiedLatex } from '../src/math/converter';

type FuzzOptions = { seconds: number; iterations: number; seed: number };

function parseArgs(argv: string[]): FuzzOptions {
  const options: FuzzOptions = { seconds: 120, iterations: 100000, seed: 1 };
  for (const arg of argv) {
    const match = arg.match(/^--(seconds|iterations|seed)=(\d+)$/);
    if (match) {
      options[match[1] as keyof FuzzOptions] = Number(match[2]);
    }
  }
  return options;
}

/** Deterministic PRNG (mulberry32) so failures replay with the same seed. */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Corpus: valid expressions mutated by token splicing --------------------
const CORPUS = [
  'sum_(i=1)^n i',
  'frac(a, b) + sqrt(x)',
  'mat(1, 2; 3, 4)',
  'vec(x, y, z)',
  'cases(1 "if" x > 0, 0 "otherwise")',
  'x &= 1 \\ y &= 2',
  'integral_0^oo e^(-x^2) dif x',
  'binom(n, k)',
  'floor(x) + ceil(y)',
  '[|x|] + norm(v)',
  "f'_1^2 + n!",
  'arrow.l(x) -> arrow.r(y)',
  '50% of x',
  'a thin b quad c',
  'attach(Pi, t: alpha)',
  'root(3, x)',
  'lim_(n->oo) 1/n',
];

const EDGE_TOKENS = [
  '%',
  '$',
  '#',
  '#none',
  '&',
  '\\',
  '\\\\',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  '[|',
  '|]',
  '_',
  '^',
  "'",
  '!',
  '/',
  ',',
  ';',
  ':',
  '"',
  '"a b"',
  '\\u{3b1}',
  '\\u{110000}',
  '/*c*/',
  '//c',
  '\\(',
  '\\_',
  '\\%',
  '\\!',
  '\\/',
  '\\big',
  '\\left',
  '\\right',
  '\\middle',
  '\\begin{cases}',
  '\\end{cases}',
  '.',
  '~',
  'None',
  'none',
];

// --- Grammar generation ------------------------------------------------------
const ATOMS = [
  'x',
  'y',
  'alpha',
  'sum',
  '12',
  '2.5',
  'f',
  'compose',
  'dif',
  'Dif',
  'NN',
  '"hi"',
  '"a b"',
  'approx.not',
  'arrow.r',
  'dots.up',
  'degree',
  '50%',
  'omicron',
  'mod',
  '#none',
  'oo',
  'infinity',
];
const INFIX = ['+', '-', '/', '_', '^', '=', '<', '>', '*', '&', '!=', '->', '<->', '~', "'"];
const CALLS = [
  'frac',
  'sqrt',
  'root',
  'binom',
  'mat',
  'vec',
  'cases',
  'hat',
  'arrow.l',
  'diaer',
  'display',
  'rect',
  'floor',
  'ceil',
  'abs',
  'norm',
  'cancel',
  'attach',
  'underbrace',
  'mod',
  'hide',
  'lr',
  'class',
];
const DELIMS: Array<[string, string]> = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['[|', '|]'],
  ['|', '|'],
];

export function createTypstGenerator(rand: () => number) {
  const int = (n: number): number => Math.floor(rand() * n);
  const pick = <T>(items: T[]): T => items[int(items.length)];
  const generate = (depth: number): string => {
    const roll = int(depth > 2 ? 70 : 100);
    if (roll < 32 || depth > 4) {
      const suffix = int(4) === 0 ? pick(["'", '!', '_1', '^2']) : '';
      return pick(ATOMS) + suffix;
    }
    if (roll < 46) {
      return `${generate(depth + 1)} ${pick(INFIX)} ${generate(depth + 1)}`;
    }
    if (roll < 60) {
      const name = pick(CALLS);
      const count = int(4);
      const args = Array.from({ length: count }, () => generate(depth + 1)).join(', ');
      return `${name}(${args})`;
    }
    if (roll < 70) {
      const [open, close] = pick(DELIMS);
      // Usually matched; occasionally mismatched/unclosed to probe refusal.
      const tail = int(6) === 0 ? pick([')', ']', '']) : close;
      return tail === '' ? `${open}${generate(depth + 1)}` : `${open}${generate(depth + 1)}${tail}`;
    }
    if (roll < 78) {
      return `"${pick(['a', 'x y', 'sp ace'])}"`;
    }
    return pick(EDGE_TOKENS);
  };
  return generate;
}

const LATEX_TOKENS = [
  '\\frac',
  '\\sqrt',
  '\\binom',
  '\\left',
  '\\right',
  '\\begin{cases}',
  '\\end{cases}',
  '\\begin{matrix}',
  '\\end{matrix}',
  '\\alpha',
  '\\not',
  '\\approx',
  '\\big',
  '\\middle',
  '\\displaystyle',
  '\\nonsensecmd',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  '&',
  '\\\\',
  '_',
  '^',
  "'",
  'x',
  '12',
  '$',
  '%',
  '#',
  '\\%',
  '\\,',
  '\\|',
  '\\langle',
];

export function createLatexGenerator(rand: () => number) {
  const int = (n: number): number => Math.floor(rand() * n);
  const pick = <T>(items: T[]): T => items[int(items.length)];
  return (): string => {
    const count = 1 + int(12);
    return Array.from({ length: count }, () => pick(LATEX_TOKENS)).join(int(3) === 0 ? ' ' : '');
  };
}

function mutateCorpus(rand: () => number, generate: (depth: number) => string): string {
  const base = CORPUS[Math.floor(rand() * CORPUS.length)];
  const tokens = base.split(/(\s+|[,;()[\]{}&^_'"/\\])/).filter((t) => t.length > 0);
  const operations = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < operations; i += 1) {
    const at = Math.floor(rand() * (tokens.length + 1));
    const edge = EDGE_TOKENS[Math.floor(rand() * EDGE_TOKENS.length)];
    const roll = rand();
    if (roll < 0.4) {
      tokens.splice(at, 0, edge);
    } else if (roll < 0.7 && tokens.length > 0) {
      tokens.splice(Math.floor(rand() * tokens.length), 1);
    } else if (tokens.length > 0) {
      tokens[Math.floor(rand() * tokens.length)] = edge;
    }
  }
  if (rand() < 0.25) return generate(1);
  return tokens.join('');
}

// --- Oracles ------------------------------------------------------------------
const ARTIFACT_PATTERN = /undefined|NaN|\[object|LaTeX Error/;

/** Escape-aware brace balance: backslash-escaped braces are inert. */
export function hasBalancedBraces(latex: string): boolean {
  let depth = 0;
  for (let i = 0; i < latex.length; i += 1) {
    const char = latex[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

type Failure = { signature: string; input: string; detail: string };

export function checkVerifiedSave(source: string, isBlock: boolean): Failure | undefined {
  let stored: string;
  try {
    stored = typstToVerifiedLatex(source, isBlock).output;
  } catch (error: unknown) {
    // Refusal is always acceptable; only non-Error throws are engine bugs.
    if (!(error instanceof Error)) {
      return {
        signature: 'non-error-throw',
        input: source,
        detail: `threw ${String(error).slice(0, 160)}`,
      };
    }
    return undefined;
  }
  if (ARTIFACT_PATTERN.test(stored)) {
    return { signature: 'artifact-in-output', input: source, detail: stored.slice(0, 220) };
  }
  if (!hasBalancedBraces(stored)) {
    return { signature: 'unbalanced-braces', input: source, detail: stored.slice(0, 220) };
  }
  let roundTrip: string;
  try {
    roundTrip = latexToTypst(stored).output;
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      return {
        signature: 'non-error-throw-reverse',
        input: source,
        detail: `stored ${stored.slice(0, 120)} threw ${String(error).slice(0, 120)}`,
      };
    }
    // Reverse leg unsupported: stability unprovable either way (converter
    // policy accepts the current form), so this is not a failure.
    return undefined;
  }
  let again: string;
  try {
    again = typstToLatex(roundTrip, isBlock).output;
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      return {
        signature: 'non-error-throw-forward',
        input: source,
        detail: `reverse ${roundTrip.slice(0, 120)} threw ${String(error).slice(0, 120)}`,
      };
    }
    return undefined;
  }
  if (again !== stored) {
    return {
      signature: 'unstable-fixed-point',
      input: source,
      detail:
        `stored=${stored.slice(0, 140)} ` +
        `reverse=${roundTrip.slice(0, 140)} again=${again.slice(0, 140)}`,
    };
  }
  return undefined;
}

export function checkLatexDecompile(source: string): Failure | undefined {
  let decompiled: string;
  try {
    decompiled = latexToTypst(source).output;
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      return {
        signature: 'latex-non-error-throw',
        input: source,
        detail: `threw ${String(error).slice(0, 160)}`,
      };
    }
    return undefined;
  }
  if (ARTIFACT_PATTERN.test(decompiled)) {
    return { signature: 'latex-artifact', input: source, detail: decompiled.slice(0, 220) };
  }
  return undefined;
}

// --- Runner --------------------------------------------------------------------
export function runFuzz(options: FuzzOptions): { cases: number; failures: Failure[] } {
  const rand = createRng(options.seed);
  const generate = createTypstGenerator(rand);
  const generateLatex = createLatexGenerator(rand);
  const failures: Failure[] = [];
  const seen = new Set<string>();
  const deadline = options.seconds > 0 ? Date.now() + options.seconds * 1000 : Infinity;
  const cap = options.iterations > 0 ? options.iterations : Infinity;
  let cases = 0;

  const consider = (failure: Failure | undefined): void => {
    if (failure && !seen.has(`${failure.signature}::${failure.input}`)) {
      seen.add(`${failure.signature}::${failure.input}`);
      failures.push(failure);
    }
  };

  // Seed the generator state with the corpus so early cases are realistic.
  for (const seedInput of CORPUS) {
    if (cases >= cap || Date.now() >= deadline) break;
    consider(checkVerifiedSave(seedInput, cases % 2 === 0));
    cases += 1;
  }

  while (cases < cap && Date.now() < deadline) {
    const source = rand() < 0.5 ? generate(0) : mutateCorpus(rand, generate);
    consider(checkVerifiedSave(source, rand() < 0.5));
    cases += 1;
    if (cases < cap && Date.now() < deadline) {
      consider(checkLatexDecompile(generateLatex()));
      cases += 1;
    }
  }
  return { cases, failures };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const { cases, failures } = runFuzz(options);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `fuzz: ${cases} cases in ${elapsed}s ` +
      `(seed=${options.seed}, iterations=${options.iterations}, seconds=${options.seconds})`,
  );
  if (failures.length === 0) {
    console.log('fuzz: CLEAN — no invariant violations');
    return;
  }
  console.log(`fuzz: ${failures.length} distinct failures`);
  for (const failure of failures.slice(0, 25)) {
    console.log(`- [${failure.signature}] input=${JSON.stringify(failure.input)}`);
    console.log(`  ${failure.detail}`);
  }
  if (failures.length > 25) {
    console.log(`  … and ${failures.length - 25} more (fix these first, then re-run)`);
  }
  process.exitCode = 1;
}

// Only auto-run as a CLI entrypoint; unit tests import the oracles above.
// (This vite-node version consumes the script path itself, so argv carries
// no reliable marker — the npm script sets FUZZ_CLI=1 instead.)
if (process.env.FUZZ_CLI === '1') {
  main();
}
