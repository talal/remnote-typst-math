// Benchmark the save-path conversion cost against the pure TypeScript engine.
//
// Measures `typstToVerifiedLatex` semantics exactly as production runs them on
// Enter: one forward Typst → LaTeX conversion of user input, plus the bounded
// fixed-point verification loop (LaTeX → Typst → LaTeX probe legs, ≤6 cycles).
// Typical human-authored expressions should stay well under a frame
// budget (16.7 ms at 60 fps).
//
// Usage: npm run bench   (or: vp exec vite-node --script scripts/bench-conversion.ts)
import { typstToVerifiedLatex } from '../src/math/converter';

const RUNS = 21;

/** One full verified-save run; returns wall time (null when refused). */
function verifiedSave(source: string, block: boolean): { ms: number } | null {
  const start = performance.now();
  try {
    typstToVerifiedLatex(source, block);
  } catch {
    return null;
  }
  return { ms: performance.now() - start };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const cases: [string, boolean, string][] = [
  ['simple', false, 'sum_(i=1)^n i'],
  ['fractions', false, 'frac(a,b) + frac(c,d) + frac(e,f)^2 - frac(g,h)_i'],
  ['integral', false, 'integral_0^oo e^(-x^2) dif x = frac(sqrt(pi), 2)'],
  ['matrix', false, 'mat(1, 2; 3, 4) dot mat(a; b)'],
  ['aligned', true, 'x &= 1 \\\\ &= 2 \\\\ &= 3'],
  ['nested', false, 'lim_(n->oo) sum_(i=1)^n frac(1, i(i+1)) = cases(1 "if" n > 0, 0 "otherwise")'],
  [
    'large (~540B)',
    false,
    `${'alpha beta gamma delta epsilon zeta eta theta, '.repeat(11)}sum_(k=1)^(oo) frac(1, k^2)`,
  ],
  ['extreme (~4KB)', false, `${'a+'.repeat(2000)}b`],
];

// Warm-up: JIT warm-up to eliminate initial JIT compilation overhead.
// Refusals are skipped here and reported per-case below.
for (const [, block, source] of cases) {
  verifiedSave(source, block);
}

console.log(`Save-path cost per expression (median of ${RUNS}, incl. full verification):\n`);
for (const [name, block, source] of cases) {
  const samples = Array.from({ length: RUNS }, () => verifiedSave(source, block)).filter(
    (r): r is { ms: number } => r !== null,
  );
  if (samples.length === 0) {
    console.log(
      `${name.padEnd(15)} input=${String(source.length).padStart(5)}B  ` + `refused by verifier`,
    );
    continue;
  }
  const best = median(samples.map((r) => r.ms));
  console.log(
    `${name.padEnd(15)} input=${String(source.length).padStart(5)}B  ` +
      `${best.toFixed(3).padStart(7)}ms  ` +
      `(frame budget 16.7ms)`,
  );
}
