//! Crash-discovery harness for Typst -> LaTeX conversion.
//!
//! Uses the panic-transparent `raw` API so any panic inside tylax aborts
//! libFuzzer and produces a minimized artifact instead of being swallowed.

#![no_main]

use libfuzzer_sys::fuzz_target;
use remnote_typst_math_engine::raw;

fuzz_target!(|data: &[u8]| {
    let source = String::from_utf8_lossy(data);
    let block_math_mode = data.len() % 2 == 0;
    let _ = raw::typst_to_latex(&source, block_math_mode);
});
