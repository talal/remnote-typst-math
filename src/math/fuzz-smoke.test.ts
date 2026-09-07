import { describe, expect, it } from 'vitest';
import { runFuzz } from '../../scripts/fuzz-conversion';

// Smoke test over the seeded grammar fuzzer: a fixed seed keeps this fast
// and deterministic while guarding the oracles against harness rot. Deep
// time-boxed runs happen via `npm run fuzz` / CI, not here.
describe('Conversion Fuzzer Smoke', () => {
  it('finds no fixed-point, artifact, or brace-balance violations', () => {
    const { cases, failures } = runFuzz({ seconds: 0, iterations: 3000, seed: 42 });
    expect(cases).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
