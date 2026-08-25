//! Round-trip harness: exercises full edit cycles on arbitrary input.
//!
//! Catches panics, hangs, and crashes across chained conversions. No semantic
//! assertions here — lossy constructs would flood artifacts; correctness
//! properties live in tests/engine.rs.

#![no_main]

use libfuzzer_sys::fuzz_target;
use remnote_typst_math_engine::raw;

fuzz_target!(|data: &[u8]| {
    let source = String::from_utf8_lossy(data);
    let block_math_mode = data.len() % 2 == 0;

    let first_latex = raw::typst_to_latex(&source, block_math_mode);
    let typst_once = raw::latex_to_typst(&first_latex);
    let second_latex = raw::typst_to_latex(&typst_once, block_math_mode);
    let _ = raw::latex_to_typst(&second_latex);
});
