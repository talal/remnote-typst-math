//! WASM engine for the RemNote Typst Math plugin.
//!
//! Minimal surface over tylax: JavaScript passes math source (plus the
//! inline/block distinction, which is request semantics) and receives a
//! converted string or a thrown `Error`. All conversion options are fixed
//! engine policy defined here, never passed from JavaScript.
//!
//! The conversion core lives in plain Rust functions free of wasm-bindgen
//! types so the behavior suite (including bidirectional fuzzing) runs under
//! `cargo test` without building for WASM. Canonicalization passes live here
//! once ported from the TypeScript shims.

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn init() {
    console_error_panic_hook::set_once();
}

/// Runs a conversion, turning panics and empty outputs into errors.
fn run_conversion(convert: impl FnOnce() -> String) -> Result<String, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(convert)) {
        Ok(output) if !output.trim().is_empty() => Ok(output),
        Ok(_) => Err("conversion returned no output".to_string()),
        Err(payload) => Err(panic_message(payload)),
    }
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        format!("Conversion failed: {}", s)
    } else if let Some(s) = payload.downcast_ref::<String>() {
        format!("Conversion failed: {}", s)
    } else {
        "Conversion failed: unknown error (check browser console for details)".to_string()
    }
}

fn strip_inline_math_wrapper(output: String) -> String {
    let trimmed = output.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('$') && trimmed.ends_with('$') {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        output
    }
}

/// Convert Typst math to LaTeX.
///
/// Bare expressions containing `&` are wrapped in `$...$` so alignment
/// produces an align environment instead of leaking raw ampersands (mirrors
/// tylax's own wasm binding behavior).
/// KaTeX renders inside an existing math environment in both inline and block
/// contexts, so top-level `align`/`align*` are invalid there. `aligned` is
/// the canonical form for every alignment this engine emits.
fn canonicalize_alignment(output: String) -> String {
    output
        .replace(r"\begin{align*}", r"\begin{aligned}")
        .replace(r"\end{align*}", r"\end{aligned}")
        .replace(r"\begin{align}", r"\begin{aligned}")
        .replace(r"\end{align}", r"\end{aligned}")
}

fn find_matching_paren(source: &str, open_index: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut index = open_index;

    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 1,
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }

    None
}

/// Collapse redundant font-wrapper nestings produced by round-tripping:
/// tylax maps both `\mathrm` and `\mathbf` to `upright(...)`, so `\mathbf{y}`
/// would otherwise gain an `\mathrm{}` layer on every edit cycle. KaTeX
/// renders each of the following pairs identically, so we canonicalize to the
/// shortest form:
/// - `upright(upright|bold|italic(X))` -> `upright|bold|italic(X)`
/// - `bold(upright(X))` -> `bold(X)`, `italic(upright(X))` -> `italic(X)`
fn collapse_redundant_font_wrapper_once(source: &str) -> Option<String> {
    // (outer call, inner call, surviving call)
    const RULES: [(&str, &str, &str); 5] = [
        ("upright", "upright", "upright"),
        ("upright", "bold", "bold"),
        ("upright", "italic", "italic"),
        ("bold", "upright", "bold"),
        ("italic", "upright", "italic"),
    ];

    for (outer_name, inner_name, survivor) in RULES {
        let outer_call = format!("{outer_name}(");
        let mut cursor = 0;
        while let Some(offset) = source[cursor..].find(&outer_call) {
            let call_start = cursor + offset;
            let preceding_ok = call_start == 0 || {
                let prev = source[..call_start].chars().next_back().unwrap();
                !(prev.is_alphanumeric() || prev == '_')
            };
            let outer_open = call_start + outer_call.len() - 1;

            if preceding_ok && let Some(outer_close) = find_matching_paren(source, outer_open) {
                let inner_body = &source[outer_open + 1..outer_close];
                if let Some(inner_rest) = inner_body.strip_prefix(&format!("{inner_name}("))
                    && inner_rest.ends_with(')')
                {
                    let inner_open = outer_open + 1 + inner_name.len();
                    if let Some(inner_close) = find_matching_paren(source, inner_open)
                        && inner_close == outer_close - 1
                    {
                        let mut collapsed = String::with_capacity(source.len());
                        collapsed.push_str(&source[..call_start]);
                        collapsed.push_str(survivor);
                        collapsed.push('(');
                        collapsed.push_str(&source[inner_open + 1..inner_close]);
                        collapsed.push(')');
                        collapsed.push_str(&source[outer_close + 1..]);
                        return Some(collapsed);
                    }
                }
            }

            cursor = call_start + outer_call.len();
        }
    }

    None
}

