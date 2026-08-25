// Benchmark the save-path conversion cost against the committed WASM engine.
//
// Measures `typstToVerifiedLatex` semantics exactly as production runs them on
// Enter: one forward Typst → LaTeX conversion of user input, plus the bounded
// fixed-point verification loop (LaTeX → Typst → LaTeX probe legs, ≤6 cycles).
// Use it to confirm verification stays imperceptible after engine or shim
// changes: typical human-authored expressions should stay well under a frame
// budget (16.7 ms at 60 fps).
//
// Usage: npm run bench   (or: node scripts/bench-conversion.mjs)
import tylaxInit from '../public/wasm/tylax.js';
import * as tylax from '../public/wasm/tylax.js';
import { readFileSync } from 'node:fs';

const wasmUrl = new URL('../public/wasm/tylax_bg.wasm', import.meta.url);
await tylaxInit({ module_or_path: readFileSync(wasmUrl) });
const { typstToLatex, latexToTypst } = tylax;

const RUNS = 21;
const VERIFICATION_CYCLES = 6; // keep in sync with MAX_VERIFICATION_CYCLES in src/math/converter.ts

// Mirrors the TS wrappers' fixed policy so timings match production call sites.
function t2l(source, block) {
  return typstToLatex(source, block);
}
function l2t(source) {
  return latexToTypst(source);
}

/** One full verified-save simulation; returns wall time and engine-leg count. */
function verifiedSave(source, block) {
  let legs = 1;
  const start = performance.now();
  let current = t2l(source, block);
  for (let cycle = 0; cycle < VERIFICATION_CYCLES; cycle += 1) {
    const reverseTypst = l2t(current);
    legs += 1;
    if (/\/\*\s*LaTeX Error/.test(reverseTypst)) break;
    const next = t2l(reverseTypst, block);
    legs += 1;
    if (next === current) break;
    current = next;
  }
  return { ms: performance.now() - start, legs };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const cases = [
  ['simple', false, 'sum_(i=1)^n i'],
  ['fractions', false, 'frac(a,b) + frac(c,d) + frac(e,f)^2 - frac(g,h)_i'],
  ['integral', false, 'integral_0^oo e^(-x^2) dif x = frac(sqrt(pi), 2)'],
  ['matrix', false, 'mat(1, 2; 3, 4) dot mat(a; b)'],
  ['aligned', true, 'x &= 1 \\\\ &= 2 \\\\ &= 3'],
  ['nested', false, 'lim_(n->oo) sum_(i=1)^n frac(1, i(i+1)) = cases(1 "if" n > 0, 0 "otherwise")'],
  [
    'large (~700B)',
    false,
    `${'alpha beta gamma delta epsilon zeta eta theta, '.repeat(11)}sum_(k=1)^(oo) frac(1, k^2)`,
  ],
  ['extreme (~4KB)', false, `${'a+'.repeat(2000)}b`],
];

// Warm-up: first calls include WASM/JIT warm-up and would skew medians.
t2l('x', false);
l2t('\\alpha');
for (const [, block, source] of cases) verifiedSave(source, block);

console.log(`Save-path cost per expression (median of ${RUNS}, incl. verification legs):\n`);
for (const [name, block, source] of cases) {
  const runs = Array.from({ length: RUNS }, () => verifiedSave(source, block));
  const best = median(runs);
  const maxLegs = Math.max(...runs.map((r) => r.legs));
  console.log(
    `${name.padEnd(15)} input=${String(source.length).padStart(5)}B  ` +
      `${best.ms.toFixed(2).padStart(7)}ms  legs=${String(maxLegs).padStart(2)}  ` +
      `(frame budget 16.7ms)`,
  );
}
