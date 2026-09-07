import type { MathNode } from './types';
import { TYPST_TO_LATEX_SYMBOLS } from './symbols';

export interface EmitOptions {
  blockMathMode?: boolean;
}

export class MathEmitter {
  // Reserved for future block-aware emission. Output is currently canonical
  // inner LaTeX in both modes (`aligned` is valid inline and display); the
  // block flag travels on the RichText element instead.
  private blockMathMode: boolean;

  constructor(options: EmitOptions = {}) {
    this.blockMathMode = !!options.blockMathMode;
  }

  emit(node: MathNode): string {
    // Refuse `&` / `\\` nested where KaTeX cannot parse them (inside scripts,
    // call args, roots, fractions). Delimited/matrix/cases bodies are tabular
    // contexts and convert to a suitable environment instead.
    this.assertValidAlignment(node);
    const rawLatex = this.emitNode(node);

    // 1. Check if alignment environment is required:
    // If top-level contains alignment '&' or linebreak '\\'
    const needsAligned = this.hasTopLevelAlignment(node);

    let output = rawLatex;
    if (needsAligned) {
      output = `\\begin{aligned}\n${rawLatex}\n\\end{aligned}`;
    }

    // 2. Canonicalize matrix delimiters: \left( \begin{matrix} ... \end{matrix} \right) -> \begin{pmatrix} ... \end{pmatrix}
    output = canonicalizeMatrixDelimiters(output);

    // 3. Canonicalize font wrapper redundancies (\mathrm{\mathbf{X}} -> \mathbf{X}, etc.)
    output = canonicalizeLatexFontWrappers(output);

    return output;
  }

  private hasTopLevelAlignment(node: MathNode): boolean {
    if (node.type === 'align' || node.type === 'linebreak') {
      return true;
    }
    if (node.type === 'sequence') {
      return node.elements.some((child) => this.hasTopLevelAlignment(child));
    }
    if (node.type === 'binary') {
      return this.hasTopLevelAlignment(node.left) || this.hasTopLevelAlignment(node.right);
    }
    return false;
  }

  /**
   * Reject alignment tabs and linebreaks nested inside atoms where KaTeX has
   * no tabular context (scripts, call arguments, roots, fractions, unary).
   * Without this, e.g. `x_{a & b}` would store unloadable LaTeX.
   */
  private assertValidAlignment(node: MathNode, nestedInAtom = false): void {
    switch (node.type) {
      case 'align':
      case 'linebreak':
        if (nestedInAtom) {
          throw new Error(
            `'${node.type === 'align' ? '&' : '\\'}' is only supported at the top level or inside mat/vec/cases cells, not inside subscripts, superscripts, arguments, or fractions.`,
          );
        }
        return;
      case 'sequence':
        for (const child of node.elements) {
          this.assertValidAlignment(child, nestedInAtom);
        }
        return;
      case 'binary':
        this.assertValidAlignment(node.left, nestedInAtom);
        this.assertValidAlignment(node.right, nestedInAtom);
        return;
      case 'delimited':
        // Parenthesized bodies convert to a matrix environment when they
        // carry top-level alignment, so their top level is tabular-capable.
        this.assertValidAlignment(node.body, false);
        return;
      case 'matrix':
        for (const row of node.rows) {
          for (const cell of row) this.assertValidAlignment(cell, false);
        }
        return;
      case 'cases':
        for (const branch of node.branches) {
          for (const cell of branch) this.assertValidAlignment(cell, false);
        }
        return;
      case 'script':
        this.assertValidAlignment(node.base, true);
        if (node.sub) this.assertValidAlignment(node.sub, true);
        if (node.sup) this.assertValidAlignment(node.sup, true);
        return;
      case 'call':
        for (const arg of node.args) this.assertValidAlignment(arg, true);
        for (const key of Object.keys(node.namedArgs)) {
          this.assertValidAlignment(node.namedArgs[key], true);
        }
        return;
      case 'root':
        if (node.index) this.assertValidAlignment(node.index, true);
        this.assertValidAlignment(node.radicand, true);
        return;
      case 'unary':
        this.assertValidAlignment(node.argument, true);
        return;
      case 'postfix':
        this.assertValidAlignment(node.argument, true);
        return;
      case 'fraction':
        this.assertValidAlignment(node.numer, true);
        this.assertValidAlignment(node.denom, true);
        return;
      default:
        return;
    }
  }