fn normalize_font_wrappers(mut output: String) -> String {
    while let Some(collapsed) = collapse_redundant_font_wrapper_once(&output) {
        output = collapsed;
    }
    output
}

/// tylax 0.3.x splits every multi-digit number into space-separated digits
/// ("42" -> "4 2"). Rejoin a digit-space-digit junction only when the
/// concatenated run exists in the original LaTeX, so faithful authorial
/// spacing ("5 6", "x_1 2") is preserved while tokenizer artifacts repair.
fn rejoin_split_numbers(original_latex: &str, output: String) -> String {
    let mut input_runs: std::collections::HashSet<String> = Default::default();
    let mut run = String::new();
    for character in original_latex.chars() {
        if character.is_ascii_digit() {
            run.push(character);
        } else if !run.is_empty() {
            input_runs.insert(std::mem::take(&mut run));
        }
    }
    if !run.is_empty() {
        input_runs.insert(run);
    }

    fn join_pass(output: &str, input_runs: &std::collections::HashSet<String>) -> Option<String> {
        let bytes = output.as_bytes();
        for index in 1..bytes.len().saturating_sub(1) {
            if bytes[index] != b' '
                || !bytes[index - 1].is_ascii_digit()
                || !bytes[index + 1].is_ascii_digit()
            {
                continue;
            }
            let mut left_end = index - 1;
            while left_end > 0 && bytes[left_end - 1].is_ascii_digit() {
                left_end -= 1;
            }
            let mut right_end = index + 1;
            while right_end + 1 < bytes.len() && bytes[right_end + 1].is_ascii_digit() {
                right_end += 1;
            }
            let joined: String = format!(
                "{}{}",
                &output[left_end..index],
                &output[index + 1..=right_end]
            );
            if input_runs.contains(&joined) {
                let mut next = String::with_capacity(output.len());
                next.push_str(&output[..index]);
                next.push_str(&output[index + 1..]);
                return Some(next);
            }
        }
        None
    }

    let mut current = output;
    while let Some(next) = join_pass(&current, &input_runs) {
        current = next;
    }
    current
}

fn find_matching_brace(source: &str, open_index: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut index = open_index;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 1,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// Collapse LaTeX-side font wrapper redundancy (\mathrm over \mathbf etc.),
/// mirroring the Typst-side font wrapper rules: KaTeX renders
/// `\mathrm{\mathbf{X}}` and `\mathbf{X}` identically, so keep the shortest.
fn canonicalize_latex_font_wrappers(output: String) -> String {
    // (outer command, inner command, surviving command)
    const RULES: [(&str, &str, &str); 5] = [
        ("\\mathrm", "\\mathbf", "\\mathbf"),
        ("\\mathrm", "\\mathit", "\\mathit"),
        ("\\mathrm", "\\mathrm", "\\mathrm"),
        ("\\mathbf", "\\mathrm", "\\mathbf"),
        ("\\mathit", "\\mathrm", "\\mathit"),
    ];

    let mut current = output;
    'rules: loop {
        for (outer_command, inner_command, survivor) in RULES {
            let outer_call = format!("{outer_command}{{");
            let mut cursor = 0;
            while let Some(offset) = current[cursor..].find(&outer_call) {
                let call_start = cursor + offset;
                let outer_open = call_start + outer_command.len();
                let Some(outer_close) = find_matching_brace(&current, outer_open) else {
                    break;
                };
                let inner_body = &current[outer_open + 1..outer_close];
                let inner_call = format!("{inner_command}{{");
                let Some(_) = inner_body.strip_prefix(&inner_call) else {
                    cursor = outer_open + 1;
                    continue;
                };
                let inner_open = outer_open + 1 + inner_command.len();
                if !inner_body.ends_with('}') {
                    cursor = outer_open + 1;
                    continue;
                }
                let Some(inner_close) = find_matching_brace(&current, inner_open) else {
                    cursor = outer_open + 1;
                    continue;
                };
                if inner_close != outer_close - 1 {
                    cursor = outer_open + 1;
                    continue;
                }

                let mut collapsed = String::with_capacity(current.len());
                collapsed.push_str(&current[..call_start]);
                collapsed.push_str(survivor);
                collapsed.push('{');
                collapsed.push_str(&current[inner_open + 1..inner_close]);
                collapsed.push('}');
                collapsed.push_str(&current[outer_close + 1..]);
                current = collapsed;
                continue 'rules;
            }
        }
        return current;
    }
}

