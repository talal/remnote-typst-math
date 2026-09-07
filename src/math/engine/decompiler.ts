import { LATEX_TO_TYPST_SYMBOLS } from './symbols';

export class LatexDecompiler {
  private input: string;
  private cursor = 0;

  constructor(input: string) {
    this.input = input.trim();
  }

  decompile(): string {
    return this.parseExpressionSequence();
  }

  private peek(): string {
    return this.input[this.cursor] ?? '';
  }

  private advance(): string {
    const ch = this.peek();
    if (ch) this.cursor++;
    return ch;
  }

  private skipWhitespace(): void {
    while (this.cursor < this.input.length) {
      const ch = this.input[this.cursor];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.cursor++;
        continue;
      }
      // LaTeX comment % ...
      if (ch === '%') {
        const newline = this.input.indexOf('\n', this.cursor);
        this.cursor = newline === -1 ? this.input.length : newline + 1;
        continue;
      }
      break;
    }
  }

  private parseExpressionSequence(stopAt?: (token: string) => boolean): string {
    const parts: Array<{ text: string; hasLeadingSpace: boolean }> = [];

    while (this.cursor < this.input.length) {
      const hadSpace = /\s/.test(this.input[this.cursor] || '');
      this.skipWhitespace();
      if (this.cursor >= this.input.length) break;

      if (stopAt && stopAt(this.peek())) {
        break;
      }

      const item = this.parseAtom();
      if (item === null) break;
      if (item.length > 0) {
        parts.push({ text: item, hasLeadingSpace: hadSpace && parts.length > 0 });
      }
    }

    return joinTypstTokens(parts);
  }

  private parseAtom(includeScripts = true): string | null {
    this.skipWhitespace();
    if (this.cursor >= this.input.length) return null;

    const wrap = (val: string) => (includeScripts ? this.handlePostScripts(val) : val);
    const ch = this.peek();

    // 1. Environments: \begin{...}
    if (this.input.startsWith('\\begin{', this.cursor)) {
      return this.parseEnvironment();
    }

    // 2. Delimiters: \left ... \right (ensure word boundary so \leftarrow isn't hijacked)
    if (
      this.input.startsWith('\\left', this.cursor) &&
      !/[a-zA-Z]/.test(this.input[this.cursor + 5] || '')
    ) {
      return this.parseLeftRight();
    }

    // 3. LaTeX commands (\foo)
    if (ch === '\\') {
      return this.parseCommand(includeScripts);
    }

    // 4. Groups { ... }
    if (ch === '{') {
      this.advance(); // eat '{'
      const inner = this.parseExpressionSequence((t) => t === '}');
      if (this.peek() === '}') this.advance();
      return wrap(inner);
    }

    // 5. Parentheses and Brackets
    if (ch === '(' || ch === '[' || ch === ')' || ch === ']') {
      this.advance();
      return wrap(ch);
    }

    // 6. Subscripts, superscripts, and primes on standalone atoms
    if (ch === '_' || ch === '^' || ch === "'") {
      this.advance();
      const scriptBody = this.parseScriptTarget();
      if (ch === '^' && (scriptBody === 'circ' || scriptBody === '\\circ')) {
        return 'degree';
      }
      return ch === "'" ? "'" : `${ch}(${scriptBody})`;
    }

    // 7. Numbers (including multi-digit and decimal)
    const numMatch = this.input.slice(this.cursor).match(/^\d+(?:\.\d+)?/);
    if (numMatch) {
      this.cursor += numMatch[0].length;
      return wrap(numMatch[0]);
    }

    // 8. Tilde non-breaking space
    if (ch === '~') {
      this.advance();
      return 'space.nobreak';
    }

    // 9. Slash operator: in Typst, / is fraction, so literal / in LaTeX is escaped \/
    if (ch === '/') {
      this.advance();
      return wrap('\\/');
    }

    // 10. Single character token / identifier / unicode symbol. `$` (math
    // shift) and bare `#` (macro parameter) are invalid inside math: refuse
    // so they pre-fill verbatim instead of storing unparseable LaTeX.
    if (ch === '$' || ch === '#') {
      throw new Error(`Unsupported character '${ch}' in math`);
    }
    this.advance();
    const typstSym = LATEX_TO_TYPST_SYMBOLS[ch];
    if (typstSym) {
      return wrap(typstSym);
    }
    return wrap(ch);
  }

  private parseCommand(includeScripts = true): string {
    this.advance(); // consume '\'
    const wrap = (val: string) => (includeScripts ? this.handlePostScripts(val) : val);
    const rest = this.input.slice(this.cursor);

    // 1. Control space `\ `
    if (rest.startsWith(' ')) {
      this.cursor++;
      return 'space';
    }

    // 2. Linebreak `\\`
    if (rest.startsWith('\\')) {
      this.cursor++;
      return '\\\n';
    }

    // 3. Literal braces `\{` and `\}`
    if (rest.startsWith('{')) {
      this.cursor++;
      return '\\{';
    }
    if (rest.startsWith('}')) {
      this.cursor++;
      return '\\}';
    }

    // 4. Alpha command name: e.g. `frac`, `sqrt`, `alpha`
    const match = rest.match(/^[a-zA-Z]+/);
    if (!match) {
      // Non-alpha single char command e.g. `\,`, `\:`, `\;`
      const symbol = rest[0];
      this.cursor++;
      if (symbol === ',') return 'space.thin';
      if (symbol === ':') return 'space.med';
      if (symbol === ';') return 'space.thick';
      if (symbol === '~') return 'space.nobreak';
      if (symbol === '!') return ''; // negative thin space
      return symbol;
    }

    const name = match[0];
    this.cursor += name.length;
    const fullCmd = `\\${name}`;

    // Handle math styles: \displaystyle, \textstyle, \scriptstyle, \scriptscriptstyle
    if (
      name === 'displaystyle' ||
      name === 'textstyle' ||
      name === 'scriptstyle' ||
      name === 'scriptscriptstyle'
    ) {
      const typstFn =
        name === 'displaystyle'
          ? 'display'
          : name === 'textstyle'
            ? 'inline'
            : name === 'scriptstyle'
              ? 'script'
              : 'sscript';
      this.skipWhitespace();
      if (this.peek() === '{') {
        const arg = this.parseBracedArgument();
        return wrap(`${typstFn}(${arg})`);
      }
      const restContent = this.parseExpressionSequence((t) => t === '}' || t === '\\right');
      if (restContent.length > 0) {
        return wrap(`${typstFn}(${restContent})`);
      }
      return wrap(typstFn);
    }

    // Handle negated combinator: \not\approx, \not\in, \not=, etc.
    if (name === 'not') {
      const saved = this.cursor;
      this.skipWhitespace();
      if (this.peek() === '\\') {
        this.advance();
        const cmdMatch = this.input.slice(this.cursor).match(/^[a-zA-Z]+/);
        if (cmdMatch) {
          const nextCmd = cmdMatch[0];
          const combined = `\\not\\${nextCmd}`;
          if (LATEX_TO_TYPST_SYMBOLS[combined]) {
            this.cursor += nextCmd.length;
            return wrap(LATEX_TO_TYPST_SYMBOLS[combined]);
          }
          const single = `\\${nextCmd}`;
          if (LATEX_TO_TYPST_SYMBOLS[single]) {
            this.cursor += nextCmd.length;
            return wrap(`${LATEX_TO_TYPST_SYMBOLS[single]}.not`);
          }
        }
        this.cursor = saved;
      } else if (this.peek() === '=') {
        this.advance();
        return wrap('!=');
      } else {
        this.cursor = saved;
      }
    }

    // Handle foreign KaTeX sizing commands: \big, \Big, \bigg, \Bigg, \bigl, \bigr, etc.
    if (/^[bB]igg?[lrm]?$/.test(name)) {
      this.skipWhitespace();
      const delim = this.parseDelimiter();
      if (delim && delim !== '.') {
        const typstDelim = LATEX_TO_TYPST_SYMBOLS[delim] ?? delim;
        if (name.endsWith('m')) {
          return wrap(`mid(${typstDelim})`);
        }
        return wrap(typstDelim);
      }
      return '';
    }

    // Handle middle delimiter: \middle
    if (name === 'middle') {
      this.skipWhitespace();
      const delim = this.parseDelimiter();
      if (delim && delim !== '.') {
        const typstDelim = LATEX_TO_TYPST_SYMBOLS[delim] ?? delim;
        return wrap(`mid(${typstDelim})`);
      }
      return '';
    }

    // Handle Binomial Coefficients: \binom{n}{k} (+ display variants that
    // normalize to the same Typst call on first edit)
    if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
      const n = this.parseBracedArgument();
      const k = this.parseBracedArgument();
      return wrap(`binom(${n}, ${k})`);
    }

    // Handle Fractions: \frac{numer}{denom}
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      const numer = this.parseBracedArgument();
      const denom = this.parseBracedArgument();

      // Check if immediately followed by script: `\frac{a}{b}^2`
      this.skipWhitespace();
      const nextChar = this.peek();
      if (nextChar === '^' || nextChar === '_') {
        return wrap(`frac(${numer}, ${denom})`);
      }

      // If simple atoms: a / b
      if (/^[a-zA-Z0-9]+$/.test(numer) && /^[a-zA-Z0-9]+$/.test(denom)) {
        return `${numer} / ${denom}`;
      }
      return `(${numer}) / (${denom})`;
    }

    // Handle Roots: \sqrt{radicand} or \sqrt[n]{radicand}
    if (name === 'sqrt') {
      this.skipWhitespace();
      let index: string | undefined;
      if (this.peek() === '[') {
        this.advance();
        index = this.parseExpressionSequence((t) => t === ']');
        if (this.peek() === ']') this.advance();
      }
      const radicand = this.parseBracedArgument();
      if (index) {
        return wrap(`root(${index}, ${radicand})`);
      }
      return wrap(`sqrt(${radicand})`);
    }

    // Handle Text: \text{...}
    if (name === 'text') {
      let textContent = this.parseRawBracedContent();
      if (textContent.startsWith('[') && textContent.endsWith(']') && textContent.length >= 2) {
        textContent = textContent.slice(1, -1);
      }
      return JSON.stringify(textContent);
    }

    if (name === 'mathrel') {
      return this.parseBracedArgument();
    }

    // Handle Font styles
    if (name === 'mathbf' || name === 'textbf') {
      const arg = this.parseBracedArgument();
      if (arg.startsWith('upright(') && arg.endsWith(')')) {
        return wrap(`bold(${arg.slice('upright('.length, -1)})`);
      }
      return wrap(`bold(${arg})`);
    }
    if (name === 'mathrm' || name === 'textrm') {
      const arg = this.parseBracedArgument();
      if (arg.startsWith('bold(') || arg.startsWith('italic(') || arg.startsWith('upright(')) {
        return wrap(arg);
      }
      return wrap(`upright(${arg})`);
    }
    if (name === 'mathit' || name === 'textit') {
      const arg = this.parseBracedArgument();
      if (arg.startsWith('upright(') && arg.endsWith(')')) {
        return wrap(`italic(${arg.slice('upright('.length, -1)})`);
      }
      return wrap(`italic(${arg})`);
    }
    if (name === 'mathsf' || name === 'textsf') {
      const arg = this.parseBracedArgument();
      return wrap(`sans(${arg})`);
    }
    if (name === 'mathcal') {
      const arg = this.parseBracedArgument();
      return wrap(`cal(${arg})`);
    }
    if (name === 'mathscr') {
      const arg = this.parseBracedArgument();
      return wrap(`scr(${arg})`);
    }
    if (name === 'mathfrak') {
      const arg = this.parseBracedArgument();
      return wrap(`frak(${arg})`);
    }
    if (name === 'mathtt' || name === 'texttt') {
      const arg = this.parseBracedArgument();
      return wrap(`mono(${arg})`);
    }
    if (name === 'mathbb') {
      const arg = this.parseBracedArgument();
      const bbSets: Record<string, string> = {
        N: 'NN',
        Z: 'ZZ',
        Q: 'QQ',
        R: 'RR',
        C: 'CC',
        P: 'PP',
        E: 'EE',
        H: 'HH',
      };
      if (bbSets[arg]) return wrap(bbSets[arg]);
      return wrap(`bb(${arg})`);
    }

    // Handle Accents
    const accentMap: Record<string, string> = {
      hat: 'hat',
      widehat: 'hat',
      tilde: 'tilde',
      widetilde: 'tilde',
      bar: 'macron',
      dot: 'dot',
      ddot: 'ddot',
      dddot: 'dddot',
      ddddot: 'dot.quad',
      overrightharpoon: 'harpoon',
      overleftharpoon: 'harpoon.lt',
      vec: 'arrow',
      overrightarrow: 'arrow',
      overleftarrow: 'arrow.l',
      acute: 'acute',
      grave: 'grave',
      breve: 'breve',
      check: 'check',
      mathring: 'circle',
      underline: 'underline',
      overline: 'overline',
      cancel: 'cancel',
    };
    if (accentMap[name]) {
      const arg = this.parseBracedArgument();
      return wrap(`${accentMap[name]}(${arg})`);
    }
    if (name === 'bcancel') {
      const arg = this.parseBracedArgument();
      return wrap(`cancel(${arg}, inverted: true)`);
    }
    if (name === 'xcancel') {
      const arg = this.parseBracedArgument();
      return wrap(`cancel(${arg}, cross: true)`);
    }

    // Handle Over/Under Braces
    if (name === 'underbrace' || name === 'underbracket') {
      const body = this.parseBracedArgument();
      this.skipWhitespace();
      let annot: string | undefined;
      if (this.peek() === '_') {
        this.advance();
        annot = this.parseScriptTarget();
      }
      const fn = name;
      return annot ? `${fn}(${body}, ${annot})` : `${fn}(${body})`;
    }
    if (name === 'overbrace' || name === 'overbracket') {
      const body = this.parseBracedArgument();
      this.skipWhitespace();
      let annot: string | undefined;
      if (this.peek() === '^') {
        this.advance();
        annot = this.parseScriptTarget();
      }
      const fn = name;
      return annot ? `${fn}(${body}, ${annot})` : `${fn}(${body})`;
    }

    // Handle Operatorname (starred form only changes limits placement)
    if (name === 'operatorname') {
      let opName = this.parseRawBracedContent();
      if (this.peek() === '*') this.advance();
      return wrap(opName);
    }

    // Limit placement hints carry no Typst meaning: drop them.
    if (name === 'nolimits' || name === 'limits') {
      return '';
    }

    // Stacked subscript content (`\substack{a \\ b}`) has no direct Typst
    // form: join rows with commas so the content survives as a sequence.
    if (name === 'substack') {
      const raw = this.parseRawBracedContent();
      const rows = raw
        .split('\\\\')
        .map((row) => new LatexDecompiler(row.trim()).decompile())
        .filter((row) => row.length > 0);
      return wrap(rows.join(', '));
    }

    // Explicit horizontal space: keep a quad-sized space; the exact width
    // has no Typst counterpart.
    if (name === 'hspace') {
      if (this.peek() === '*') this.advance();
      this.parseRawBracedContent();
      return 'space.quad';
    }

    // Color/hyperlink commands have no math meaning to preserve: refuse so
    // the editor pre-fills the original LaTeX verbatim instead of garbage.
    if (name === 'color' || name === 'textcolor' || name === 'href') {
      throw new Error(`Unsupported LaTeX command \\${name} in math`);
    }

    // Infix generalized fractions (`{a \atop b}`, `{n \choose k}`,
    // `{a \over b}`) cannot be represented in the sequence parser: refuse so
    // they pre-fill verbatim instead of corrupting on save.
    if (name === 'atop' || name === 'choose' || name === 'over') {
      throw new Error(`Unsupported LaTeX infix \\${name} in math`);
    }

    // Modular congruence: `\pmod{m}` keeps its argument for round-trip with
    // the `mod(m)` emitter branch.
    if (name === 'pmod') {
      const arg = this.parseBracedArgument();
      return wrap(`mod(${arg})`);
    }

    // Phantoms keep layout space: Typst `hide` is the faithful counterpart.
    if (name === 'phantom' || name === 'hphantom' || name === 'vphantom') {
      const arg = this.parseBracedArgument();
      return wrap(`hide(${arg})`);
    }

    // `\smash` only removes height/depth (no Typst counterpart): keep content.
    if (name === 'smash') {
      return wrap(this.parseBracedArgument());
    }

    // Handle Boxed
    if (name === 'boxed') {
      const arg = this.parseBracedArgument();
      return wrap(`rect(${arg})`);
    }

    // Handle Spacing Macros
    if (name === 'quad') return 'space.quad';
    if (name === 'qquad') return 'space.wide';
    if (name === 'medspace') return 'space.med';
    if (name === 'thickspace') return 'space.thick';
    if (name === 'enspace') return 'space.med';
    if (name === 'nobreakspace') return 'space.nobreak';

    // Reverse Symbol Lookup
    const typstSymbol = LATEX_TO_TYPST_SYMBOLS[fullCmd];
    if (typstSymbol) {
      return wrap(typstSymbol);
    }

    // Unknown command: if followed by braces, treat as function call
    this.skipWhitespace();
    if (this.peek() === '{') {
      const arg = this.parseBracedArgument();
      return wrap(`${name}(${arg})`);
    }

    // Unknown command: emit without leading backslash or pass through
    return wrap(name);
  }

  private parseEnvironment(): string {
    // Expect `\begin{env}`
    this.cursor += '\\begin{'.length;
    const envEnd = this.input.indexOf('}', this.cursor);
    if (envEnd === -1) return '';
    const env = this.input.slice(this.cursor, envEnd).trim();
    this.cursor = envEnd + 1;

    const closePattern = `\\end{${env}}`;
    const envClose = this.input.indexOf(closePattern, this.cursor);
    const envBody =
      envClose === -1 ? this.input.slice(this.cursor) : this.input.slice(this.cursor, envClose);
    this.cursor = envClose === -1 ? this.input.length : envClose + closePattern.length;

    // Aligned environment: unwrap and keep '&' and '\'. Display variants and
    // single-equation wrappers normalize to the same Typst alignment.
    if (
      env === 'aligned' ||
      env === 'align' ||
      env === 'align*' ||
      env === 'alignedat' ||
      env === 'alignat' ||
      env === 'alignat*' ||
      env === 'gather' ||
      env === 'gather*' ||
      env === 'split' ||
      env === 'subarray'
    ) {
      const decompiler = new LatexDecompiler(envBody);
      return decompiler.decompile();
    }

    // Array is a delimiterless matrix with a column spec Typst cannot
    // express: strip the `{cc}` spec, keep the cells, drop the alignment.
    if (env === 'array' || env === 'array*') {
      const body = envBody.replace(/^\s*\{[^}]*\}/, '');
      return this.decompileMatrix('matrix', body);
    }

    // Small matrices and brace-side cases variants normalize to mat/cases.
    if (env === 'smallmatrix' || env === 'matrix*') {
      return this.decompileMatrix('matrix', envBody);
    }
    if (env === 'dcases' || env === 'rcases' || env === 'drcases' || env === 'cases*') {
      return this.decompileCases(envBody);
    }

    // Matrix environments
    if (
      env === 'pmatrix' ||
      env === 'bmatrix' ||
      env === 'Bmatrix' ||
      env === 'vmatrix' ||
      env === 'Vmatrix' ||
      env === 'matrix'
    ) {
      return this.decompileMatrix(env, envBody);
    }

    // Cases environment
    if (env === 'cases') {
      return this.decompileCases(envBody);
    }

    // Anything else (CD, eqnarray, custom envs) has no faithful mapping:
    // refuse so the editor pre-fills the original LaTeX verbatim.
    throw new Error(`Unsupported LaTeX environment \\begin{${env}} in math`);
  }

  private decompileMatrix(env: string, body: string): string {
    const rawRows = body.split('\\\\');
    const rows = rawRows
      .map((r) =>
        r
          .split('&')
          .map((cell) => new LatexDecompiler(cell.trim()).decompile())
          .filter((cell) => cell.length > 0),
      )
      .filter((r) => r.length > 0);

    const isSingleColumn = rows.every((r) => r.length === 1);

    if (env === 'pmatrix' && isSingleColumn && rows.length > 1) {
      const elements = rows.map((r) => r[0]).join(', ');
      return this.handlePostScripts(`vec(${elements})`);
    }

    let delimArg = '';
    if (env === 'bmatrix') delimArg = 'delim: "[", ';
    else if (env === 'Bmatrix') delimArg = 'delim: "{", ';
    else if (env === 'vmatrix') delimArg = 'delim: "|", ';
    else if (env === 'Vmatrix') delimArg = 'delim: "||", ';
    else if (env === 'matrix') delimArg = 'delim: #none, ';

    const content = rows.map((row) => row.join(', ')).join('; ');
    return this.handlePostScripts(`mat(${delimArg}${content})`);
  }

  private decompileCases(body: string): string {
    const rawBranches = body.split('\\\\');
    const branches = rawBranches
      .map((branch) =>
        branch
          .split('&')
          .map((part) => new LatexDecompiler(part.trim()).decompile())
          .filter((part) => part.length > 0)
          .join(' & '),
      )
      .filter((b) => b.length > 0);

    return `cases(${branches.join(', ')})`;
  }

  private parseDelimiter(): string {
    this.skipWhitespace();
    if (this.cursor >= this.input.length) return '';
    let delim = this.peek();
    this.advance();
    if (delim === '\\') {
      const match = this.input.slice(this.cursor).match(/^[a-zA-Z]+/);
      if (match) {
        delim += match[0];
        this.cursor += match[0].length;
      } else if (this.cursor < this.input.length) {
        delim += this.advance();
      }
    }
    return delim;
  }

  private parseLeftRight(): string {
    // `\left(` ... `\right)`
    this.cursor += '\\left'.length;
    const openDelim = this.parseDelimiter();

    // Parse content until `\right`
    const contentParts: string[] = [];
    let closeDelim = '';
    while (this.cursor < this.input.length) {
      this.skipWhitespace();
      if (
        this.input.startsWith('\\right', this.cursor) &&
        !/[a-zA-Z]/.test(this.input[this.cursor + 6] || '')
      ) {
        this.cursor += '\\right'.length;
        closeDelim = this.parseDelimiter();
        break;
      }
      const atom = this.parseAtom();
      if (atom === null) break;
      if (atom.length > 0) {
        contentParts.push(atom);
      }
    }

    const inner = joinTypstTokens(contentParts);

    // Exact mixed pair for `round` first.
    if (openDelim === '\\lfloor' && closeDelim === '\\rceil') {
      return this.handlePostScripts(`round(${inner})`);
    }

    // Invisible opening (`\left.`): recover the closing side. Function-like
    // closers keep their call form; plain parens/brackets append as a suffix
    // so `\left. a \right)` becomes `a )` instead of inventing `(a)`.
    if (openDelim === '.' || openDelim === '') {
      if (!closeDelim || closeDelim === '.') return this.handlePostScripts(inner);
      const closerForm = this.delimitedForm(closeDelim);
      const isFunctionForm =
        closerForm !== undefined &&
        (closeDelim === '\\lfloor' ||
          closeDelim === '\\rfloor' ||
          closeDelim === '\\lceil' ||
          closeDelim === '\\rceil' ||
          closeDelim === '\\llbracket' ||
          closeDelim === '\\rrbracket' ||
          closeDelim === '\\langle' ||
          closeDelim === '\\rangle' ||
          closeDelim === '\\|' ||
          closeDelim === '\\lVert' ||
          closeDelim === '\\rVert' ||
          closeDelim === '|' ||
          closeDelim === '\\lvert' ||
          closeDelim === '\\rvert' ||
          closeDelim === '\\{' ||
          closeDelim === '\\}' ||
          closeDelim === '{' ||
          closeDelim === '}');
      if (isFunctionForm && closerForm) {
        return this.handlePostScripts(closerForm(inner));
      }
      const closeTypst = this.standaloneDelim(closeDelim);
      return this.handlePostScripts(inner ? `${inner} ${closeTypst}` : closeTypst);
    }

    // Open-driven mapping: the opening delimiter decides the Typst form, so
    // half-open intervals like `\left(0, 1\right]` deterministically keep the
    // opening shape instead of depending on branch order.
    const openForm = this.delimitedForm(openDelim);
    if (openForm !== undefined) {
      return this.handlePostScripts(openForm(inner));
    }

    // Unrecognized opening: fall back to the closing delimiter.
    const closeForm = this.delimitedForm(closeDelim);
    if (closeForm !== undefined) {
      return this.handlePostScripts(closeForm(inner));
    }

    if (!closeDelim || closeDelim === '.') {
      const openTypst = this.standaloneDelim(openDelim);
      return this.handlePostScripts(
        openTypst ? (inner ? `${openTypst} ${inner}` : openTypst) : inner,
      );
    }

    return this.handlePostScripts(`(${inner})`);
  }

  /** Map a `\left`/`\right` delimiter to its Typst wrapper, if known. */
  private delimitedForm(delim: string): ((inner: string) => string) | undefined {
    switch (delim) {
      case '\\lfloor':
      case '\\rfloor':
        return (inner) => `floor(${inner})`;
      case '\\lceil':
      case '\\rceil':
        return (inner) => `ceil(${inner})`;
      case '\\llbracket':
      case '\\rrbracket':
        return (inner) => `[|${inner}|]`;
      case '\\langle':
      case '\\rangle':
        return (inner) => `chevron.l(${inner})`;
      case '\\|':
      case '\\lVert':
      case '\\rVert':
        return (inner) => `norm(${inner})`;
      case '|':
      case '\\lvert':
      case '\\rvert':
        return (inner) => `abs(${inner})`;
      case '\\{':
      case '\\}':
      case '{':
      case '}':
        return (inner) => `{ ${inner} }`;
      case '[':
      case ']':
        return (inner) => `[${inner}]`;
      case '(':
      case ')':
        return (inner) => `(${inner})`;
      default:
        return undefined;
    }
  }

  /** Render a lone delimiter with no pair (sibling of `\left.`/empty). */
  private standaloneDelim(delim: string): string {
    switch (delim) {
      case '(':
      case ')':
      case '[':
      case ']':
      case '{':
      case '}':
      case '|':
        return delim;
      case '\\{':
      case '\\}':
        return delim;
      case '\\vert':
      case '\\mvert':
      case '\\lvert':
      case '\\rvert':
        return '|';
      case '\\|':
      case '\\Vert':
      case '\\lVert':
      case '\\rVert':
        return '||';
      default:
        return delim;
    }
  }

  private parseBracedArgument(): string {
    this.skipWhitespace();
    if (this.peek() !== '{') {
      if (this.peek() === '\\') {
        return this.parseCommand(false);
      }
      return this.advance() ?? '';
    }

    this.advance(); // eat '{'
    const content = this.parseExpressionSequence((t) => t === '}');
    if (this.peek() === '}') this.advance();
    return content;
  }

  private parseRawBracedContent(): string {
    this.skipWhitespace();
    if (this.peek() !== '{') return '';
    this.advance();

    let depth = 1;
    let content = '';
    while (this.cursor < this.input.length && depth > 0) {
      const ch = this.advance();
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
      content += ch;
    }
    return content;
  }

  private parseScriptTarget(): string {
    this.skipWhitespace();
    if (this.peek() === '{') {
      return this.parseBracedArgument();
    }
    return this.parseAtom(false) ?? '';
  }

  private handlePostScripts(base: string): string {
    let result = base;

    while (this.cursor < this.input.length) {
      // Scan ahead past whitespace and transparent limit hints (`\nolimits`,
      // `\limits` carry no Typst meaning) without consuming anything yet, so
      // `f (x)` keeps its juxtaposition space when no script follows.
      let temp = this.cursor;
      const skipSpaces = () => {
        while (temp < this.input.length && /\s/.test(this.input[temp])) temp++;
      };
      skipSpaces();
      while (true) {
        let consumed = false;
        for (const cmd of ['\\nolimits', '\\limits']) {
          if (
            this.input.startsWith(cmd, temp) &&
            !/[a-zA-Z]/.test(this.input[temp + cmd.length] || '')
          ) {
            temp += cmd.length;
            skipSpaces();
            consumed = true;
            break;
          }
        }
        if (!consumed) break;
      }
      const nextCh = this.input[temp];

      if (nextCh !== '_' && nextCh !== '^' && nextCh !== "'") {
        break;
      }
      this.cursor = temp;

      const ch = this.peek();

      if (ch === '_') {
        this.advance();
        const sub = this.parseScriptTarget();
        const formattedSub = /^[a-zA-Z0-9]$/.test(sub) ? sub : `(${sub})`;
        result = `${result}_${formattedSub}`;
      } else if (ch === '^') {
        this.advance();
        const sup = this.parseScriptTarget();
        if (sup === 'circ' || sup === '\\circ') {
          result = `${result} degree`;
        } else {
          const formattedSup = /^[a-zA-Z0-9]$/.test(sup) ? sup : `(${sup})`;
          result = `${result}^${formattedSup}`;
        }
      } else if (ch === "'") {
        this.advance();
        result = `${result}'`;
      } else {
        break;
      }
    }

    return result;
  }
}

