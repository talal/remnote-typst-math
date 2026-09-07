import { describe, expect, it } from 'vitest';
import { ConversionError, typstToVerifiedLatex } from './converter';
import { detectFormat, latexToTypst, typstToLatex } from './engine/index';
import { TYPST_SHORTHANDS, TYPST_TO_LATEX_SYMBOLS } from './engine/symbols';

describe('Pure TypeScript Typst Math Engine', () => {
  describe('1. Fractions & Unparen Semantics', () => {
    it('converts simple fractions', () => {
      expect(typstToLatex('a / b')).toBe('\\frac{a}{b}');
      expect(typstToLatex('1 / 2')).toBe('\\frac{1}{2}');
    });

    it('unwraps parentheses on fraction operands per Typst math_unparen', () => {
      expect(typstToLatex('(a + b) / (c + d)')).toBe('\\frac{a + b}{c + d}');
      expect(typstToLatex('(x + 1) / y')).toBe('\\frac{x + 1}{y}');
    });

    it('preserves double parentheses if intentional', () => {
      expect(typstToLatex('((a + b)) / c')).toBe('\\frac{\\left(a + b\\right)}{c}');
    });

    it('handles explicit frac(...) calls', () => {
      expect(typstToLatex('frac(a, b)')).toBe('\\frac{a}{b}');
    });
  });

  describe('2. Roots', () => {
    it('converts square roots', () => {
      expect(typstToLatex('sqrt(x)')).toBe('\\sqrt{x}');
      expect(typstToLatex('sqrt(x + 1)')).toBe('\\sqrt{x + 1}');
    });

    it('converts nth roots', () => {
      expect(typstToLatex('root(3, x)')).toBe('\\sqrt[3]{x}');
      expect(typstToLatex('root(n, x + y)')).toBe('\\sqrt[n]{x + y}');
    });
  });

  describe('3. Attachments & Scripts', () => {
    it('handles subscripts and superscripts', () => {
      expect(typstToLatex('x_1')).toBe('x_1');
      expect(typstToLatex('x^2')).toBe('x^2');
      expect(typstToLatex('x_1^2')).toBe('x_1^2');
      expect(typstToLatex('x^2_1')).toBe('x_1^2');
    });

    it('unwraps parens in subscripts and superscripts', () => {
      expect(typstToLatex('x_(i + 1)')).toBe('x_{i + 1}');
      expect(typstToLatex('x^(n - 1)')).toBe('x^{n - 1}');
    });

    it('handles primes', () => {
      expect(typstToLatex("f'")).toBe("f'");
      expect(typstToLatex("f''")).toBe("f''");
      expect(typstToLatex("f'_1")).toBe("f'_1");
    });

    it('handles big operators with attachments', () => {
      expect(typstToLatex('sum_(i=1)^n i')).toBe('\\sum_{i = 1}^n i');
      expect(typstToLatex('integral_0^oo e^(-x^2) dif x')).toBe(
        '\\int_0^{\\infty} e^{-x^2} \\mathrm{d} x',
      );
      expect(typstToLatex('lim_(x -> 0) (sin(x)) / x')).toBe(
        '\\lim_{x \\to 0} \\frac{\\sin\\left(x\\right)}{x}',
      );
    });
  });

  describe('4. Matrices & Vectors', () => {
    it('converts 2D matrices with default delimiters (pmatrix)', () => {
      const latex = typstToLatex('mat(1, 2; 3, 4)');
      expect(latex).toContain('\\begin{pmatrix}');
      expect(latex).toContain('1 & 2');
      expect(latex).toContain('3 & 4');
      expect(latex).toContain('\\end{pmatrix}');
    });

    it('supports custom matrix delimiters', () => {
      const bmat = typstToLatex('mat(delim: "[", 1, 2; 3, 4)');
      expect(bmat).toContain('\\begin{bmatrix}');
      expect(bmat).toContain('\\end{bmatrix}');

      const vmat = typstToLatex('mat(delim: "|", 1, 2; 3, 4)');
      expect(vmat).toContain('\\begin{vmatrix}');
      expect(vmat).toContain('\\end{vmatrix}');
    });

    it('converts column vectors', () => {
      const vec = typstToLatex('vec(1, 2, 3)');
      expect(vec).toContain('\\begin{pmatrix}');
      expect(vec).toContain('1 \\\\\n2 \\\\\n3');
      expect(vec).toContain('\\end{pmatrix}');
    });
  });

  describe('5. Cases', () => {
    it('converts piecewise cases', () => {
      const casesLatex = typstToLatex('cases(1 "if" x > 0, 0 "otherwise")');
      expect(casesLatex).toContain('\\begin{cases}');
      expect(casesLatex).toContain('\\text{if}');
      expect(casesLatex).toContain('\\text{otherwise}');
      expect(casesLatex).toContain('\\end{cases}');
    });
  });

  describe('6. Fonts & Blackboard Bold', () => {
    it('converts font styling functions', () => {
      expect(typstToLatex('bold(A)')).toBe('\\mathbf{A}');
      expect(typstToLatex('italic(A)')).toBe('\\mathit{A}');
      expect(typstToLatex('upright(A)')).toBe('\\mathrm{A}');
      expect(typstToLatex('cal(P)')).toBe('\\mathcal{P}');
      expect(typstToLatex('frak(g)')).toBe('\\mathfrak{g}');
      expect(typstToLatex('sans(M)')).toBe('\\mathsf{M}');
      expect(typstToLatex('bb(X)')).toBe('\\mathbb{X}');
    });

    it('converts blackboard bold standard sets', () => {
      expect(typstToLatex('RR')).toBe('\\mathbb{R}');
      expect(typstToLatex('NN')).toBe('\\mathbb{N}');
      expect(typstToLatex('ZZ')).toBe('\\mathbb{Z}');
      expect(typstToLatex('QQ')).toBe('\\mathbb{Q}');
      expect(typstToLatex('CC')).toBe('\\mathbb{C}');
    });
  });

  describe('7. Accents, Underline, and Overline', () => {
    it('converts accents', () => {
      expect(typstToLatex('hat(x)')).toBe('\\hat{x}');
      expect(typstToLatex('tilde(x)')).toBe('\\tilde{x}');
      expect(typstToLatex('macron(x)')).toBe('\\bar{x}');
      expect(typstToLatex('dot(x)')).toBe('\\dot{x}');
      expect(typstToLatex('ddot(x)')).toBe('\\ddot{x}');
      expect(typstToLatex('arrow(x)')).toBe('\\vec{x}');
    });

    it('converts underline and overline', () => {
      expect(typstToLatex('underline(x + y)')).toBe('\\underline{x + y}');
      expect(typstToLatex('overline(x + y)')).toBe('\\overline{x + y}');
    });

    it('converts underbrace and overbrace', () => {
      expect(typstToLatex('underbrace(x + y, n)')).toBe('\\underbrace{x + y}_{n}');
      expect(typstToLatex('overbrace(x + y, n)')).toBe('\\overbrace{x + y}^{n}');
    });

    it('converts cancellations', () => {
      expect(typstToLatex('cancel(x)')).toBe('\\cancel{x}');
      expect(typstToLatex('cancel(x, inverted: true)')).toBe('\\bcancel{x}');
      expect(typstToLatex('cancel(x, cross: true)')).toBe('\\xcancel{x}');
    });
  });

  describe('8. Delimiters', () => {
    it('scales parentheses, brackets, and braces', () => {
      expect(typstToLatex('(x + y)')).toBe('\\left(x + y\\right)');
      expect(typstToLatex('[x + y]')).toBe('\\left[x + y\\right]');
      expect(typstToLatex('{x + y}')).toBe('\\left\\{x + y\\right\\}');
    });

    it('handles abs, norm, floor, and ceil', () => {
      expect(typstToLatex('abs(x)')).toBe('\\left|x\\right|');
      expect(typstToLatex('norm(x)')).toBe('\\left\\|x\\right\\|');
      expect(typstToLatex('floor(x)')).toBe('\\left\\lfloor x \\right\\rfloor');
      expect(typstToLatex('ceil(x)')).toBe('\\left\\lceil x \\right\\rceil');
    });
  });

  describe('9. Shorthands, Relations, and Logic', () => {
    it('converts multi-character shorthands', () => {
      expect(typstToLatex('x != y')).toBe('x \\neq y');
      expect(typstToLatex('x <= y')).toBe('x \\le y');
      expect(typstToLatex('x >= y')).toBe('x \\ge y');
      expect(typstToLatex('x := y')).toBe('x \\coloneqq y');
      expect(typstToLatex('x -> y')).toBe('x \\to y');
      expect(typstToLatex('x => y')).toBe('x \\Rightarrow y');
      expect(typstToLatex('x <=> y')).toBe('x \\Leftrightarrow y');
      expect(typstToLatex('x pm y')).toBe('x \\pm y');
    });

    it('converts logic symbols and relations', () => {
      expect(typstToLatex('forall x exists y (x < y)')).toBe(
        '\\forall x \\exists y \\left(x < y\\right)',
      );
      expect(typstToLatex('x in RR')).toBe('x \\in \\mathbb{R}');
      expect(typstToLatex('x in.not RR')).toBe('x \\notin \\mathbb{R}');
      expect(typstToLatex('a divides b')).toBe('a \\mid b');
    });
  });

  describe('10. Spacing Primitives', () => {
    it('converts Typst spaces to KaTeX spacing commands', () => {
      expect(typstToLatex('x space y')).toBe('x \\  y');
      expect(typstToLatex('x space.nobreak y')).toBe('x ~ y');
      expect(typstToLatex('x space.quad y')).toBe('x \\quad y');
      expect(typstToLatex('x space.wide y')).toBe('x \\qquad y');
      expect(typstToLatex('x space.thin y')).toBe('x \\, y');
    });
  });

  describe('11. Multiline and Alignment', () => {
    it('wraps aligned equations in \\begin{aligned}...\\end{aligned}', () => {
      const source = 'sum_(k=0)^n k\n&= 1 + ... + n \\\n&= (n(n+1)) / 2';
      const latex = typstToLatex(source);
      expect(latex).toContain('\\begin{aligned}');
      expect(latex).toContain('\\end{aligned}');
      expect(latex).toContain('&');
      expect(latex).toContain('\\\\');
    });

    it('wraps single ampersand in aligned environment', () => {
      const latex = typstToLatex('a & b');
      expect(latex).toContain('\\begin{aligned}');
      expect(latex).toContain('a & b');
      expect(latex).toContain('\\end{aligned}');
    });
  });

  describe('12. Decompiler (LaTeX -> Typst) & Round-Trip', () => {
    it('decompiles fractions and Greek', () => {
      const typst = latexToTypst('\\frac{1}{2} + \\alpha');
      expect(typst).toContain('1 / 2');
      expect(typst).toContain('alpha');
    });

    it('decompiles matrices and vectors', () => {
      expect(latexToTypst('\\begin{pmatrix} 1 \\\\ 2 \\\\ 3 \\end{pmatrix}')).toBe('vec(1, 2, 3)');
      expect(latexToTypst('\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}')).toBe(
        'mat(1, 2; 3, 4)',
      );
    });

    it('decompiles font wrappers and blackboard bold', () => {
      expect(latexToTypst('\\mathbf{A}')).toBe('bold(A)');
      expect(latexToTypst('\\mathbb{R}')).toBe('RR');
      expect(latexToTypst('\\mathbb{N}')).toBe('NN');
    });

    it('decompiles aligned environments to Typst alignment', () => {
      const source = '\\begin{aligned} x &= 1 \\\\ &= 2 \\end{aligned}';
      const typst = latexToTypst(source);
      expect(typst).toContain('&');
      expect(typst).toContain('\\');
    });

    it('decompiles text and spaces', () => {
      expect(latexToTypst('x \\text{is natural}')).toBe('x "is natural"');
      expect(latexToTypst('x \\  y')).toBe('x space y');
      expect(latexToTypst('x ~ y')).toBe('x space.nobreak y');
    });
  });

  describe('13. Format Detection', () => {
    it('classifies LaTeX, Typst, and ambiguous sources correctly', () => {
      expect(detectFormat('\\frac{a}{b}')).toBe('latex');
      expect(detectFormat('\\alpha + \\beta')).toBe('latex');
      expect(detectFormat('#set text(size: 10pt)')).toBe('typst');
      expect(detectFormat('x + y')).toBe('unknown');
      expect(detectFormat('sum_(i=1)^n i')).toBe('unknown');
      expect(detectFormat('')).toBe('unknown');
      expect(detectFormat('   \n\t  ')).toBe('unknown');
    });
  });

  describe('14. Greek, Hebrew, and Mathematical Constants', () => {
    it('converts uppercase and lowercase Greek letters', () => {
      expect(typstToLatex('alpha + beta + gamma + delta')).toBe(
        '\\alpha + \\beta + \\gamma + \\delta',
      );
      expect(typstToLatex('Gamma + Delta + Theta + Lambda')).toBe(
        '\\Gamma + \\Delta + \\Theta + \\Lambda',
      );
      expect(typstToLatex('Phi + Psi + Omega')).toBe('\\Phi + \\Psi + \\Omega');
    });

    it('converts Hebrew symbols', () => {
      expect(typstToLatex('aleph + beth + gimel + daleth')).toBe(
        '\\aleph + \\beth + \\gimel + \\daleth',
      );
    });

    it('converts math constants', () => {
      expect(typstToLatex('nabla times bold(B)')).toBe('\\nabla \\times \\mathbf{B}');
      expect(typstToLatex('partial / (partial x)')).toBe('\\frac{\\partial}{\\partial x}');
      expect(typstToLatex('infty + ell + hbar')).toBe('\\infty + \\ell + \\hbar');
    });
  });

  describe('15. Advanced Matrices, Vectors, and Binomials', () => {
    it('converts binomial coefficients', () => {
      expect(typstToLatex('binom(n, k)')).toBe('\\binom{n}{k}');
    });

    it('converts matrices with braces delimiter', () => {
      const latex = typstToLatex('mat(delim: "{", a, b; c, d)');
      expect(latex).toContain('\\begin{Bmatrix}');
      expect(latex).toContain('a & b');
      expect(latex).toContain('c & d');
      expect(latex).toContain('\\end{Bmatrix}');
    });

    it('converts vectors with brackets delimiter', () => {
      const latex = typstToLatex('vec(delim: "[", 1, 2)');
      expect(latex).toContain('\\begin{bmatrix}');
      expect(latex).toContain('1 \\\\\n2');
      expect(latex).toContain('\\end{bmatrix}');
    });

    it('converts nested fractions correctly', () => {
      expect(typstToLatex('(a / b) / (c / d)')).toBe('\\frac{\\frac{a}{b}}{\\frac{c}{d}}');
    });
  });

  describe('16. Advanced Arrows and Relations', () => {
    it('converts long, double, and squiggly arrows', () => {
      expect(typstToLatex('A <==> B')).toBe('A \\Longleftrightarrow B');
      expect(typstToLatex('A ==> B')).toBe('A \\Longrightarrow B');
      expect(typstToLatex('A <== B')).toBe('A \\Longleftarrow B');
      expect(typstToLatex('A |-> B')).toBe('A \\mapsto B');
      expect(typstToLatex('A ~> B')).toBe('A \\rightsquigarrow B');
    });

    it('converts relations, orders, and approximations', () => {
      expect(typstToLatex('x << y')).toBe('x \\ll y');
      expect(typstToLatex('x >> y')).toBe('x \\gg y');
      expect(typstToLatex('x approx y')).toBe('x \\approx y');
      expect(typstToLatex('x sim y')).toBe('x \\sim y');
      expect(typstToLatex('x equiv y')).toBe('x \\equiv y');
      expect(typstToLatex('A subset B')).toBe('A \\subset B');
      expect(typstToLatex('A subset.eq B')).toBe('A \\subseteq B');
    });
  });

  describe('17. Strings and Escapes', () => {
    it('handles string literals with spaces and punctuation', () => {
      expect(typstToLatex('x space "is a real number"')).toBe('x \\  \\text{is a real number}');
    });

    it('handles triple primes', () => {
      expect(typstToLatex("f'''(x)")).toBe("f'''\\left(x\\right)");
    });
  });

  describe('18. Bidirectional Round-Trip Invariance', () => {
    const testCases = [
      'x^2 + y^2 = z^2',
      'a / b + c / d',
      'sqrt(x + 1)',
      'root(3, x)',
      'sum_(i = 1)^n i',
      'bold(A) + italic(B)',
      'alpha + beta = gamma',
      'x != y',
      'x <= y',
      'x >= y',
      'x := y',
      'x -> y',
      'vec(1, 2, 3)',
      'mat(1, 2; 3, 4)',
      'cases(1 "if" x > 0, 0 "otherwise")',
      'x space "is natural"',
      'x space.nobreak y',
      'underline(x + y)',
      'overline(x + y)',
      'hat(x) + tilde(y)',
      'RR + NN + ZZ + QQ + CC',
    ];

    for (const source of testCases) {
      it(`stabilizes ${source} across round trips`, () => {
        const latex = typstToLatex(source);
        const typstBack = latexToTypst(latex);
        const latex2 = typstToLatex(typstBack);
        expect(latex2).toBe(latex);
      });
    }
  });

  describe('19. Exhaustive Symbols Suite', () => {
    it('converts every registered Typst symbol to its expected LaTeX output', () => {
      for (const [sym, expected] of Object.entries(TYPST_TO_LATEX_SYMBOLS)) {
        // Pair-dependent delimiters cannot stand alone (unclosed delimiters
        // are refused): cover them in paired form instead.
        if (sym === '[|') {
          expect(typstToLatex('[|x|]')).toBe('\\llbracket x \\rrbracket');
          continue;
        }
        expect(typstToLatex(sym)).toBe(expected);
      }
    });

    it('converts symbols in expressions without collision', () => {
      // Greek lowercase
      expect(
        typstToLatex(
          'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi chi psi omega',
        ),
      ).toBe(
        '\\alpha \\beta \\gamma \\delta \\epsilon \\zeta \\eta \\theta \\iota \\kappa \\lambda \\mu \\nu \\xi \\pi \\rho \\sigma \\tau \\upsilon \\phi \\chi \\psi \\omega',
      );
      // Greek uppercase
      expect(typstToLatex('Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega')).toBe(
        '\\Gamma \\Delta \\Theta \\Lambda \\Xi \\Pi \\Sigma \\Upsilon \\Phi \\Psi \\Omega',
      );
      // Hebrew
      expect(typstToLatex('aleph beth gimel daleth')).toBe('\\aleph \\beth \\gimel \\daleth');
      // Blackboard bold sets
      expect(typstToLatex('NN ZZ QQ RR CC PP EE HH')).toBe(
        '\\mathbb{N} \\mathbb{Z} \\mathbb{Q} \\mathbb{R} \\mathbb{C} \\mathbb{P} \\mathbb{E} \\mathbb{H}',
      );
      // Math constants
      expect(
        typstToLatex('infinity infty oo nabla partial dif ell hbar wp Re Im nothing emptyset'),
      ).toBe(
        '\\infty \\infty \\infty \\nabla \\partial \\mathrm{d} \\ell \\hbar \\wp \\Re \\Im \\varnothing \\emptyset',
      );
    });
  });

  describe('20. Exhaustive Shorthands Suite', () => {
    for (const [shorthand, symbolName] of TYPST_SHORTHANDS) {
      it(`converts shorthand "${shorthand}" -> ${symbolName}`, () => {
        const expected = TYPST_TO_LATEX_SYMBOLS[symbolName] ?? TYPST_TO_LATEX_SYMBOLS[shorthand];
        // Pair-dependent delimiters cannot stand alone (unclosed delimiters
        // are refused): cover them in paired form instead.
        if (shorthand === '[|') {
          expect(typstToLatex('a [|x|] b')).toBe(`a \\llbracket x \\rrbracket b`);
          return;
        }
        expect(typstToLatex(`a ${shorthand} b`)).toBe(`a ${expected} b`);
      });
    }
  });

  describe('21. Exhaustive Standard Functions Suite', () => {
    const funcs = [
      'sin',
      'cos',
      'tan',
      'cot',
      'sec',
      'csc',
      'arcsin',
      'arccos',
      'arctan',
      'sinh',
      'cosh',
      'tanh',
      'coth',
      'ln',
      'log',
      'exp',
      'det',
      'dim',
      'gcd',
      'deg',
      'ker',
      'hom',
      'arg',
      'max',
      'min',
      'sup',
      'inf',
    ];

    for (const fn of funcs) {
      it(`converts function "${fn}" standalone and with call arguments`, () => {
        const expectedMacro = TYPST_TO_LATEX_SYMBOLS[fn];
        expect(typstToLatex(fn)).toBe(expectedMacro);
        expect(typstToLatex(`${fn}(x)`)).toBe(`${expectedMacro}\\left(x\\right)`);
      });
    }
  });

  describe('22. Exhaustive Cases Variants Suite', () => {
    it('converts single branch cases', () => {
      const latex = typstToLatex('cases(x)');
      expect(latex).toBe('\\begin{cases}\nx\n\\end{cases}');
    });

    it('converts multi-branch cases without conditions', () => {
      const latex = typstToLatex('cases(a, b, c)');
      expect(latex).toBe('\\begin{cases}\na \\\\\nb \\\\\nc\n\\end{cases}');
    });

    it('converts cases with explicit & alignment markers', () => {
      const latex = typstToLatex('cases(1 & "if" x > 0, 0 & "otherwise")');
      expect(latex).toBe(
        '\\begin{cases}\n1 & \\text{if} x > 0 \\\\\n0 & \\text{otherwise}\n\\end{cases}',
      );
    });

    it('converts cases with implicit string condition branches', () => {
      const latex = typstToLatex('cases(1 "if" x > 0, 0 "otherwise")');
      expect(latex).toContain('\\begin{cases}');
      expect(latex).toContain('\\text{if}');
      expect(latex).toContain('\\text{otherwise}');
    });

    it('converts complex multi-branch case from Typst test suite', () => {
      const source = 'cases(1 & "if" x <= 0, 2 & "if" x divides 2, 3 & "if" x in NN, 4 & "else")';
      const latex = typstToLatex(source);
      expect(latex).toContain('1 & \\text{if} x \\le 0');
      expect(latex).toContain('2 & \\text{if} x \\mid 2');
      expect(latex).toContain('3 & \\text{if} x \\in \\mathbb{N}');
      expect(latex).toContain('4 & \\text{else}');
    });

    it('decompiles cases back to Typst', () => {
      const latex = '\\begin{cases} 1 & \\text{if} x > 0 \\\\ 0 & \\text{otherwise} \\end{cases}';
      const typst = latexToTypst(latex);
      expect(typst).toContain('cases(');
      expect(typst).toContain('1');
      expect(typst).toContain('0');
    });
  });

  describe('23. Exhaustive Matrices and Vectors Suite', () => {
    it('converts matrices with all delimiter styles', () => {
      // parentheses (default)
      expect(typstToLatex('mat(1, 2; 3, 4)')).toContain('\\begin{pmatrix}');
      // brackets
      expect(typstToLatex('mat(delim: "[", 1, 2; 3, 4)')).toContain('\\begin{bmatrix}');
      // braces
      expect(typstToLatex('mat(delim: "{", 1, 2; 3, 4)')).toContain('\\begin{Bmatrix}');
      // vertical bars
      expect(typstToLatex('mat(delim: "|", 1, 2; 3, 4)')).toContain('\\begin{vmatrix}');
    });

    it('converts matrices of various dimensions', () => {
      // 1x1
      expect(typstToLatex('mat(42)')).toBe('\\begin{pmatrix}\n42\n\\end{pmatrix}');
      // 1x3 row matrix
      expect(typstToLatex('mat(1, 2, 3)')).toBe('\\begin{pmatrix}\n1 & 2 & 3\n\\end{pmatrix}');
      // 3x1 column matrix via semicolon
      expect(typstToLatex('mat(1; 2; 3)')).toBe(
        '\\begin{pmatrix}\n1 \\\\\n2 \\\\\n3\n\\end{pmatrix}',
      );
      // 3x3 matrix
      const m3x3 = typstToLatex('mat(1, 2, 3; 4, 5, 6; 7, 8, 9)');
      expect(m3x3).toContain('1 & 2 & 3 \\\\\n4 & 5 & 6 \\\\\n7 & 8 & 9');
    });

    it('converts vectors with various lengths and delimiters', () => {
      expect(typstToLatex('vec(x)')).toBe('\\begin{pmatrix}\nx\n\\end{pmatrix}');
      expect(typstToLatex('vec(x, y)')).toBe('\\begin{pmatrix}\nx \\\\\ny\n\\end{pmatrix}');
      expect(typstToLatex('vec(1, 2, 3, 4)')).toBe(
        '\\begin{pmatrix}\n1 \\\\\n2 \\\\\n3 \\\\\n4\n\\end{pmatrix}',
      );
      expect(typstToLatex('vec(delim: "[", a, b)')).toBe(
        '\\begin{bmatrix}\na \\\\\nb\n\\end{bmatrix}',
      );
    });

    it('decompiles all matrix environments back to Typst', () => {
      expect(latexToTypst('\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}')).toBe(
        'mat(1, 2; 3, 4)',
      );
      expect(latexToTypst('\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}')).toBe(
        'mat(delim: "[", 1, 2; 3, 4)',
      );
      expect(latexToTypst('\\begin{Bmatrix} 1 & 2 \\\\ 3 & 4 \\end{Bmatrix}')).toBe(
        'mat(delim: "{", 1, 2; 3, 4)',
      );
      expect(latexToTypst('\\begin{vmatrix} 1 & 2 \\\\ 3 & 4 \\end{vmatrix}')).toBe(
        'mat(delim: "|", 1, 2; 3, 4)',
      );
      expect(latexToTypst('\\begin{pmatrix} 1 \\\\ 2 \\end{pmatrix}')).toBe('vec(1, 2)');
    });
  });

  describe('24. Exhaustive Operators & Precedence Suite', () => {
    it('handles binary arithmetic operators', () => {
      expect(typstToLatex('(c * d) / e')).toBe('\\frac{c \\ast d}{e}');
      expect(typstToLatex('a + b - c * d / e')).toBe('a + b - c \\ast \\frac{d}{e}');
      expect(typstToLatex('a times b div c')).toBe('a \\times b \\div c');
      expect(typstToLatex('a dot b cdot c cross d')).toBe('a \\cdot b \\cdot c \\times d');
      expect(typstToLatex('a oplus b otimes c odot d')).toBe('a \\oplus b \\otimes c \\odot d');
      expect(typstToLatex('a uplus b sqcap c sqcup d')).toBe('a \\uplus b \\sqcap c \\sqcup d');
      expect(typstToLatex('a pm b mp c')).toBe('a \\pm b \\mp c');
      expect(typstToLatex('a plus.minus b minus.plus c')).toBe('a \\pm b \\mp c');
    });

    it('handles unary prefix operators', () => {
      expect(typstToLatex('-x')).toBe('-x');
      expect(typstToLatex('+x')).toBe('+x');
      expect(typstToLatex('-(a + b)')).toBe('-\\left(a + b\\right)');
      expect(typstToLatex('-1 / 2')).toBe('\\frac{-1}{2}');
    });

    it('respects precedence between multiplication, division, and addition', () => {
      // Division binds tighter than addition
      expect(typstToLatex('a + b / c + d')).toBe('a + \\frac{b}{c} + d');
      // Juxtaposition is tighter than addition, looser than division
      expect(typstToLatex('a b / c d')).toBe('a \\frac{b}{c} d');
      // Grouping overrides division
      expect(typstToLatex('(a + b) / (c + d)')).toBe('\\frac{a + b}{c + d}');
    });

    it('handles all order and relational operators', () => {
      expect(typstToLatex('a < b')).toBe('a < b');
      expect(typstToLatex('a > b')).toBe('a > b');
      expect(typstToLatex('a <= b')).toBe('a \\le b');
      expect(typstToLatex('a >= b')).toBe('a \\ge b');
      expect(typstToLatex('a != b')).toBe('a \\neq b');
      expect(typstToLatex('a = b')).toBe('a = b');
      expect(typstToLatex('a << b')).toBe('a \\ll b');
      expect(typstToLatex('a >> b')).toBe('a \\gg b');
      expect(typstToLatex('a approx b')).toBe('a \\approx b');
      expect(typstToLatex('a sim b')).toBe('a \\sim b');
      expect(typstToLatex('a equiv b')).toBe('a \\equiv b');
      expect(typstToLatex('a prec b succ c')).toBe('a \\prec b \\succ c');
      expect(typstToLatex('a prec.eq b succ.eq c')).toBe('a \\preceq b \\succeq c');
    });

    it('handles set and lattice operators', () => {
      expect(typstToLatex('x in A')).toBe('x \\in A');
      expect(typstToLatex('x in.not A')).toBe('x \\notin A');
      expect(typstToLatex('A subset B')).toBe('A \\subset B');
      expect(typstToLatex('A supset B')).toBe('A \\supset B');
      expect(typstToLatex('A subset.eq B')).toBe('A \\subseteq B');
      expect(typstToLatex('A supset.eq B')).toBe('A \\supseteq B');
      expect(typstToLatex('A subset.sq B')).toBe('A \\sqsubset B');
      expect(typstToLatex('A supset.sq B')).toBe('A \\sqsupset B');
      expect(typstToLatex('A subset.eq.sq B')).toBe('A \\sqsubseteq B');
      expect(typstToLatex('A supset.eq.sq B')).toBe('A \\sqsupseteq B');
    });

    it('handles logical operators and tack symbols', () => {
      expect(typstToLatex('forall x exists y (x and y or not z)')).toBe(
        '\\forall x \\exists y \\left(x \\land y \\lor \\neg z\\right)',
      );
      expect(typstToLatex('top bot models forces')).toBe('\\top \\bot \\models \\Vdash');
      expect(typstToLatex('tack.r tack.l tack.r.double')).toBe('\\vdash \\dashv \\vDash');
    });
  });

  describe('25. Exhaustive Accents, Over/Under, & Cancellations Suite', () => {
    it('converts all supported accent marks', () => {
      expect(typstToLatex('hat(x)')).toBe('\\hat{x}');
      expect(typstToLatex('tilde(x)')).toBe('\\tilde{x}');
      expect(typstToLatex('macron(x)')).toBe('\\bar{x}');
      expect(typstToLatex('bar(x)')).toBe('\\bar{x}');
      expect(typstToLatex('dash(x)')).toBe('\\bar{x}');
      expect(typstToLatex('grave(x)')).toBe('\\grave{x}');
      expect(typstToLatex('acute(x)')).toBe('\\acute{x}');
      expect(typstToLatex('dot(x)')).toBe('\\dot{x}');
      expect(typstToLatex('ddot(x)')).toBe('\\ddot{x}');
      expect(typstToLatex('dot.double(x)')).toBe('\\ddot{x}');
      expect(typstToLatex('dddot(x)')).toBe('\\dddot{x}');
      expect(typstToLatex('dot.triple(x)')).toBe('\\dddot{x}');
      expect(typstToLatex('ddddot(x)')).toBe('\\ddddot{x}');
      expect(typstToLatex('dot.quad(x)')).toBe('\\ddddot{x}');
      expect(typstToLatex('breve(x)')).toBe('\\breve{x}');
      expect(typstToLatex('check(x)')).toBe('\\check{x}');
      expect(typstToLatex('caron(x)')).toBe('\\check{x}');
      expect(typstToLatex('arrow(x)')).toBe('\\vec{x}');
      expect(typstToLatex('circle(x)')).toBe('\\mathring{x}');
      expect(typstToLatex('ring(x)')).toBe('\\mathring{x}');
    });

    it('converts over/under lines, braces, and brackets with and without annotations', () => {
      expect(typstToLatex('underline(x)')).toBe('\\underline{x}');
      expect(typstToLatex('overline(x)')).toBe('\\overline{x}');
      expect(typstToLatex('underbrace(x + y)')).toBe('\\underbrace{x + y}');
      expect(typstToLatex('underbrace(x + y, n)')).toBe('\\underbrace{x + y}_{n}');
      expect(typstToLatex('overbrace(x + y)')).toBe('\\overbrace{x + y}');
      expect(typstToLatex('overbrace(x + y, n)')).toBe('\\overbrace{x + y}^{n}');
      expect(typstToLatex('underbracket(x + y)')).toBe('\\underbracket{x + y}');
      expect(typstToLatex('underbracket(x + y, k)')).toBe('\\underbracket{x + y}_{k}');
      expect(typstToLatex('overbracket(x + y)')).toBe('\\overbracket{x + y}');
      expect(typstToLatex('overbracket(x + y, k)')).toBe('\\overbracket{x + y}^{k}');
    });

    it('converts cancellation styles', () => {
      expect(typstToLatex('cancel(x)')).toBe('\\cancel{x}');
      expect(typstToLatex('cancel(x, inverted: true)')).toBe('\\bcancel{x}');
      expect(typstToLatex('cancel(x, cross: true)')).toBe('\\xcancel{x}');
    });
  });

  describe('26. Exhaustive Big Operators & Integrals Suite', () => {
    it('converts single, double, triple, and contour integrals', () => {
      expect(typstToLatex('integral f(x) dif x')).toBe('\\int f\\left(x\\right) \\mathrm{d} x');
      expect(typstToLatex('integral.double f(x, y) dif x dif y')).toBe(
        '\\iint f\\left(x, y\\right) \\mathrm{d} x \\mathrm{d} y',
      );
      expect(typstToLatex('integral.triple f(x, y, z)')).toBe('\\iiint f\\left(x, y, z\\right)');
      expect(typstToLatex('integral.cont f(z) dif z')).toBe(
        '\\oint f\\left(z\\right) \\mathrm{d} z',
      );
      expect(typstToLatex('integral.surf f(S)')).toBe('\\oiint f\\left(S\\right)');
      expect(typstToLatex('integral.vol f(V)')).toBe('\\oiiint f\\left(V\\right)');
    });

    it('converts big operators with script bounds', () => {
      expect(typstToLatex('sum_(k=0)^oo 1 / 2^k')).toBe('\\sum_{k = 0}^{\\infty} \\frac{1}{2^k}');
      expect(typstToLatex('prod_(i=1)^n x_i')).toBe('\\prod_{i = 1}^n x_i');
      expect(typstToLatex('coprod_(i=1)^n A_i')).toBe('\\coprod_{i = 1}^n A_i');
      expect(typstToLatex('lim_(x -> oo) 1 / x = 0')).toBe(
        '\\lim_{x \\to \\infty} \\frac{1}{x} = 0',
      );
      expect(typstToLatex('liminf_(n -> oo) x_n')).toBe('\\liminf_{n \\to \\infty} x_n');
      expect(typstToLatex('limsup_(n -> oo) x_n')).toBe('\\limsup_{n \\to \\infty} x_n');
    });
  });

  describe('27. Math Fidelity & Decompiler Edge Cases Suite', () => {
    it('round-trips binom without decomposing into letter sequence', () => {
      const latex = typstToLatex('binom(n, k)');
      expect(latex).toBe('\\binom{n}{k}');
      expect(latexToTypst(latex)).toBe('binom(n, k)');
    });

    it('round-trips floor and ceil delimiters cleanly', () => {
      const floorLatex = typstToLatex('floor(x)');
      expect(floorLatex).toBe('\\left\\lfloor x \\right\\rfloor');
      expect(latexToTypst(floorLatex)).toBe('floor(x)');

      const ceilLatex = typstToLatex('ceil(x)');
      expect(ceilLatex).toBe('\\left\\lceil x \\right\\rceil');
      expect(latexToTypst(ceilLatex)).toBe('ceil(x)');
    });

    it('round-trips double brackets [| x |] without losing content', () => {
      const latex = typstToLatex('[| x |]');
      expect(latex).toBe('\\llbracket x \\rrbracket');
      expect(latexToTypst(latex)).toBe('[|x|]');
    });

    it('decompiles \\leftarrow and \\rightarrow without delimiter prefix hijacking', () => {
      expect(latexToTypst('\\leftarrow')).toBe('<-');
      expect(latexToTypst('\\rightarrow')).toBe('->');
      expect(latexToTypst('a \\leftarrow b')).toBe('a <- b');
      expect(latexToTypst('a \\rightarrow b')).toBe('a -> b');
    });

    it('distinguishes norm and abs delimiters', () => {
      const normLatex = typstToLatex('norm(x)');
      expect(normLatex).toBe('\\left\\|x\\right\\|');
      expect(latexToTypst(normLatex)).toBe('norm(x)');

      const absLatex = typstToLatex('abs(x)');
      expect(absLatex).toBe('\\left|x\\right|');
      expect(latexToTypst(absLatex)).toBe('abs(x)');
    });

    it('converts matrix with delim: #none without phantom cells', () => {
      const latex = typstToLatex('mat(delim: #none, 1, 2; 3, 4)');
      expect(latex).toBe('\\begin{matrix}\n1 & 2 \\\\\n3 & 4\n\\end{matrix}');
      expect(latexToTypst(latex)).toBe('mat(delim: #none, 1, 2; 3, 4)');
    });

    it('handles postfix factorial with correct fraction precedence', () => {
      expect(typstToLatex('n! / 2')).toBe('\\frac{n!}{2}');
      expect(typstToLatex('n! + 1')).toBe('n! + 1');
      expect(typstToLatex('k! * m!')).toBe('k! \\ast m!');
    });

    it('converts unicode radical glyphs to roots', () => {
      expect(typstToLatex('√x')).toBe('\\sqrt{x}');
      expect(typstToLatex('∛x')).toBe('\\sqrt[3]{x}');
      expect(typstToLatex('∜x')).toBe('\\sqrt[4]{x}');
    });

    it('handles spacing primitives', () => {
      expect(typstToLatex('a thin b')).toBe('a \\, b');
      expect(typstToLatex('a med b')).toBe('a \\: b');
      expect(typstToLatex('a thick b')).toBe('a \\; b');
      expect(typstToLatex('a quad b')).toBe('a \\quad b');
      expect(typstToLatex('a wide b')).toBe('a \\qquad b');
    });

    it('handles escaped characters', () => {
      expect(typstToLatex('\\( a + b \\)')).toBe('\\( a + b \\)');
      expect(typstToLatex('x\\_1')).toBe('x \\_ 1');
    });

    it('converts diaeresis and directional arrows', () => {
      expect(typstToLatex('diaer(a)')).toBe('\\ddot{a}');
      expect(typstToLatex('arrow.l(x)')).toBe('\\overleftarrow{x}');
      // `arrow.r` is the → symbol, not an accent: a call renders →(x).
      expect(typstToLatex('arrow.r(x)')).toBe('\\to\\left(x\\right)');
      expect(typstToLatex('arrow(x)')).toBe('\\vec{x}');
    });

    it('preserves unknown command argument structure instead of dropping braces', () => {
      expect(latexToTypst('\\customfunc{x}')).toBe('customfunc(x)');
    });

    it('detects math format for Typst and LaTeX constructs', () => {
      expect(detectFormat('mat(1, 2; 3, 4)')).toBe('typst');
      expect(detectFormat('vec(1, 2)')).toBe('typst');
      expect(detectFormat('cases(1, 2)')).toBe('typst');
      expect(detectFormat('[|x|]')).toBe('typst');
      expect(detectFormat('a ==> b')).toBe('typst');
      expect(detectFormat('a |-> b')).toBe('typst');
      expect(detectFormat('\\begin{aligned} a & b \\end{aligned}')).toBe('latex');
      expect(detectFormat('\\left( \\frac{a}{b} \\right)')).toBe('latex');
    });

    it('round-trips math styles (display, inline, script, sscript)', () => {
      expect(typstToLatex('display(x)')).toBe('{\\displaystyle x}');
      expect(typstToLatex('inline(x)')).toBe('{\\textstyle x}');
      expect(typstToLatex('script(x)')).toBe('{\\scriptstyle x}');
      expect(typstToLatex('sscript(x)')).toBe('{\\scriptscriptstyle x}');

      expect(latexToTypst('{\\displaystyle x}')).toBe('display(x)');
      expect(latexToTypst('{\\textstyle x}')).toBe('inline(x)');
      expect(latexToTypst('{\\scriptstyle x}')).toBe('script(x)');
      expect(latexToTypst('{\\scriptscriptstyle x}')).toBe('sscript(x)');
    });

    it('decompiles negated relations with \\not prefix', () => {
      expect(latexToTypst('a \\not\\approx b')).toBe('a approx.not b');
      expect(latexToTypst('a \\not\\equiv b')).toBe('a equiv.not b');
      expect(latexToTypst('a \\not\\subset b')).toBe('a subset.not b');
      expect(latexToTypst('a \\not\\in b')).toBe('a in.not b');
      expect(latexToTypst('a \\not= b')).toBe('a != b');
      expect(latexToTypst('a \\not \\approx b')).toBe('a approx.not b');
    });

    it('converts and decompiles chevron and angle delimiters', () => {
      expect(typstToLatex('chevron.l(x)')).toBe('\\left\\langle x\\right\\rangle');
      expect(latexToTypst('\\left\\langle x \\right\\rangle')).toBe('chevron.l(x)');
      expect(latexToTypst('\\langle x \\rangle')).toBe('chevron.l x chevron.r');
      expect(latexToTypst('\\left\\lvert x \\right\\rvert')).toBe('abs(x)');
      expect(latexToTypst('\\left\\lVert x \\right\\rVert')).toBe('norm(x)');
    });

    it('does not conflate grouping braces in scripts with set delimiters', () => {
      expect(typstToLatex('a_b^{c}')).toBe('a_b^c');
      expect(typstToLatex('a^{b + c}')).toBe('a^{b + c}');
      expect(latexToTypst('a_b^{c}')).toBe('a_b^c');
    });

    it('preserves alignment ampersands in cases and accepts & in vectors', () => {
      expect(latexToTypst('\\begin{cases} a & b \\\\ c & d \\end{cases}')).toBe(
        'cases(a & b, c & d)',
      );
      expect(() => typstToLatex('vec("a" & b, "c" & d)')).not.toThrow();
    });

    it('distinguishes function call from juxtaposition in decompilation', () => {
      expect(latexToTypst('f\\left(x\\right)')).toBe('f(x)');
      expect(latexToTypst('f \\left(x\\right)')).toBe('f (x)');
      expect(typstToLatex('f(x)')).toBe('f\\left(x\\right)');
      expect(typstToLatex('f (x)')).toBe('f \\left(x\\right)');
    });

    it('handles dif and Dif correctly without fiction refusal', () => {
      // Upright differential d to match Typst rendering.
      expect(typstToLatex('dif x')).toBe('\\mathrm{d} x');
      expect(typstToLatex('Dif x')).toBe('\\mathrm{D} x');
      expect(typstToVerifiedLatex('Dif x').output).toBe('\\mathrm{D} x');
      expect(latexToTypst('\\dif x')).toBe('dif x');
      expect(latexToTypst('\\Dif x')).toBe('Dif x');
    });

    it('handles root(, 3) and root(3) as square roots', () => {
      expect(typstToLatex('root(, 3)')).toBe('\\sqrt{3}');
      expect(typstToLatex('root(3)')).toBe('\\sqrt{3}');
      expect(typstToLatex('root(3, x)')).toBe('\\sqrt[3]{x}');
      expect(typstToVerifiedLatex('root(, 3)').output).toBe('\\sqrt{3}');
      expect(typstToVerifiedLatex('root(3)').output).toBe('\\sqrt{3}');
    });

    it('decompiles foreign KaTeX sizing commands and middle delimiters cleanly', () => {
      expect(latexToTypst('\\big( x \\big)')).toBe('(x)');
      expect(latexToTypst('\\Big[ x \\Big]')).toBe('[x]');
      expect(latexToTypst('\\bigl( x \\bigr)')).toBe('(x)');
      expect(latexToTypst('\\big| x \\big|')).toBe('| x |');
      expect(latexToTypst('\\bigm|')).toBe('mid(|)');
      expect(latexToTypst('\\left( a \\middle| b \\right)')).toBe('(a mid(|) b)');
      expect(latexToTypst('\\left\\{ x \\middle| x > 0 \\right\\}')).toBe('{ x mid(|) x > 0 }');
      expect(typstToLatex('(a mid(|) b)')).toBe('\\left(a \\middle | b\\right)');
      expect(typstToVerifiedLatex('(a mid(|) b)').output).toBe('\\left(a \\middle | b\\right)');
    });

    it('handles doteq and hook arrows', () => {
      expect(latexToTypst('a \\doteq b')).toBe('a eq.dot b');
      expect(typstToLatex('a eq.dot b')).toBe('a \\doteq b');
      expect(typstToLatex('a dot.eq b')).toBe('a \\doteq b');
      expect(typstToVerifiedLatex('a eq.dot b').output).toBe('a \\doteq b');
      expect(latexToTypst('a \\hookrightarrow b')).toBe('a arrow.r.hook b');
      expect(latexToTypst('a \\hookleftarrow b')).toBe('a arrow.l.hook b');
      expect(typstToLatex('a arrow.r.hook b')).toBe('a \\hookrightarrow b');
      expect(typstToLatex('a arrow.l.hook b')).toBe('a \\hookleftarrow b');
      expect(typstToVerifiedLatex('a arrow.r.hook b').output).toBe('a \\hookrightarrow b');
    });

    it('combines multiple spaced primes without trivia collapse', () => {
      expect(typstToLatex("a' ' '")).toBe("a'''");
      expect(typstToLatex("a' ' '_1")).toBe("a'''_1");
      expect(typstToVerifiedLatex("a' ' '").output).toBe("a'''");
    });

    it('handles degree correctly and decompiles ^\\circ and ^{\\circ} to degree', () => {
      expect(typstToLatex('45 degree')).toBe('45 \\degree');
      expect(typstToVerifiedLatex('45 degree').output).toBe('45 \\degree');
      expect(latexToTypst('45 \\degree')).toBe('45 degree');
      expect(latexToTypst('45^\\circ')).toBe('45 degree');
      expect(latexToTypst('45^{\\circ}')).toBe('45 degree');
      expect(latexToTypst('^\\circ')).toBe('degree');
    });

    it('preserves right-associative semantics on chained superscripts and subscripts', () => {
      expect(typstToLatex('x^a^b')).toBe('x^{a^b}');
      expect(typstToLatex('x^a^b^c')).toBe('x^{a^{b^c}}');
      expect(typstToVerifiedLatex('x^a^b').output).toBe('x^{a^b}');
      expect(latexToTypst('x^{a^b}')).toBe('x^(a^b)');
      expect(typstToLatex('x_a_b')).toBe('x_{a_b}');
      expect(typstToLatex('x_a_b_c')).toBe('x_{a_{b_c}}');
      expect(typstToVerifiedLatex('x_a_b').output).toBe('x_{a_b}');
      expect(typstToLatex("f'^2")).toBe("f'^2");
      expect(typstToLatex("f'_1^2")).toBe("f'_1^2");
      expect(typstToVerifiedLatex("f'^2").output).toBe("f'^2");
    });

    it('handles percent symbol without shredding or comment collision', () => {
      expect(typstToLatex('50% x')).toBe('50 \\% x');
      expect(typstToVerifiedLatex('50% x').output).toBe('50 \\% x');
      expect(latexToTypst('50\\% x')).toBe('50% x');
      expect(latexToTypst('50 \\% x')).toBe('50 % x');
    });

    it('handles escapes for exclamation, slash, and percent', () => {
      expect(typstToLatex('a\\!b')).toBe('a! b');
      // `\/` is a literal slash (fraction is bare `/`); it maps to `\slash`
      // so KaTeX renders a slash instead of building a fraction.
      expect(typstToLatex('a \\/ b')).toBe('a \\slash b');
      expect(typstToVerifiedLatex('a \\/ b').output).toBe('a \\slash b');
      expect(latexToTypst('a \\slash b')).toBe('a \\/ b');
    });

    it('decompiles single-token unbraced fraction arguments and variants', () => {
      expect(latexToTypst('\\frac12')).toBe('1 / 2');
      expect(latexToTypst('\\frac\\alpha\\beta')).toBe('alpha / beta');
      expect(latexToTypst('\\tfrac{1}{2}')).toBe('1 / 2');
      expect(latexToTypst('\\cfrac{1}{2}')).toBe('1 / 2');
    });

    it('handles dots.up with KaTeX unicode glyph and aliases', () => {
      expect(typstToLatex('dots.up')).toBe('\u22f0');
      expect(latexToTypst('\\iddots')).toBe('dots.up');
      expect(latexToTypst('\\adots')).toBe('dots.up');
      expect(latexToTypst('\u22f0')).toBe('dots.up');
    });

    it('wraps aligned delimiters in environment instead of invalid left-right aligned', () => {
      expect(typstToLatex('(a & b)')).toBe('\\begin{pmatrix}\na & b\n\\end{pmatrix}');
      expect(typstToLatex('[a & b]')).toBe('\\begin{bmatrix}\na & b\n\\end{bmatrix}');
    });

    it('handles missing Typst symbols and functions with verified round-trips', () => {
      expect(typstToVerifiedLatex('a compose b').output).toBe('a \\circ b');
      expect(typstToVerifiedLatex('a therefore b').output).toBe('a \\therefore b');
      expect(typstToVerifiedLatex('A inter B').output).toBe('A \\cap B');
      expect(typstToVerifiedLatex('a asymp b').output).toBe('a \\asymp b');
      expect(typstToVerifiedLatex('a plus.o b').output).toBe('a \\oplus b');
      expect(typstToVerifiedLatex('a times.o b').output).toBe('a \\otimes b');
      expect(typstToVerifiedLatex('csch(x)').output).toBe('\\operatorname{csch}\\left(x\\right)');
      expect(typstToVerifiedLatex('sech(x)').output).toBe('\\operatorname{sech}\\left(x\\right)');
      expect(typstToVerifiedLatex('ctg(x)').output).toBe('\\operatorname{ctg}\\left(x\\right)');
      expect(typstToVerifiedLatex('tg(x)').output).toBe('\\operatorname{tg}\\left(x\\right)');
      expect(typstToVerifiedLatex('lg(x)').output).toBe('\\lg\\left(x\\right)');
      expect(typstToVerifiedLatex('Pr(x)').output).toBe('\\Pr\\left(x\\right)');
    });

    it('converts and decompiles round, harpoon, and attach', () => {
      expect(typstToLatex('round(x)')).toBe('\\left\\lfloor x \\right\\rceil');
      expect(latexToTypst('\\left\\lfloor x \\right\\rceil')).toBe('round(x)');
      expect(typstToVerifiedLatex('round(x)').output).toBe('\\left\\lfloor x \\right\\rceil');

      expect(typstToLatex('harpoon(x)')).toBe('\\overrightharpoon{x}');
      expect(latexToTypst('\\overrightharpoon{x}')).toBe('harpoon(x)');
      expect(typstToVerifiedLatex('harpoon(x)').output).toBe('\\overrightharpoon{x}');

      expect(typstToLatex('harpoon.lt(x)')).toBe('\\overleftharpoon{x}');
      expect(latexToTypst('\\overleftharpoon{x}')).toBe('harpoon.lt(x)');
      expect(typstToVerifiedLatex('harpoon.lt(x)').output).toBe('\\overleftharpoon{x}');

      expect(typstToLatex('attach(A, t: 1, b: 2)')).toBe('A_{2}^{1}');
      expect(typstToLatex('attach(A, tl: 1, bl: 2, tr: 3, br: 4)')).toBe('{}^{1}_{2}A_{4}^{3}');
    });

    it('refuses alignment tabs nested inside atoms instead of storing unloadable LaTeX', () => {
      expect(() => typstToVerifiedLatex('x_{a & b}')).toThrow(ConversionError);
      expect(() => typstToVerifiedLatex('frac(a & b, c)')).toThrow(ConversionError);
      expect(() => typstToVerifiedLatex('sqrt(a \\\\ b)')).toThrow(ConversionError);
    });

    it('rejects wrong-arity calls instead of dropping arguments', () => {
      expect(() => typstToVerifiedLatex('root(2, 3, x)')).toThrow(ConversionError);
      expect(() => typstToVerifiedLatex('sqrt(x, y)')).toThrow(ConversionError);
      expect(() => typstToVerifiedLatex('underbrace(x, y, z)')).toThrow(ConversionError);
      expect(() => typstToVerifiedLatex('binom(n)')).toThrow(ConversionError);
    });

    it('refuses shell-significant characters with no math meaning', () => {
      expect(() => typstToVerifiedLatex('a$b')).toThrow(ConversionError);
      expect(() => typstToVerifiedLatex('price #2')).toThrow(ConversionError);
    });

    it('refuses accents with no KaTeX counterpart instead of wrong glyphs', () => {
      expect(() => typstToVerifiedLatex('acute.double(x)')).toThrow(ConversionError);
    });

    it('handles named argument forms for frac, binom, and root', () => {
      expect(typstToLatex('frac(num: a, denom: b)')).toBe('\\frac{a}{b}');
      expect(typstToVerifiedLatex('binom(upper: n, lower: k)').output).toBe('\\binom{n}{k}');
      expect(typstToVerifiedLatex('root(index: 3, radicand: x)').output).toBe('\\sqrt[3]{x}');
    });

    it('skips styling values without throwing on dimensions', () => {
      expect(() => typstToLatex('mat(gap: 1em, 1, 2; 3, 4)')).not.toThrow();
      expect(() => typstToLatex('mat(row-gap: 5pt, 1; 2)')).not.toThrow();
      expect(() => typstToLatex('cancel(x, length: #200%)')).not.toThrow();
    });

    it('round-trips modular congruence and hidden content', () => {
      expect(typstToVerifiedLatex('mod(m)').output).toBe('\\pmod{m}');
      expect(latexToTypst('\\pmod{m}')).toBe('mod(m)');
      expect(latexToTypst('a \\bmod b')).toBe('a mod b');
      expect(typstToVerifiedLatex('hide(x)').output).toBe('\\phantom{x}');
      expect(latexToTypst('\\phantom{x}')).toBe('hide(x)');
      expect(latexToTypst('\\smash{x}')).toBe('x');
    });

    it('passes through style wrappers that KaTeX cannot express', () => {
      expect(typstToLatex('lr(a, b)')).toBe('a, b');
      expect(typstToLatex('class("rel", x)')).toBe('x');
      expect(typstToLatex('op("custom")')).toBe('\\operatorname{custom}');
    });

    it('decompiles extended font, spacing, and limit commands', () => {
      expect(latexToTypst('\\textsf{x}')).toBe('sans(x)');
      expect(latexToTypst('\\texttt{x}')).toBe('mono(x)');
      expect(latexToTypst('a\\medspace b')).toBe('a space.med b');
      expect(latexToTypst('a\\thickspace b')).toBe('a space.thick b');
      expect(latexToTypst('\\operatorname*{f}')).toBe('f');
      expect(latexToTypst('\\lim\\nolimits_x')).toBe('lim_x');
      expect(latexToTypst('\\substack{a \\\\ b}')).toBe('a, b');
      expect(latexToTypst('x\\hspace{1em}y')).toBe('x space.quad y');
    });

    it('refuses LaTeX with no faithful Typst mapping so it pre-fills verbatim', () => {
      expect(() => latexToTypst('\\begin{CD} a \\end{CD}')).toThrow();
      expect(() => latexToTypst('{a \\atop b}')).toThrow();
      expect(() => latexToTypst('{n \\choose k}')).toThrow();
      expect(() => latexToTypst('\\textcolor{red}{x}')).toThrow();
      expect(() => latexToTypst('a$b')).toThrow();
    });

    it('decompiles array and brace-side cases variants', () => {
      expect(latexToTypst('\\begin{array}{cc} a & b \\\\ c & d \\end{array}')).toBe(
        'mat(delim: #none, a, b; c, d)',
      );
      expect(latexToTypst('\\begin{rcases} a \\\\ b \\end{rcases}')).toBe('cases(a, b)');
      expect(latexToTypst('\\begin{align*} a &= 1 \\\\ b &= 2 \\end{align*}')).toBe(
        'a & = 1 \\\n b & = 2',
      );
    });

    it('keeps the opening shape on mismatched delimiters and unwraps invisible ones', () => {
      expect(latexToTypst('\\left(0, 1\\right]')).toBe('(0, 1)');
      expect(latexToTypst('\\left. a \\right)')).toBe('a )');
      expect(latexToTypst('\\left. x \\right\\rfloor')).toBe('floor(x)');
    });

    it('strips nested math fences and classifies Typst multiline as Typst', () => {
      expect(detectFormat('x &= 1 \\ y &= 2')).toBe('typst');
      expect(latexToTypst('$$\\frac{a}{b}$$')).toBe('a / b');
    });

    it('refuses unclosed and mismatched delimiters instead of storing raw braces', () => {
      for (const bad of ['{#none', '(a', '[a', '(0, 1]', '[|x', 'x_{a', 'frac(a, b']) {
        expect(() => typstToVerifiedLatex(bad)).toThrow(ConversionError);
      }
    });
  });
});