/// tylax emits simple `\frac{x}{y}^s` as `x/y^(s)`, but Typst binds `^` to
/// `y`, so the exponent silently moves into the denominator. When the
/// original LaTeX contained a scripted `\frac`, rewrite every
/// `word/word^script` / `word/word_script` slash pattern in the output to an
/// explicit `frac(x, y)` call, which binds the script to the whole fraction.
fn repair_scripted_fraction_slash(original_latex: &str, output: String) -> String {
    // Does the source contain any `\frac{..}{..}` immediately followed by a script?
    let mut has_scripted_frac = false;
    let mut search = 0;
    while let Some(offset) = original_latex[search..].find("\\frac{") {
        let first_open = search + offset + "\\frac".len();
        let Some(first_close) = find_matching_brace(original_latex, first_open) else {
            break;
        };
        if original_latex[first_close + 1..].starts_with('{') {
            let second_open = first_close + 1;
            if let Some(second_close) = find_matching_brace(original_latex, second_open)
                && original_latex[second_close + 1..]
                    .trim_start()
                    .starts_with(['^', '_'])
            {
                has_scripted_frac = true;
                break;
            }
        }
        // Advance only past this token so nested fracs are still visited.
        search = first_open;
    }
    if !has_scripted_frac {
        return output;
    }

    // Rewrite right-to-left so earlier indices stay valid. A candidate is
    // TOKEN '/' TOKEN immediately followed by '^' or '_', where a token is a
    // word run or a LaTeX command like `\theta`.
    let token_end = |bytes: &[u8], mut index: usize| -> usize {
        if bytes[index] == b'\\' {
            index += 1;
            while index < bytes.len() && bytes[index].is_ascii_alphabetic() {
                index += 1;
            }
            index
        } else {
            while index < bytes.len() && bytes[index].is_ascii_alphanumeric() {
                index += 1;
            }
            index
        }
    };
    let token_start = |bytes: &[u8], mut index: usize| -> usize {
        // Given an index inside/at the end of a token, walk back to its start.
        if bytes[index].is_ascii_alphabetic() && index > 0 && bytes[index - 1] == b'\\' {
            let mut start = index - 1;
            while start > 0 && bytes[start - 1].is_ascii_alphabetic() {
                start -= 1;
                if bytes[start] == b'\\' {
                    start -= 1;
                    break;
                }
            }
            return start;
        }
        while index > 0 && bytes[index - 1].is_ascii_alphanumeric() {
            index -= 1;
        }
        index
    };

    let bytes = output.as_bytes();
    let mut edits: Vec<(usize, usize, String)> = Vec::new();

    for slash in (0..bytes.len()).rev() {
        if bytes[slash] != b'/' {
            continue;
        }
        // Tylax sometimes pads the slash with spaces (`n/ theta`).
        let left_index = match slash.checked_sub(1) {
            Some(index) if bytes[index] != b' ' => index,
            Some(mut index) => {
                while index > 0 && bytes[index] == b' ' {
                    index -= 1;
                }
                index
            }
            None => continue,
        };
        let mut right_index = slash + 1;
        while right_index < bytes.len() && bytes[right_index] == b' ' {
            right_index += 1;
        }
        if right_index >= bytes.len() || left_index == 0 && bytes[left_index] == b' ' {
            continue;
        }
        // The space-walk above is plain byte arithmetic and can land inside a
        // multi-byte character when non-ASCII text precedes the slash (e.g.
        // U+FFFD replacement chars from lossy input). This pass only rewrites
        // ASCII word/command tokens, so skip instead of slicing mid-character.
        if !output.is_char_boundary(left_index) {
            continue;
        }

        let script_at = token_end(bytes, right_index);
        if script_at == right_index || script_at >= bytes.len() {
            continue;
        }
        if bytes[script_at] != b'^' && bytes[script_at] != b'_' {
            continue;
        }
        let num_start = token_start(bytes, left_index);

        let numerator = &output[num_start..=left_index];
        let denominator = &output[right_index..script_at];
        edits.push((
            num_start,
            script_at,
            format!("frac({numerator}, {denominator})"),
        ));
    }

    let mut result = output;
    for (start, end, replacement) in edits {
        result.replace_range(start..end, &replacement);
    }
    result
}