  emitNode(node: MathNode): string {
    switch (node.type) {
      case 'ident':
        if (node.name === '#none') return '';
        if (node.name.startsWith('#') && node.name.length > 1) {
          return node.name.slice(1);
        }
        return node.name;

      case 'number':
        return node.value;

      case 'string':
        return `\\text{${escapeLatexText(node.value)}}`;

      case 'symbol':
        if (node.latex === '%') return '\\%';
        return node.latex;

      case 'unary': {
        const argStr = this.emitNode(node.argument);
        return `${node.op}${argStr}`;
      }

      case 'binary': {
        const leftStr = this.emitNode(node.left);
        const rightStr = this.emitNode(node.right);
        const opStr = this.emitBinaryOp(node.op);
        return `${leftStr} ${opStr} ${rightStr}`;
      }

      case 'fraction': {
        const numerStr = this.emitNode(node.numer);
        const denomStr = this.emitNode(node.denom);
        return `\\frac{${numerStr}}{${denomStr}}`;
      }

      case 'root': {
        const radStr = this.emitNode(node.radicand);
        if (node.index) {
          const idxStr = this.emitNode(node.index);
          return `\\sqrt[${idxStr}]{${radStr}}`;
        }
        return `\\sqrt{${radStr}}`;
      }

      case 'script': {
        const baseStr = this.emitNode(node.base);
        let result = baseStr;

        const isPrime = node.sup?.type === 'ident' && /^'+$/.test(node.sup.name);

        if (node.sup?.type === 'ident' && /^'+$/.test(node.sup.name)) {
          result += node.sup.name;
        }

        if (node.sub) {
          const subStr = this.emitNode(node.sub);
          result += /^[a-zA-Z0-9]$/.test(subStr) ? `_${subStr}` : `_{${subStr}}`;
        }

        if (node.sup && !isPrime) {
          const supStr = this.emitNode(node.sup);
          result += /^[a-zA-Z0-9]$/.test(supStr) ? `^${supStr}` : `^{${supStr}}`;
        }

        return result;
      }

      case 'delimited': {
        const hasAlignment = this.hasTopLevelAlignment(node.body);
        const bodyStr = this.emitNode(node.body);
        if (hasAlignment) {
          if (node.open === '(' && node.close === ')') {
            return `\\begin{pmatrix}\n${bodyStr}\n\\end{pmatrix}`;
          }
          if (node.open === '[' && node.close === ']') {
            return `\\begin{bmatrix}\n${bodyStr}\n\\end{bmatrix}`;
          }
          if (node.open === '{' && node.close === '}') {
            return `\\begin{Bmatrix}\n${bodyStr}\n\\end{Bmatrix}`;
          }
          if (node.open === '|' && node.close === '|') {
            return `\\begin{vmatrix}\n${bodyStr}\n\\end{vmatrix}`;
          }
          if (node.open === '||' && node.close === '||') {
            return `\\begin{Vmatrix}\n${bodyStr}\n\\end{Vmatrix}`;
          }
          return `\\left${node.open}\\begin{aligned}\n${bodyStr}\n\\end{aligned}\\right${node.close}`;
        }
        if (node.open === '(' && node.close === ')') {
          return `\\left(${bodyStr}\\right)`;
        }
        if (node.open === '[' && node.close === ']') {
          return `\\left[${bodyStr}\\right]`;
        }
        if (node.open === '{' && node.close === '}') {
          return `\\left\\{${bodyStr}\\right\\}`;
        }
        if (node.open === '|' && node.close === '|') {
          return `\\left|${bodyStr}\\right|`;
        }
        if (node.open === '||' && node.close === '||') {
          return `\\left\\|${bodyStr}\\right\\|`;
        }
        if (node.open === '[|' && node.close === '|]') {
          return `\\llbracket ${bodyStr} \\rrbracket`;
        }
        return `${node.open}${bodyStr}${node.close}`;
      }

      case 'postfix': {
        return `${this.emitNode(node.argument)}${node.op}`;
      }

      case 'matrix': {
        const env = getMatrixEnv(node.delim);
        const rowsStr = node.rows
          .map((row) => row.map((cell) => this.emitNode(cell)).join(' & '))
          .join(' \\\\\n');
        return `\\begin{${env}}\n${rowsStr}\n\\end{${env}}`;
      }

      case 'cases': {
        const branchesStr = node.branches
          .map((b) => b.map((cell) => this.emitNode(cell)).join(' & '))
          .join(' \\\\\n');
        return `\\begin{cases}\n${branchesStr}\n\\end{cases}`;
      }

      case 'call':
        return this.emitCall(node);

      case 'align':
        return '&';

      case 'linebreak':
        return '\\\\\n';

      case 'sequence': {
        return this.emitSequence(node.elements);
      }
    }
  }

