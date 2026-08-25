//! Crash-discovery harness for LaTeX -> Typst conversion.

#![no_main]

use libfuzzer_sys::fuzz_target;
use remnote_typst_math_engine::raw;

fuzz_target!(|data: &[u8]| {
    let source = String::from_utf8_lossy(data);
    let _ = raw::latex_to_typst(&source);
});
