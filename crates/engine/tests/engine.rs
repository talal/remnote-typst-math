//! Behavior suite for the engine core, mirroring what the plugin relies on.
//!
//! These run natively (`cargo test`) against the same functions the WASM
//! exports adapt. TypeScript keeps tests only for logic implemented in TS
//! (sanitization, KaTeX patches, normalization shims, verified-latex policy).

use remnote_typst_math_engine::{convert_latex_to_typst, convert_typst_to_latex};

#[test]
fn converts_typst_math_to_expected_latex_fragments() {
    let cases = [
        ("x^2", "x"),
        ("a / b", "frac"),
        ("sqrt(x)", "sqrt"),
        ("sum_(i=1)^n i", "sum"),
        ("integral_0^oo e^(-x^2) dif x", "int"),
        ("mat(1, 2; 3, 4)", "matrix"),
        ("vec(1, 2, 3)", "vec"),
        ("lim_(x -> 0) (sin(x)) / x", "lim"),
        (
            "nabla times bold(E) = - partial(bold(B)) / partial(t)",
            "nabla",
        ),
        ("forall x exists y (x < y)", "forall"),
    ];

    for (source, expected_fragment) in cases {
        let output = convert_typst_to_latex(source, false)
            .unwrap_or_else(|e| panic!("converting {source:?} failed: {e}"));
        assert!(
            output.contains(expected_fragment),
            "{source:?} -> {output:?} does not contain {expected_fragment:?}"
        );
    }
}

#[test]
fn converts_representative_latex_to_typst() {
    let output = convert_latex_to_typst("\\frac{1}{2} + \\alpha").expect("conversion failed");
    assert!(
        output.contains("frac") || output.contains('/'),
        "got: {output:?}"
    );
    assert!(
        output.contains("alpha") || output.contains('α'),
        "got: {output:?}"
    );
}

#[test]
fn passes_malformed_commands_through_instead_of_failing() {
    // Lenient engine policy: unknown/malformed commands pass through rather
    // than erroring, so user-visible failures stay rare and explicit.
    let output =
        convert_typst_to_latex("frac(", false).expect("lenient passthrough should not fail");
    assert!(output.contains("frac"), "got: {output:?}");
}

#[test]
fn multiline_alignment_is_canonical_aligned_in_both_modes() {
    let source = "sum_(k=0)^n k\n&= 1 + ... + n \\\n&= (n(n+1)) / 2";

    for block_math_mode in [false, true] {
        let output = convert_typst_to_latex(source, block_math_mode)
            .unwrap_or_else(|e| panic!("conversion failed (block: {block_math_mode}): {e}"));
        assert!(
            output.contains("\\begin{aligned}") && output.contains("\\end{aligned}"),
            "expected aligned environment (block: {block_math_mode}), got: {output:?}"
        );
        assert!(
            !output.contains("\\begin{align}") && !output.contains("\\begin{align*}"),
            "top-level align leaked (block: {block_math_mode}), got: {output:?}"
        );
    }

    // The canonical form must round-trip back to Typst alignment.
    let inline = convert_typst_to_latex(source, false).expect("inline conversion failed");
    let back_to_typst = convert_latex_to_typst(&inline).expect("reverse conversion failed");
    assert!(back_to_typst.contains("sum_"), "got: {back_to_typst:?}");
}

#[test]
fn ampersand_bare_math_becomes_alignment_marker_inside_aligned() {
    let latex = convert_typst_to_latex("a & b", false).expect("conversion failed");
    assert!(
        latex.contains("\\begin{aligned}") && latex.contains('&'),
        "expected aligned environment with alignment marker, got: {latex:?}"
    );
}

/// Deterministic corpus generator ported from converter.test.ts (same LCG,
/// atoms, operators, templates, and seed). Cases flagged `true` depend on the
/// TypeScript normalization shims (text brackets, explicit/control spaces,
/// relation-class canonicalization) and are not stable on the raw engine
/// until those passes port here.
fn generate_bidirectional_fuzz_corpus(seed: u32, count: usize) -> Vec<(String, bool)> {
    const ATOMS: [&str; 14] = [
        "x", "y", "z", "a", "b", "n", "alpha", "beta", "RR", "NN", "0", "1", "2", "pi",
    ];
    const OPERATORS: [&str; 13] = [
        "+", "-", "=", "<", ">", "<=", ">=", "!=", ":=", "->", "<=>", "in", "times",
    ];
    const TEXT_VALUES: [&str; 7] = [
        "is natural",
        "if",
        "otherwise",
        "a [b] c",
        "quote \" text",
        "units: kg",
        "left { right }",
    ];

    let mut corpus = vec![
        (
            "cal(A) := { x in RR | x space \"is natural\" }".to_string(),
            true,
        ),
        ("x space \"a [b] c\"".to_string(), true),
        ("x space \"a {b} c\"".to_string(), true),
        ("x space \"quote \\\" text\"".to_string(), true),
    ];

    let mut state = seed;
    let mut next = || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        state as usize
    };

    for index in 0..count {
        let left = ATOMS[next() % ATOMS.len()];
        let right = ATOMS[next() % ATOMS.len()];
        let operator = OPERATORS[next() % OPERATORS.len()];
        let text_literal = format!("{:?}", TEXT_VALUES[next() % TEXT_VALUES.len()]);
        // Relations and text/space constructs route through the TS shims
        // (e.g. `\mathrel{:=}` resurfaces as `: =` on the raw engine).
        let needs_shims = matches!(index % 6, 0 | 4 | 5);

        let case = match index % 6 {
            0 => format!("{left} {operator} {right}"),
            1 => format!("{left}^({right})"),
            2 => format!("{left} / {right}"),
            3 => format!("sqrt({left} + {right})"),
            4 => format!("{left} space {text_literal}"),
            _ => format!("{{ {left} {operator} {right} | {right} space {text_literal} }}"),
        };
        corpus.push((case, needs_shims));
    }

    corpus
}