fn find_matching_bracket(source: &str, open_index: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut index = open_index;

    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 1,
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }

    None
}

/// tylax emits Typst content-mode calls like `#underline[x]` for LaTeX
/// `\underline{x}`; inside math those must be plain function calls.
/// Mirrors the TypeScript shim it replaces.
fn convert_bracket_functions(output: String) -> String {
    const CALL: &str = "#underline[";

    let mut normalized = String::with_capacity(output.len());
    let mut cursor = 0;

    while let Some(offset) = output[cursor..].find(CALL) {
        let start = cursor + offset;
        let open_index = start + CALL.len() - 1;
        let Some(close_index) = find_matching_bracket(&output, open_index) else {
            break;
        };

        normalized.push_str(&output[cursor..start]);
        normalized.push_str("underline(");
        normalized.push_str(&output[open_index + 1..close_index]);
        normalized.push(')');
        cursor = close_index + 1;
    }

    normalized.push_str(&output[cursor..]);
    normalized
}

/// Panic-transparent conversion internals. These run the same fixed policy as
/// the public `convert_*` functions but without the top-level panic guard, so
/// failures surface loudly (crashes under cargo-fuzz, panics in tests) instead
/// of being swallowed into structured errors.
pub mod raw {
    pub fn typst_to_latex(source: &str, block_math_mode: bool) -> String {
        let options = tylax::T2LOptions {
            math_only: true,
            block_math_mode,
            ..Default::default()
        };

        let output = if source.contains('&') {
            let wrapped = format!("${}$", source);
            let mut markup_options = options.clone();
            markup_options.math_only = false;
            super::strip_inline_math_wrapper(tylax::typst_to_latex_with_options(
                &wrapped,
                &markup_options,
            ))
        } else {
            tylax::typst_to_latex_with_options(source, &options)
        };
        super::canonicalize_matrix_delimiters(super::canonicalize_latex_font_wrappers(
            super::canonicalize_alignment(output),
        ))
    }

    pub fn latex_to_typst(source: &str) -> String {
        // Fixed engine policy (previously passed per-call from TypeScript):
        // math-only mode with shorthands (`->`) enabled, simple fractions as
        // slashes, `\infty` spelled `infinity`, lenient unknown commands,
        // output optimizations on, and no Typst-style preamble.
        let options = tylax::L2TOptions {
            prefer_shorthands: true,
            frac_to_slash: true,
            infty_to_oo: false,
            non_strict: true,
            optimize: true,
            preamble: tylax::PreambleMode::None,
            ..Default::default()
        };

        super::normalize_font_wrappers(super::repair_scripted_fraction_slash(
            source,
            super::rejoin_split_numbers(
                source,
                super::convert_bracket_functions(tylax::latex_to_typst_with_options(
                    source, &options,
                )),
            ),
        ))
    }
}