interface DecompiledToken {
  text: string;
  hasLeadingSpace?: boolean;
}

function joinTypstTokens(tokens: Array<string | DecompiledToken>): string {
  let result = '';

  for (let i = 0; i < tokens.length; i++) {
    const rawTok = tokens[i];
    const tok = typeof rawTok === 'string' ? rawTok : rawTok.text;
    const hasLeadingSpace = typeof rawTok === 'string' ? true : (rawTok.hasLeadingSpace ?? true);

    if (i === 0) {
      result = tok;
      continue;
    }

    const rawPrev = tokens[i - 1];
    const prev = typeof rawPrev === 'string' ? rawPrev : rawPrev.text;

    // Skip extra space if previous is opening delimiter or next is closing delimiter
    if (prev === '(' || prev === '[' || prev === '{' || prev === '[|') {
      result += tok;
    } else if (tok === ')' || tok === ']' || tok === '}' || tok === '|]' || tok === ',') {
      result += tok;
    } else if (tok === '%' && /^[0-9.]+$/.test(prev) && !hasLeadingSpace) {
      result += tok;
    } else if (tok.startsWith('(') && /^[a-zA-Z_.]+$/.test(prev) && !hasLeadingSpace) {
      result += tok;
    } else {
      result += ` ${tok}`;
    }
  }

  return result;
}