#[test]
fn upright_wrappers_from_font_commands_collapse_to_canonical_form() {
    // Regression for stress-fuzz finding: bare \mathbf{y} gained an
    // \mathrm{} layer on every edit cycle because tylax wraps both \mathbf
    // and \mathrm in upright(...).
    let cases = [
        "\\mathbf{y}",
        "\\mathrm{\\mathbf{y}}",
        "\\mathrm{\\mathrm{\\boldsymbol{y}}}",
        "\\underline{x}",
    ];

    for source in cases {
        let typst = convert_latex_to_typst(source).unwrap_or_else(|e| panic!("{source:?}: {e}"));
        assert!(
            !typst.contains("upright(upright("),
            "nested upright survived {source:?}: {typst:?}"
        );
        assert!(
            !(typst.contains("upright(bold(") || typst.contains("upright(italic(")),
            "upright over font function survived {source:?}: {typst:?}"
        );

        let latex =
            convert_typst_to_latex(&typst, false).unwrap_or_else(|e| panic!("{typst:?}: {e}"));
        let typst_again =
            convert_latex_to_typst(&latex).unwrap_or_else(|e| panic!("{latex:?}: {e}"));
        assert_eq!(typst, typst_again, "not a fixed point from {source:?}");
    }
}

#[test]
fn multi_digit_numbers_survive_round_trips() {
    // Regression for stress-fuzz finding: tylax splits "42" into "4 2".
    // Rejoining must restore tokenizer artifacts without touching faithful
    // authorial spacing.
    let cases: [(&str, &str); 4] = [
        ("42", "42"),
        ("x_{10} 5", "x_(10) 5"),
        ("5 6", "5 6"),
        ("x_1 2", "x_(1) 2"),
    ];

    for (source, expected_typst) in cases {
        let typst = convert_latex_to_typst(source).unwrap_or_else(|e| panic!("{source:?}: {e}"));
        assert_eq!(typst, expected_typst, "l2t mismatch for {source:?}");

        // Whatever we produce must itself be a stable fixed point.
        let latex =
            convert_typst_to_latex(&typst, false).unwrap_or_else(|e| panic!("{typst:?}: {e}"));
        let typst_again =
            convert_latex_to_typst(&latex).unwrap_or_else(|e| panic!("{latex:?}: {e}"));
        assert_eq!(typst, typst_again, "not a fixed point from {source:?}");
    }

    // Cycle regression from stress fuzzing: digits inside matrix cells used
    // to split across edit cycles.
    let latex = convert_typst_to_latex("mat(alpha, y; 42, y)", false).expect("t2l failed");
    let typst = convert_latex_to_typst(&latex).expect("l2t failed");
    assert_eq!(
        typst, "mat(delim: #none, alpha, y ; 42, y)",
        "matrix cell digits degraded"
    );
    let latex_again = convert_typst_to_latex(&typst, false).expect("t2l #2 failed");
    assert_eq!(latex, latex_again, "matrix form not stable");
}