/// A bare `\left( \begin{matrix} ... \right)` re-parses as delimited matrix
/// syntax and re-emits as `\begin{pmatrix}` — unstable across edit cycles,
/// identical in rendering. Canonicalize on emission so the first save is
/// already the fixed-point form.
fn canonicalize_matrix_delimiters(output: String) -> String {
    const OPEN: &str = "\\left(";
    const ENV_OPEN: &str = "\\begin{matrix}";
    const ENV_CLOSE: &str = "\\end{matrix}";
    const CLOSE: &str = "\\right)";

    let skip_whitespace = |bytes: &[u8], mut index: usize| {
        while matches!(bytes.get(index), Some(b' ') | Some(b'\n') | Some(b'\t')) {
            index += 1;
        }
        index
    };

    let bytes = output.as_bytes();
    let mut result = String::with_capacity(output.len());
    let mut cursor = 0;

    while let Some(offset) = output[cursor..].find(OPEN) {
        let open_at = cursor + offset;
        let env_open_at = skip_whitespace(bytes, open_at + OPEN.len());
        if !output[env_open_at..].starts_with(ENV_OPEN) {
            result.push_str(&output[cursor..open_at + OPEN.len()]);
            cursor = open_at + OPEN.len();
            continue;
        }

        // Find this environment's matching close, honoring nesting.
        let mut depth = 1usize;
        let mut scan = env_open_at + ENV_OPEN.len();
        let env_close_at = loop {
            let next_open = output[scan..].find(ENV_OPEN).map(|offset| scan + offset);
            let next_close = output[scan..].find(ENV_CLOSE).map(|offset| scan + offset);
            let Some(env_close_candidate) = next_close else {
                // Unbalanced environment; emit literally and move past this opener.
                result.push_str(&output[cursor..open_at + OPEN.len()]);
                cursor = open_at + OPEN.len();
                break usize::MAX;
            };
            if next_open.is_some_and(|open| open < env_close_candidate) {
                depth += 1;
                scan = next_open.unwrap() + ENV_OPEN.len();
            } else {
                depth -= 1;
                if depth == 0 {
                    break env_close_candidate;
                }
                scan = env_close_candidate + ENV_CLOSE.len();
            }
        };
        if env_close_at == usize::MAX {
            continue;
        }

        let tail = skip_whitespace(bytes, env_close_at + ENV_CLOSE.len());
        if !output[tail..].starts_with(CLOSE) {
            result.push_str(&output[cursor..env_open_at]);
            cursor = env_open_at;
            continue;
        }

        result.push_str(&output[cursor..open_at]);
        result.push_str("\\begin{pmatrix}");
        result.push_str(&output[env_open_at + ENV_OPEN.len()..env_close_at]);
        result.push_str("\\end{pmatrix}");
        cursor = tail + CLOSE.len();
    }

    result.push_str(&output[cursor..]);
    result
}

pub fn convert_typst_to_latex(source: &str, block_math_mode: bool) -> Result<String, String> {
    run_conversion(|| raw::typst_to_latex(source, block_math_mode))
}

/// Convert LaTeX math to Typst.
pub fn convert_latex_to_typst(source: &str) -> Result<String, String> {
    run_conversion(|| raw::latex_to_typst(source))
}

#[wasm_bindgen(js_name = typstToLatex)]
pub fn typst_to_latex(input: String, block_math_mode: bool) -> Result<String, JsError> {
    convert_typst_to_latex(&input, block_math_mode).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen(js_name = latexToTypst)]
pub fn latex_to_typst(input: String) -> Result<String, JsError> {
    convert_latex_to_typst(&input).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen(js_name = detectFormat)]
pub fn detect_format(input: String) -> String {
    tylax::detect_format(&input).to_string()
}