  private emitBinaryOp(op: string): string {
    return TYPST_TO_LATEX_SYMBOLS[op] ?? op;
  }

  private emitCall(node: {
    name: string;
    args: MathNode[];
    namedArgs: Record<string, MathNode>;
  }): string {
    const { name, args, namedArgs } = node;

    // Reject wrong-arity calls instead of silently dropping arguments (e.g.
    // `root(2, 3, x)` previously exported only `\sqrt[2]{3}`, losing `x`).
    assertCallArity(name, args.length);

    // Font styles
    if (name === 'bold' && args.length >= 1) {
      return `\\mathbf{${this.emitNode(args[0])}}`;
    }
    if (name === 'upright' || name === 'mathrm' || name === 'serif') {
      return `\\mathrm{${this.emitNode(args[0])}}`;
    }
    if (name === 'italic' && args.length >= 1) {
      return `\\mathit{${this.emitNode(args[0])}}`;
    }
    if (name === 'sans' && args.length >= 1) {
      return `\\mathsf{${this.emitNode(args[0])}}`;
    }
    if (name === 'cal' && args.length >= 1) {
      return `\\mathcal{${this.emitNode(args[0])}}`;
    }
    if (name === 'scr' && args.length >= 1) {
      return `\\mathscr{${this.emitNode(args[0])}}`;
    }
    if (name === 'frak' && args.length >= 1) {
      return `\\mathfrak{${this.emitNode(args[0])}}`;
    }
    if (name === 'mono' && args.length >= 1) {
      return `\\mathtt{${this.emitNode(args[0])}}`;
    }
    if (name === 'bb' && args.length >= 1) {
      return `\\mathbb{${this.emitNode(args[0])}}`;
    }

    // Accents
    if (name === 'hat' && args.length >= 1) return `\\hat{${this.emitNode(args[0])}}`;
    if (name === 'tilde' && args.length >= 1) return `\\tilde{${this.emitNode(args[0])}}`;
    if ((name === 'bar' || name === 'macron' || name === 'dash') && args.length >= 1) {
      return `\\bar{${this.emitNode(args[0])}}`;
    }
    if (name === 'grave' && args.length >= 1) return `\\grave{${this.emitNode(args[0])}}`;
    if (name === 'acute' && args.length >= 1) return `\\acute{${this.emitNode(args[0])}}`;
    if (name === 'dot' && args.length >= 1) return `\\dot{${this.emitNode(args[0])}}`;
    if ((name === 'ddot' || name === 'dot.double') && args.length >= 1) {
      return `\\ddot{${this.emitNode(args[0])}}`;
    }
    if ((name === 'dddot' || name === 'dot.triple') && args.length >= 1) {
      return `\\dddot{${this.emitNode(args[0])}}`;
    }
    if ((name === 'ddddot' || name === 'dot.quad') && args.length >= 1) {
      return `\\ddddot{${this.emitNode(args[0])}}`;
    }
    if (name === 'breve' && args.length >= 1) return `\\breve{${this.emitNode(args[0])}}`;
    if ((name === 'check' || name === 'caron') && args.length >= 1) {
      return `\\check{${this.emitNode(args[0])}}`;
    }
    if ((name === 'arrow' || name === 'vec') && args.length === 1) {
      return `\\vec{${this.emitNode(args[0])}}`;
    }
    if ((name === 'circle' || name === 'ring') && args.length >= 1) {
      return `\\mathring{${this.emitNode(args[0])}}`;
    }

    // Over/Under lines & braces
    if (name === 'underline' && args.length >= 1) {
      return `\\underline{${this.emitNode(args[0])}}`;
    }
    if (name === 'overline' && args.length >= 1) {
      return `\\overline{${this.emitNode(args[0])}}`;
    }
    if (name === 'underbrace' && args.length >= 1) {
      const base = `\\underbrace{${this.emitNode(args[0])}}`;
      return args.length > 1 ? `${base}_{${this.emitNode(args[1])}}` : base;
    }
    if (name === 'overbrace' && args.length >= 1) {
      const base = `\\overbrace{${this.emitNode(args[0])}}`;
      return args.length > 1 ? `${base}^{${this.emitNode(args[1])}}` : base;
    }
    if (name === 'underbracket' && args.length >= 1) {
      const base = `\\underbracket{${this.emitNode(args[0])}}`;
      return args.length > 1 ? `${base}_{${this.emitNode(args[1])}}` : base;
    }
    if (name === 'overbracket' && args.length >= 1) {
      const base = `\\overbracket{${this.emitNode(args[0])}}`;
      return args.length > 1 ? `${base}^{${this.emitNode(args[1])}}` : base;
    }

    // Cancellations
    if (name === 'cancel' && args.length >= 1) {
      if (namedArgs.cross) return `\\xcancel{${this.emitNode(args[0])}}`;
      if (namedArgs.inverted) return `\\bcancel{${this.emitNode(args[0])}}`;
      return `\\cancel{${this.emitNode(args[0])}}`;
    }

    // Binomial
    if (name === 'binom' && args.length === 2) {
      return `\\binom{${this.emitNode(args[0])}}{${this.emitNode(args[1])}}`;
    }

    if (name === 'acute.double' && args.length >= 1) {
      // No KaTeX equivalent for the double-acute accent: refuse rather than
      // store a wrong glyph (`\ddot` would render ¨ instead of ˝).
      throw new Error('acute.double is not supported in LaTeX export');
    }
    if (name === 'harpoon' && args.length >= 1) {
      return `\\overrightharpoon{${this.emitNode(args[0])}}`;
    }
    if (name === 'harpoon.lt' && args.length >= 1) {
      return `\\overleftharpoon{${this.emitNode(args[0])}}`;
    }
    if (name === 'attach' && args.length >= 1) {
      const base = this.emitNode(args[0]);
      let pre = '';
      const tl = namedArgs.tl ? this.emitNode(namedArgs.tl) : '';
      const bl = namedArgs.bl ? this.emitNode(namedArgs.bl) : '';
      if (tl || bl) {
        pre = `{}` + (tl ? `^{${tl}}` : '') + (bl ? `_{${bl}}` : '');
      }
      const top = namedArgs.t
        ? this.emitNode(namedArgs.t)
        : namedArgs.tr
          ? this.emitNode(namedArgs.tr)
          : '';
      const bot = namedArgs.b
        ? this.emitNode(namedArgs.b)
        : namedArgs.br
          ? this.emitNode(namedArgs.br)
          : '';
      let post = '';
      if (bot) post += `_{${bot}}`;
      if (top) post += `^{${top}}`;
      return `${pre}${base}${post}`;
    }

    // Delimiter functions
    if (name === 'abs' && args.length === 1) {
      return `\\left|${this.emitNode(args[0])}\\right|`;
    }
    if (name === 'norm' && args.length === 1) {
      return `\\left\\|${this.emitNode(args[0])}\\right\\|`;
    }
    if (name === 'floor' && args.length === 1) {
      return `\\left\\lfloor ${this.emitNode(args[0])} \\right\\rfloor`;
    }
    if (name === 'ceil' && args.length === 1) {
      return `\\left\\lceil ${this.emitNode(args[0])} \\right\\rceil`;
    }
    if (name === 'round' && args.length === 1) {
      return `\\left\\lfloor ${this.emitNode(args[0])} \\right\\rceil`;
    }
    if (name === 'lr' && args.length >= 1) {
      // `lr` only sizes its body; extra args join with commas per LrElem.
      if (args.length === 1) return this.emitNode(args[0]);
      return args.map((a) => this.emitNode(a)).join(', ');
    }

    // Style/class wrappers with no KaTeX counterpart keep their body so the
    // math survives; the wrapper itself cannot be expressed. `class` takes
    // its body last, so only the body is kept.
    if (name === 'class' && args.length >= 1) {
      return this.emitNode(args[args.length - 1]);
    }
    if ((name === 'stretch' || name === 'scripts' || name === 'limits') && args.length >= 1) {
      return args.map((a) => this.emitNode(a)).join(', ');
    }

    // `op("name", ...)` declares a custom operator: render the name.
    if (name === 'op' && args.length >= 1) {
      const first = args[0];
      const opName = first.type === 'string' ? first.value : this.emitNode(first);
      return `\\operatorname{${opName}}`;
    }

    // `hide(x)` keeps layout space with invisible ink (`\phantom`).
    if (name === 'hide' && args.length >= 1) {
      return `\\phantom{${this.emitNode(args[0])}}`;
    }

    // Parenthesized modular congruence: `mod(m)` renders `(mod m)`. Bare
    // `mod` stays a binary symbol via the symbol table (`\bmod`).
    if (name === 'mod' && args.length === 1) {
      return `\\pmod{${this.emitNode(args[0])}}`;
    }

    // `diaer` is the diaeresis alias of `dot.double` (¨). The `ddot` branch
    // above already covers `ddot`/`dot.double`.
    if (name === 'diaer' && args.length >= 1) {
      return `\\ddot{${this.emitNode(args[0])}}`;
    }
    if (name === 'arrow.l' && args.length >= 1) {
      return `\\overleftarrow{${this.emitNode(args[0])}}`;
    }
    // `arrow.r` is the → symbol, not an accent: `arrow.r(x)` must render as
    // →(x), so only bare `arrow`/`vec` take the accent path here.
    if ((name === 'arrow' || name === 'vec') && args.length >= 1) {
      return `\\vec{${this.emitNode(args[0])}}`;
    }
    if ((name === 'rect' || name === 'box') && args.length >= 1) {
      return `\\boxed{${this.emitNode(args[0])}}`;
    }
    if (name === 'display' && args.length >= 1) {
      return `{\\displaystyle ${this.emitNode(args[0])}}`;
    }
    if (name === 'inline' && args.length >= 1) {
      return `{\\textstyle ${this.emitNode(args[0])}}`;
    }
    if (name === 'script' && args.length >= 1) {
      return `{\\scriptstyle ${this.emitNode(args[0])}}`;
    }
    if (name === 'sscript' && args.length >= 1) {
      return `{\\scriptscriptstyle ${this.emitNode(args[0])}}`;
    }
    if (name === 'sqrt' && args.length >= 1) {
      return `\\sqrt{${this.emitNode(args[0])}}`;
    }
    if (name === 'root' && args.length >= 2) {
      return `\\sqrt[${this.emitNode(args[0])}]{${this.emitNode(args[1])}}`;
    }

    if (
      (name === 'chevron.l' ||
        name === 'chevron' ||
        name === 'angle.l' ||
        name === 'chevron.r' ||
        name === 'angle.r') &&
      args.length >= 1
    ) {
      const renderedArgs = args.map((a) => this.emitNode(a)).join(', ');
      return `\\left\\langle ${renderedArgs}\\right\\rangle`;
    }

    if (name === 'mid') {
      if (args.length >= 1) {
        return `\\middle ${this.emitNode(args[0])}`;
      }
      return '\\mid';
    }

    const renderedArgs = args.map((a) => this.emitNode(a)).join(', ');

    // Built-in KaTeX math functions (sin, cos, ln, etc.)
    const knownLatex = TYPST_TO_LATEX_SYMBOLS[name];
    if (knownLatex) {
      return `${knownLatex}\\left(${renderedArgs}\\right)`;
    }

    // Fallback: function call
    if (name.length > 1 && /^[a-zA-Z]+$/.test(name)) {
      return `\\operatorname{${name}}\\left(${renderedArgs}\\right)`;
    }
    return `${name}\\left(${renderedArgs}\\right)`;
  }

