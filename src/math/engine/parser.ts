import type { MathNode, Token } from './types';
import { TYPST_TO_LATEX_SYMBOLS } from './symbols';

export enum Precedence {
  Lowest = 0,
  Linebreak = 1,
  Align = 2,
  Relation = 3,
  Add = 4,
  Mul = 5,
  Fraction = 6,
  Prefix = 7,
  Postfix = 8,
  Attach = 9,
  Call = 10,
}

export class MathParser {
  private tokens: Token[];
  private cursor = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.cursor] || { type: 'EOF', value: '', pos: 0 };
  }

  private peekNext(): Token {
    return this.tokens[this.cursor + 1] || { type: 'EOF', value: '', pos: 0 };
  }

  private advance(): Token {
    const tok = this.peek();
    if (tok.type !== 'EOF') this.cursor++;
    return tok;
  }

  private match(type: string, value?: string): boolean {
    const tok = this.peek();
    if (tok.type === type && (value === undefined || tok.value === value)) {
      this.cursor++;
      return true;
    }
    return false;
  }

  private expect(type: string, value?: string): Token {
    const tok = this.peek();
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new Error(`Expected ${value ?? type} but got ${tok.value || tok.type}`);
    }
    return this.advance();
  }

  parse(): MathNode {
    const elements: MathNode[] = [];
    while (this.peek().type !== 'EOF') {
      elements.push(this.parseExpression(Precedence.Lowest));
    }
    if (elements.length === 0) return { type: 'ident', name: '' };
    if (elements.length === 1) return elements[0];
    return { type: 'sequence', elements };
  }

  parseExpression(precedence: Precedence): MathNode {
    let left = this.parsePrefix();

    while (true) {
      // 1. Infix attachment: ^, _, '
      const next = this.peek();
      if (next.type === 'SCRIPT' || next.type === 'PRIME') {
        if (Precedence.Attach < precedence) break;
        left = this.parseAttach(left);
        continue;
      }

      // 1.5. Postfix operators: ! (factorial)
      if (next.type === 'OP' && next.value === '!') {
        if (Precedence.Postfix <= precedence) break;
        this.advance(); // consume '!'
        left = { type: 'postfix', op: '!', argument: left };
        continue;
      }

      // 2. Infix fraction: /
      if (next.type === 'SLASH') {
        if (Precedence.Fraction <= precedence) break;
        this.advance(); // consume '/'
        let right = this.parseExpression(Precedence.Fraction);
        // Typst math_unparen: unwrap outer parentheses for fraction operands
        left = this.unparen(left);
        right = this.unparen(right);
        left = { type: 'fraction', numer: left, denom: right };
        continue;
      }

      // 3. Binary operators
      const opPrec = this.getBinaryPrecedence(next);
      if (opPrec !== undefined && opPrec > precedence) {
        const opToken = this.advance();
        const right = this.parseExpression(opPrec);
        left = { type: 'binary', op: opToken.value, left, right };
        continue;
      }

      // 4. Juxtaposition (implicit product / sequence of atoms): e.g. `2 x` or `x y`
      if (this.canStartExpression(next)) {
        if (Precedence.Mul <= precedence) break;
        const right = this.parseExpression(Precedence.Mul);
        left = this.combineSequence(left, right);
        continue;
      }

      break;
    }

    return left;
  }

  private parsePrefix(): MathNode {
    const tok = this.peek();

    // Linebreak: \
    if (tok.type === 'LINEBREAK') {
      this.advance();
      return { type: 'linebreak' };
    }

    // Align point: &
    if (tok.type === 'ALIGN') {
      this.advance();
      return { type: 'align' };
    }

    // Radicals: √, ∛, ∜
    if (tok.type === 'ROOT') {
      this.advance();
      const index =
        tok.value === '√'
          ? undefined
          : tok.value === '∛'
            ? { type: 'number' as const, value: '3' }
            : { type: 'number' as const, value: '4' };
      const radicand = this.parseExpression(Precedence.Prefix);
      return { type: 'root', index, radicand };
    }

    // Prefix unary operators: -, +, +-
    if (tok.type === 'OP' && (tok.value === '-' || tok.value === '+')) {
      this.advance();
      const argument = this.parseExpression(Precedence.Prefix);
      return { type: 'unary', op: tok.value, argument };
    }

    // Numbers
    if (tok.type === 'NUMBER') {
      this.advance();
      return { type: 'number', value: tok.value };
    }

    // Strings
    if (tok.type === 'STRING') {
      this.advance();
      return { type: 'string', value: tok.value };
    }

    // Shorthands like !=, <=, >=, :=, ->
    if (tok.type === 'SHORTHAND') {
      this.advance();
      const latex = TYPST_TO_LATEX_SYMBOLS[tok.value] ?? tok.value;
      return { type: 'symbol', name: tok.value, latex };
    }

    // Identifiers or Function calls
    if (tok.type === 'IDENT') {
      const identToken = this.advance();
      const name = identToken.value;

      // Lookahead for function call: `name(...)`
      const hasTrivia = this.peek().pos > identToken.pos + identToken.value.length;
      if (!hasTrivia && this.peek().type === 'DELIM' && this.peek().value === '(') {
        return this.parseFunctionCall(name);
      }

      // Standalone symbol or variable
      const latex = TYPST_TO_LATEX_SYMBOLS[name];
      if (latex) {
        return { type: 'symbol', name, latex };
      }
      return { type: 'ident', name };
    }

    // Delimited: ( ... ), [ ... ], { ... }
    if (tok.type === 'DELIM') {
      const open = tok.value;
      if (open === '(' || open === '[' || open === '{' || open === '[|') {
        return this.parseDelimited(open);
      }
      // Stray closing delimiter or unrecognized delimiter
      this.advance();
      const latex = TYPST_TO_LATEX_SYMBOLS[open] ?? open;
      return { type: 'symbol', name: open, latex };
    }

    // Fallback for symbols/operators like |, +, -, etc.
    if (tok.type === 'OP' || tok.type === 'COLON') {
      this.advance();
      // `$` (equation delimiter) and bare `#` (code marker) are not valid
      // inside math: refuse loudly instead of storing KaTeX-unparseable text.
      if (tok.value === '$' || tok.value === '#') {
        throw new Error(`Unsupported character '${tok.value}' in math`);
      }
      const latex = TYPST_TO_LATEX_SYMBOLS[tok.value] ?? tok.value;
      return { type: 'symbol', name: tok.value, latex };
    }

    this.advance();
    return { type: 'ident', name: tok.value };
  }

  private parseFunctionCall(name: string): MathNode {
    this.expect('DELIM', '(');

    // Special constructors: mat, vec, cases
    if (name === 'mat') {
      return this.parseMatrix();
    }
    if (name === 'vec') {
      return this.parseVector();
    }
    if (name === 'cases') {
      return this.parseCases();
    }

    // Standard argument list
    const args: MathNode[] = [];
    const namedArgs: Record<string, MathNode> = {};

    // Styling keys carry no math meaning (dimensions, colors, layout): skip
    // their values instead of interpreting them, so `cancel(x, length: #200%)`
    // never throws on unit syntax the expression parser cannot model.
    const STYLING_ARG_KEYS = new Set([
      'length',
      'size',
      'gap',
      'row-gap',
      'column-gap',
      'col-gap',
      'align',
      'augment',
      'reverse',
      'inset',
      'outset',
      'stroke',
      'fill',
      'font',
      'weight',
      'style',
      'radius',
      'width',
      'height',
      'depth',
      'shift',
      'rise',
      'scale',
      'angle',
    ]);

    while (this.peek().type !== 'DELIM' || this.peek().value !== ')') {
      if (this.peek().type === 'EOF') break;

      // Handle leading comma or empty argument e.g. root(, 3)
      if (this.match('COMMA')) {
        args.push({ type: 'ident', name: '' });
        continue;
      }

      // Check for named argument: `key: value` (keys may be hyphenated)
      const namedKey = this.tryParseNamedKey();
      if (namedKey !== undefined) {
        this.advance(); // consume ':'
        if (STYLING_ARG_KEYS.has(namedKey)) {
          this.skipNamedValue();
        } else {
          const val = this.parseExpression(Precedence.Lowest);
          namedArgs[namedKey] = val;
        }
      } else {
        args.push(this.parseExpression(Precedence.Lowest));
      }

      if (this.match('COMMA') || this.match('SEMICOLON')) {
        continue;
      }
      break;
    }

    this.expect('DELIM', ')');

    // Canonicalize built-ins:
    if (name === 'frac' && args.length === 2) {
      return { type: 'fraction', numer: args[0], denom: args[1] };
    }
    // Named forms: `frac(num: a, denom: b)`, `binom(upper: n, lower: k)`,
    // `root(index: i, radicand: x)` are all valid Typst.
    if (
      name === 'frac' &&
      args.length === 0 &&
      namedArgs.num !== undefined &&
      namedArgs.denom !== undefined
    ) {
      return { type: 'fraction', numer: namedArgs.num, denom: namedArgs.denom };
    }
    if (
      name === 'binom' &&
      args.length === 0 &&
      namedArgs.upper !== undefined &&
      namedArgs.lower !== undefined
    ) {
      return { type: 'call', name, args: [namedArgs.upper, namedArgs.lower], namedArgs: {} };
    }
    if (name === 'root' && args.length === 0 && namedArgs.radicand !== undefined) {
      return { type: 'root', index: namedArgs.index, radicand: namedArgs.radicand };
    }
    if (name === 'sqrt' && args.length === 1) {
      return { type: 'root', radicand: args[0] };
    }
    if (name === 'root') {
      if (args.length === 1) {
        return { type: 'root', radicand: args[0] };
      }
      if (args.length === 2) {
        const isEmpty = args[0].type === 'ident' && args[0].name === '';
        return {
          type: 'root',
          index: isEmpty ? undefined : args[0],
          radicand: args[1],
        };
      }
    }
    if (name === 'abs' && args.length === 1) {
      return { type: 'delimited', open: '|', close: '|', body: args[0] };
    }
    if (name === 'norm' && args.length === 1) {
      return { type: 'delimited', open: '||', close: '||', body: args[0] };
    }

    return { type: 'call', name, args, namedArgs };
  }

  /**
   * Consume a named-argument key when followed by `:`, joining hyphenated
   * segments (`row-gap`) which lex as IDENT OP('-') IDENT. Rewinds when the
   * tokens are not a `key:` pair so subtraction like `a-b` is unaffected.
   */
  private tryParseNamedKey(): string | undefined {
    const start = this.cursor;
    if (this.peek().type !== 'IDENT') return undefined;
    let key = this.advance().value;
    while (
      this.peek().type === 'OP' &&
      this.peek().value === '-' &&
      this.tokens[this.cursor + 1]?.type === 'IDENT'
    ) {
      this.advance(); // '-'
      key += `-${this.advance().value}`;
    }
    if (this.peek().type === 'COLON') return key;
    this.cursor = start;
    return undefined;
  }

  /**
   * Skip an ignored styling value (dimensions like `1em`, `#200%`) without
   * interpreting it: balanced scan until `,`, `;`, linebreak, or `)` at
   * depth 0, so exotic units never throw.
   */
  private skipNamedValue(): void {
    let depth = 0;
    while (true) {
      const tok = this.peek();
      if (tok.type === 'EOF') return;
      if (tok.type === 'DELIM') {
        if (tok.value === '(' || tok.value === '[' || tok.value === '{') {
          depth++;
        } else if (tok.value === ')') {
          if (depth === 0) return;
          depth--;
        } else if (depth > 0) {
          depth--;
        }
      }
      if (
        depth === 0 &&
        (tok.type === 'COMMA' || tok.type === 'SEMICOLON' || tok.type === 'LINEBREAK')
      ) {
        return;
      }
      this.advance();
    }
  }

  private parseMatrix(): MathNode {
    const rows: MathNode[][] = [];
    let currentRow: MathNode[] = [];
    let delim = '(';

    while (this.peek().type !== 'DELIM' || this.peek().value !== ')') {
      if (this.peek().type === 'EOF') break;

      // Handle named arguments (delim, align, gap, augment, reverse, etc.)
      // Styling values are skipped (KaTeX has no counterpart); only `delim`
      // affects the emitted environment.
      const namedKey = this.tryParseNamedKey();
      if (namedKey !== undefined) {
        this.advance(); // ':'
        if (namedKey === 'delim') {
          let delimToken = this.advance();
          if (delimToken.value === '#' && this.peek().type === 'IDENT') {
            delimToken = this.advance();
          }
          if (delimToken.type === 'STRING') delim = delimToken.value;
          else if (delimToken.value === '[' || delimToken.value === ']') delim = '[';
          else if (delimToken.value === '{' || delimToken.value === '}') delim = '{';
          else if (delimToken.value === '||' || delimToken.value === 'bar.v.double') delim = '||';
          else if (delimToken.value === '|' || delimToken.value === 'bar.v') delim = '|';
          else if (delimToken.value === 'none' || delimToken.value === '#none') delim = '';
        } else {
          this.skipNamedValue();
        }
        if (this.match('COMMA')) continue;
      }

      const cell = this.parseExpression(Precedence.Lowest);
      currentRow.push(cell);

      if (this.match('COMMA') || this.match('ALIGN')) {
        // comma or & separates columns in the current row
        continue;
      } else if (this.match('SEMICOLON') || this.match('LINEBREAK')) {
        // semicolon or linebreak ends the current row
        rows.push(currentRow);
        currentRow = [];
        continue;
      }
      break;
    }

    if (currentRow.length > 0) {
      rows.push(currentRow);
    }

    this.expect('DELIM', ')');
    return { type: 'matrix', rows, delim };
  }

  private parseVector(): MathNode {
    const rows: MathNode[][] = [];
    let delim = '(';

    while (this.peek().type !== 'DELIM' || this.peek().value !== ')') {
      if (this.peek().type === 'EOF') break;

      const vecKey = this.tryParseNamedKey();
      if (vecKey !== undefined) {
        this.advance(); // ':'
        if (vecKey === 'delim') {
          let delimToken = this.advance();
          if (delimToken.value === '#' && this.peek().type === 'IDENT') {
            delimToken = this.advance();
          }
          if (delimToken.type === 'STRING') delim = delimToken.value;
          else if (delimToken.value === '[' || delimToken.value === ']') delim = '[';
          else if (delimToken.value === '{' || delimToken.value === '}') delim = '{';
          else if (delimToken.value === '||' || delimToken.value === 'bar.v.double') delim = '||';
          else if (delimToken.value === '|' || delimToken.value === 'bar.v') delim = '|';
          else if (delimToken.value === 'none' || delimToken.value === '#none') delim = '';
        } else {
          this.skipNamedValue();
        }
        if (this.match('COMMA')) continue;
      }

      const row: MathNode[] = [this.parseExpression(Precedence.Lowest)];
      while (this.match('ALIGN')) {
        row.push(this.parseExpression(Precedence.Lowest));
      }
      rows.push(row);

      if (this.match('COMMA') || this.match('SEMICOLON') || this.match('LINEBREAK')) {
        continue;
      }
      break;
    }

    this.expect('DELIM', ')');
    return { type: 'matrix', rows, delim };
  }

  private parseCases(): MathNode {
    const branches: MathNode[][] = [];

    while (this.peek().type !== 'DELIM' || this.peek().value !== ')') {
      if (this.peek().type === 'EOF') break;

      const casesKey = this.tryParseNamedKey();
      if (casesKey !== undefined) {
        this.advance(); // ':'
        this.skipNamedValue();
        if (this.match('COMMA')) continue;
      }

      const currentBranch: MathNode[] = [];
      const val = this.parseExpression(Precedence.Lowest);
      currentBranch.push(val);

      while (this.peek().type === 'ALIGN') {
        this.advance(); // consume '&'
        const cond = this.parseExpression(Precedence.Lowest);
        currentBranch.push(cond);
      }

      branches.push(currentBranch);

      if (this.match('COMMA') || this.match('SEMICOLON') || this.match('LINEBREAK')) {
        continue;
      }
      break;
    }

    this.expect('DELIM', ')');
    return { type: 'cases', branches };
  }

  private parseDelimited(open: string): MathNode {
    this.advance(); // consume opening delimiter
    const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '|]';

    const elements: MathNode[] = [];
    while (this.peek().type !== 'DELIM' || this.peek().value !== close) {
      if (this.peek().type === 'EOF') break;
      elements.push(this.parseExpression(Precedence.Lowest));
    }

    if (this.peek().type === 'DELIM' && this.peek().value === close) {
      this.advance();
      const body: MathNode =
        elements.length === 0
          ? { type: 'ident', name: '' }
          : elements.length === 1
            ? elements[0]
            : { type: 'sequence', elements };

      return { type: 'delimited', open, close, body };
    }

    // Unclosed delimiter: invalid Typst (and unloadable LaTeX). Refuse
    // instead of emitting a raw opening delimiter: the live preview already
    // swallows conversion errors, and the save path surfaces them.
    throw new Error(`Expected '${close}' but reached end of input`);
  }

  private parseAttach(base: MathNode): MathNode {
    let sub: MathNode | undefined;
    let sup: MathNode | undefined;

    // Chained attachments: `x_1^2` or `x^2_1` or `x'` or `x^a^b`
    while (true) {
      const tok = this.peek();
      if (tok.type === 'SCRIPT' && tok.value === '_') {
        this.advance();
        let target = this.parseExpression(Precedence.Call);
        target = this.unparen(target);
        sub = sub ? nestSub(sub, target) : target;
      } else if (tok.type === 'SCRIPT' && tok.value === '^') {
        this.advance();
        let target = this.parseExpression(Precedence.Call);
        target = this.unparen(target);
        if (sup?.type === 'ident' && /^'+$/.test(sup.name)) {
          base = { type: 'script', base, sub, sup };
          sub = undefined;
          sup = target;
        } else {
          sup = sup ? nestSup(sup, target) : target;
        }
      } else if (tok.type === 'PRIME') {
        this.advance();
        if (sup?.type === 'ident' && /^'+$/.test(sup.name)) {
          sup = { type: 'ident', name: sup.name + tok.value };
        } else {
          const primeNode: MathNode = { type: 'ident', name: tok.value };
          sup = sup ? this.combineSequence(sup, primeNode) : primeNode;
        }
      } else {
        break;
      }
    }

    return { type: 'script', base, sub, sup };
  }

  private unparen(node: MathNode): MathNode {
    if (
      node.type === 'delimited' &&
      ((node.open === '(' && node.close === ')') || (node.open === '{' && node.close === '}'))
    ) {
      return node.body;
    }
    return node;
  }

  private combineSequence(left: MathNode, right: MathNode): MathNode {
    if (left.type === 'sequence') {
      return { type: 'sequence', elements: [...left.elements, right] };
    }
    return { type: 'sequence', elements: [left, right] };
  }

  private canStartExpression(tok: Token): boolean {
    if (tok.type === 'IDENT' || tok.type === 'NUMBER' || tok.type === 'STRING') return true;
    if (tok.type === 'DELIM') {
      return tok.value === '(' || tok.value === '[' || tok.value === '{' || tok.value === '[|';
    }
    return false;
  }

  private getBinaryPrecedence(tok: Token): Precedence | undefined {
    if (tok.type === 'OP') {
      if (tok.value === '+' || tok.value === '-') return Precedence.Add;
      if (tok.value === '*' || tok.value === '=' || tok.value === '<' || tok.value === '>') {
        return tok.value === '*' ? Precedence.Mul : Precedence.Relation;
      }
      if (tok.value === '|' || tok.value === '||' || tok.value === '~') return Precedence.Relation;
    }
    if (tok.type === 'SHORTHAND') {
      if (tok.value === '~') return Precedence.Relation;
      return Precedence.Relation;
    }
    return undefined;
  }
}

function nestSup(current: MathNode, next: MathNode): MathNode {
  if (current.type === 'script' && !current.sub && current.sup) {
    return { ...current, sup: nestSup(current.sup, next) };
  }
  return { type: 'script', base: current, sup: next };
}

function nestSub(current: MathNode, next: MathNode): MathNode {
  if (current.type === 'script' && current.sub && !current.sup) {
    return { ...current, sub: nestSub(current.sub, next) };
  }
  return { type: 'script', base: current, sub: next };
}
