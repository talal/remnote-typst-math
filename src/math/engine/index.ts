import { tokenize } from './lexer';
import { MathParser } from './parser';
import { MathEmitter } from './emitter';
import { LatexDecompiler } from './decompiler';

export type DetectedFormat = 'latex' | 'typst' | 'unknown';

export function typstToLatex(source: string, blockMathMode = false): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return '';
  }

  const tokens = tokenize(trimmed);
  const parser = new MathParser(tokens);
  const ast = parser.parse();
  const emitter = new MathEmitter({ blockMathMode });
  return emitter.emit(ast);
}

export function latexToTypst(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return '';
  }

  // Strip display/inline math fences before parsing: `$`/`$$` are rejected
  // inside math (see decompiler), so `$$\frac{a}{b}$$` must unwrap first.
  let fenced = trimmed;
  for (let pass = 0; pass < 3; pass += 1) {
    if (fenced.length >= 2 && fenced.startsWith('$') && fenced.endsWith('$')) {
      fenced = fenced.slice(1, -1).trim();
    } else {
      break;
    }
    if (!fenced) return '';
  }

  const decompiler = new LatexDecompiler(fenced);
  return decompiler.decompile();
}

export function detectFormat(source: string): DetectedFormat {
  const clean = source.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!clean) {
    return 'unknown';
  }

  let latexScore = 0;
  let typstScore = 0;

  // Strong LaTeX indicators
  if (clean.includes('\\documentclass')) latexScore += 10;
  if (clean.includes('\\begin{')) latexScore += 10;
  if (clean.includes('\\section')) latexScore += 5;

  // LaTeX commands like \frac, \alpha, \sqrt, \left, \right
  const latexCommands = clean.match(/\\[a-zA-Z]+/g) || [];
  latexScore += latexCommands.length * 3;

  if (clean.includes('\\\\')) latexScore += 2;
  if (clean.includes('\\{') || clean.includes('\\}')) latexScore += 2;
  if (/[\^_]\{/.test(clean)) latexScore += 2;

  // Strong Typst indicators (markup / script)
  if (clean.includes('#set')) typstScore += 10;
  if (clean.includes('#show')) typstScore += 10;
  if (clean.includes('#import')) typstScore += 8;
  if (clean.startsWith('=')) typstScore += 5;
  if (clean.includes('\n= ')) typstScore += 5;

  // Typst math constructs
  if (/\b(mat|vec|cases|abs|floor|ceil|norm|binom)\s*\(/.test(clean)) typstScore += 5;
  if (clean.includes('[|') || clean.includes('|]')) typstScore += 5;
  if (/#(none|true|false)\b/.test(clean)) typstScore += 5;
  if (/\b(arrow|dots|space|integral)\.[a-z]+/.test(clean)) typstScore += 5;
  if (/==>|<==>|<->|-->|<--|<==|\|->|~>|<~|:=|::=|=:/.test(clean)) typstScore += 4;
  if (/\b(NN|ZZ|QQ|RR|CC|PP|EE|HH)\b/.test(clean)) typstScore += 3;
  // Typst alignment (`x &= 1`) and single-backslash linebreaks: LaTeX
  // alignment bodies almost always arrive with `\begin{…}`, so a bare `&=`
  // with linebreaks leans Typst. The linebreak pattern excludes `\\` and
  // command backslashes (`\frac`, `\{`).
  if (/&\s*=/.test(clean)) typstScore += 4;
  if (/[^\\]\\(?![\\a-zA-Z{])/.test(clean)) typstScore += 3;

  // If both scores are 0, it is ambiguous / unknown
  if (latexScore === 0 && typstScore === 0) {
    return 'unknown';
  }

  if (latexScore >= typstScore + 2) {
    return 'latex';
  }
  if (typstScore >= latexScore + 2) {
    return 'typst';
  }
  if (latexScore > typstScore) {
    return 'latex';
  }
  if (typstScore > latexScore) {
    return 'typst';
  }

  return 'unknown';
}