  private emitSequence(elements: MathNode[]): string {
    let result = '';

    for (let i = 0; i < elements.length; i++) {
      const current = elements[i];
      const currentStr = this.emitNode(current);

      if (i === 0) {
        result = currentStr;
        continue;
      }

      // Check if space is needed between previous token and current token
      const prev = elements[i - 1];
      const needsSpace = shouldInsertSpace(prev, current, result, currentStr);

      if (needsSpace) {
        result += ' ';
      }
      result += currentStr;
    }

    return result;
  }
}

function shouldInsertSpace(
  _prevNode: MathNode,
  _currNode: MathNode,
  prevLatex: string,
  currLatex: string,
): boolean {
  if (!prevLatex || !currLatex) return false;

  // Do not insert space before primes e.g. a' or c'
  if (/^'+$/.test(currLatex)) return false;

  // If previous output ends with a LaTeX macro name (e.g. \alpha, \sum) and current starts with a letter
  if (/\\[a-zA-Z]+$/.test(prevLatex) && /^[a-zA-Z]/.test(currLatex)) {
    return true;
  }

  // Do not insert space between prime and opening delimiter e.g. f'(x) or f'''(x)
  if (prevLatex.endsWith("'") && currLatex.startsWith('\\left(')) {
    return false;
  }

  // Punctuation like comma or semicolon already handles its own following spacing in LaTeX math,
  // but if preceding was comma, a space is nice
  if (prevLatex.endsWith(',')) {
    return true;
  }

  // If either side is an operator or relation or text or number/ident sequence
  return true;
}

function assertCallArity(name: string, count: number): void {
  const exactlyOne = new Set([
    'bold',
    'upright',
    'mathrm',
    'serif',
    'italic',
    'sans',
    'cal',
    'scr',
    'frak',
    'mono',
    'bb',
    'hat',
    'tilde',
    'bar',
    'macron',
    'dash',
    'grave',
    'acute',
    'dot',
    'ddot',
    'dot.double',
    'diaer',
    'dddot',
    'dot.triple',
    'ddddot',
    'dot.quad',
    'breve',
    'check',
    'caron',
    'arrow',
    'vec',
    'arrow.l',
    'circle',
    'ring',
    'underline',
    'overline',
    'cancel',
    'abs',
    'norm',
    'floor',
    'ceil',
    'round',
    'display',
    'inline',
    'script',
    'sscript',
    'rect',
    'box',
    'sqrt',
    'harpoon',
    'harpoon.lt',
    'hide',
    'mod',
  ]);
  if (exactlyOne.has(name) && count !== 1) {
    throw new Error(`'${name}' takes exactly one argument (got ${count})`);
  }
  if (name === 'binom' && count !== 2) {
    throw new Error(`'binom' takes exactly two arguments (got ${count})`);
  }
  const oneOrTwo = new Set(['root', 'underbrace', 'overbrace', 'underbracket', 'overbracket']);
  if (oneOrTwo.has(name) && (count < 1 || count > 2)) {
    throw new Error(`'${name}' takes one or two arguments (got ${count})`);
  }
}

function getMatrixEnv(delim?: string): string {
  if (delim === '[') return 'bmatrix';
  if (delim === '{') return 'Bmatrix';
  if (delim === '|') return 'vmatrix';
  if (delim === '||') return 'Vmatrix';
  if (delim === '' || delim === 'none') return 'matrix';
  return 'pmatrix';
}

function escapeLatexText(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([%&#$_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function canonicalizeMatrixDelimiters(output: string): string {
  return output.replace(
    /\\left\(\s*\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}\s*\\right\)/g,
    '\\begin{pmatrix}$1\\end{pmatrix}',
  );
}

function canonicalizeLatexFontWrappers(output: string): string {
  const rules = [
    [/\\mathrm\{\\mathbf\{([^{}]+)\}\}/g, '\\mathbf{$1}'],
    [/\\mathrm\{\\mathit\{([^{}]+)\}\}/g, '\\mathit{$1}'],
    [/\\mathrm\{\\mathrm\{([^{}]+)\}\}/g, '\\mathrm{$1}'],
    [/\\mathbf\{\\mathrm\{([^{}]+)\}\}/g, '\\mathbf{$1}'],
    [/\\mathit\{\\mathrm\{([^{}]+)\}\}/g, '\\mathit{$1}'],
  ] as const;

  let current = output;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pattern, replacement] of rules) {
      const next = current.replace(pattern, replacement);
      if (next !== current) {
        current = next;
        changed = true;
      }
    }
  }
  return current;
}