#[test]
fn blackboard_bold_braced_arguments_convert_and_terminate() {
    // Regression for a fuzz-found hang in tylax 0.3.7's fix_blackboard_bold
    // pass: rewriting `bb(X)` for any argument outside {E,P,R,N,Z,Q,C}
    // produced a byte-identical slice, so the rescan-from-start loop re-found
    // the same occurrence forever. Every latexToTypst call on braced
    // \mathbb input hung, freezing saves (verified-latex check) and edits.
    // Fixed in the vendored copy (crates/engine/third_party/tylax).
    let set_letter = convert_latex_to_typst(r"\mathbb{R}").expect("set letter conversion failed");
    assert_eq!(set_letter.trim(), "RR", "got: {set_letter:?}");

    for source in [r"\mathbb{I}", r"\mathbb{x}", r"\mathbb{hbar}"] {
        let typst = convert_latex_to_typst(source)
            .unwrap_or_else(|e| panic!("conversion failed for {source:?}: {e}"));
        let argument = source
            .trim_start_matches("\\mathbb")
            .trim_matches(['{', '}']);
        assert_eq!(typst.trim(), format!("bb({argument})"), "got: {typst:?}");
    }

    // The save path round-trips user-typed `bb(I)` through LaTeX during
    // verification; the cycle must terminate and stay stable.
    let latex = convert_typst_to_latex("bb(I)", false).expect("t2l failed");
    assert_eq!(latex.trim(), r"\mathbb{I}", "got: {latex:?}");
    let round_tripped = convert_latex_to_typst(&latex).expect("l2t failed");
    assert_eq!(round_tripped.trim(), "bb(I)", "got: {round_tripped:?}");
}

#[test]
fn parenthesized_matrices_canonicalize_to_pmatrix_immediately() {
    // Regression for stress fuzzing: \left(\begin{matrix}\right) re-parsed as
    // a delimited matrix and re-emitted as pmatrix on the next cycle.
    let first = convert_typst_to_latex("(mat(x, b; a, a))", false).expect("t2l failed");
    assert!(
        first.contains("\\begin{pmatrix}") && !first.contains("\\left("),
        "expected immediate pmatrix, got: {first:?}"
    );

    let typst = convert_latex_to_typst(&first).expect("l2t failed");
    let second = convert_typst_to_latex(&typst, false).expect("t2l #2 failed");
    assert_eq!(first, second, "pmatrix form not stable");
}

#[test]
fn multibyte_garbage_does_not_panic_symbol_spacing() {
    // Regression for a fuzz-found panic in tylax 0.3.7's fix_symbol_spacing:
    // its skip offset was plain byte arithmetic and landed inside a multi-byte
    // character when U+FFFD replacement chars reached the pass, panicking on
    // the str reslice. Fixed in the vendored copy
    // (crates/engine/third_party/tylax); minimization of the original crash.
    let bytes = b"\xff\xff\xff\xff\xff\xb6\xff\nfn\xc1n\xc1oo\xff\xff\xff-";
    let source = String::from_utf8_lossy(bytes).to_string();

    let first_latex = convert_typst_to_latex(&source, false)
        .unwrap_or_else(|e| panic!("t2l failed for {source:?}: {e}"));
    let typst = convert_latex_to_typst(&first_latex)
        .unwrap_or_else(|e| panic!("l2t failed for {first_latex:?}: {e}"));
    convert_typst_to_latex(&typst, false)
        .unwrap_or_else(|e| panic!("t2l #2 failed for {typst:?}: {e}"));
}

#[test]
fn scripted_fraction_repair_skips_multibyte_neighbors() {
    // Regression for a fuzz-found panic in repair_scripted_fraction_slash:
    // the left-token scan used raw byte arithmetic and could start a slice on
    // a UTF-8 continuation byte when non-ASCII text preceded the slash
    // (minimized fuzzer artifact: `\u{65e}/zws^(e)...`). Non-ASCII neighbors
    // are not LaTeX word tokens, so the slash must simply be skipped.
    let source = "\\frac{\u{65e}}{}^e}";
    let typst =
        convert_latex_to_typst(source).unwrap_or_else(|e| panic!("l2t failed for {source:?}: {e}"));
    assert!(
        !typst.contains("frac("),
        "unexpected frac rewrite: {typst:?}"
    );
}

#[test]
fn fuzz_corpus_round_trips_and_pure_math_converges() {
    for (source, needs_shims) in generate_bidirectional_fuzz_corpus(0x5eed_1234, 96) {
        let first_latex = convert_typst_to_latex(&source, false)
            .unwrap_or_else(|e| panic!("t2l failed for {source:?}: {e}"));
        let first_typst = convert_latex_to_typst(&first_latex)
            .unwrap_or_else(|e| panic!("l2t failed for {first_latex:?}: {e}"));
        let second_latex = convert_typst_to_latex(&first_typst, false)
            .unwrap_or_else(|e| panic!("t2l #2 failed for {first_typst:?}: {e}"));

        if !needs_shims {
            // Pure structural math must converge after one cycle on the raw engine.
            assert_eq!(first_latex, second_latex, "latex not stable for {source:?}");

            let second_typst = convert_latex_to_typst(&second_latex)
                .unwrap_or_else(|e| panic!("l2t #2 failed for {second_latex:?}: {e}"));
            assert_eq!(first_typst, second_typst, "typst not stable for {source:?}");
        }
        // Shim-dependent cases only guarantee a successful round-trip here;
        // tighten them to convergence once the shims port into this crate.
    }
}
