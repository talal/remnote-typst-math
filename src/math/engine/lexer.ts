import type { Token, TokenType } from './types';
import { TYPST_SHORTHANDS } from './symbols';

const SORTED_TYPST_SHORTHANDS = [...TYPST_SHORTHANDS].sort((a, b) => b[0].length - a[0].length);

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    // 1. Skip whitespace
    if (/\s/.test(input[cursor])) {
      cursor++;
      continue;
    }

    // 2. Skip single-line comments // ...
    if (input.startsWith('//', cursor)) {
      const newlineIdx = input.indexOf('\n', cursor + 2);
      cursor = newlineIdx === -1 ? input.length : newlineIdx + 1;
      continue;
    }

    // 3. Skip multi-line comments /* ... */ (unterminated is invalid Typst)
    if (input.startsWith('/*', cursor)) {
      const closeIdx = input.indexOf('*/', cursor + 2);
      if (closeIdx === -1) {
        throw new Error('Unterminated block comment');
      }
      cursor = closeIdx + 2;
      continue;
    }

    const rest = input.slice(cursor);

    // 4. Unicode escape \u{...} (any char escapable in Typst math)
    if (input.startsWith('\\u{', cursor)) {
      const end = input.indexOf('}', cursor + 3);
      if (end !== -1) {
        const hex = input.slice(cursor + 3, end);
        const code = parseInt(hex, 16);
        if (!isNaN(code)) {
          try {
            tokens.push({ type: 'IDENT', value: String.fromCodePoint(code), pos: cursor });
          } catch {
            throw new Error(`Invalid unicode escape \\u{${hex}}`);
          }
          cursor = end + 1;
          continue;
        }
      }
    }

    // 5. Linebreak backslash '\' or escaped characters
    if (input[cursor] === '\\') {
      const nextChar = input[cursor + 1];
      if (!nextChar || /\s/.test(nextChar)) {
        tokens.push({ type: 'LINEBREAK', value: '\\', pos: cursor });
        cursor++;
        continue;
      }
      if (nextChar === '\\') {
        tokens.push({ type: 'LINEBREAK', value: '\\', pos: cursor });
        cursor += 2;
        continue;
      }
      if (nextChar === '!') {
        tokens.push({ type: 'OP', value: '!', pos: cursor });
        cursor += 2;
        continue;
      }
      if (nextChar === '/') {
        // Escaped `\/` is a literal slash (Typst escape), distinct from the
        // `/` fraction operator. Emitted as an IDENT so the parser keeps it
        // out of fraction position; the symbol table maps it to `\slash`.
        tokens.push({ type: 'IDENT', value: '\\/', pos: cursor });
        cursor += 2;
        continue;
      }
      if (nextChar === '%') {
        tokens.push({ type: 'OP', value: '%', pos: cursor });
        cursor += 2;
        continue;
      }
      if ('()[]{}_$^&#'.includes(nextChar)) {
        tokens.push({ type: 'IDENT', value: '\\' + nextChar, pos: cursor });
        cursor += 2;
        continue;
      }
      if (!/[a-zA-Z0-9]/.test(nextChar)) {
        tokens.push({ type: 'OP', value: nextChar, pos: cursor });
        cursor += 2;
        continue;
      }
    }

    // 6. Radicals: √, ∛, ∜
    if (input[cursor] === '√' || input[cursor] === '∛' || input[cursor] === '∜') {
      tokens.push({ type: 'ROOT', value: input[cursor], pos: cursor });
      cursor++;
      continue;
    }

    // 7. Embedded code / hash identifiers: #none, #true, #false, #(expr)
    if (input[cursor] === '#') {
      if (input[cursor + 1] === '(') {
        cursor++;
        continue;
      }
      const hashMatch = rest.match(/^#[a-zA-Z][a-zA-Z0-9]*/);
      if (hashMatch) {
        tokens.push({ type: 'IDENT', value: hashMatch[0], pos: cursor });
        cursor += hashMatch[0].length;
        continue;
      }
    }

    // 8. Semantic brackets [| and |]
    if (rest.startsWith('[|')) {
      tokens.push({ type: 'DELIM', value: '[|', pos: cursor });
      cursor += 2;
      continue;
    }
    if (rest.startsWith('|]')) {
      tokens.push({ type: 'DELIM', value: '|]', pos: cursor });
      cursor += 2;
      continue;
    }

    // 9. Multi-character Typst shorthands
    let matchedShorthand = false;
    for (const [shorthand] of SORTED_TYPST_SHORTHANDS) {
      if (shorthand.length > 1 && rest.startsWith(shorthand)) {
        tokens.push({ type: 'SHORTHAND', value: shorthand, pos: cursor });
        cursor += shorthand.length;
        matchedShorthand = true;
        break;
      }
    }
    if (matchedShorthand) continue;

    // 7. String literals ("..."): \u{...} decoded, unterminated rejected
    // (Typst errors on unterminated strings; silently accepting would store
    // truncated text).
    if (input[cursor] === '"') {
      let content = '';
      let i = cursor + 1;
      let terminated = false;
      while (i < input.length) {
        if (input[i] === '"') {
          terminated = true;
          break;
        }
        if (input[i] === '\\' && i + 1 < input.length) {
          const escaped = input[i + 1];
          if (escaped === '"') content += '"';
          else if (escaped === '\\') content += '\\';
          else if (escaped === 'n') content += '\n';
          else if (escaped === 't') content += '\t';
          else if (escaped === 'r') content += '\r';
          else if (escaped === 'u' && input[i + 2] === '{') {
            const end = input.indexOf('}', i + 3);
            if (end === -1) {
              throw new Error('Unterminated unicode escape in string literal');
            }
            const code = parseInt(input.slice(i + 3, end), 16);
            if (isNaN(code)) {
              throw new Error('Invalid unicode escape in string literal');
            }
            try {
              content += String.fromCodePoint(code);
            } catch {
              throw new Error('Invalid unicode escape in string literal');
            }
            i = end + 1;
            continue;
          } else content += escaped;
          i += 2;
        } else {
          content += input[i];
          i++;
        }
      }
      if (!terminated) {
        throw new Error('Unterminated string literal');
      }
      tokens.push({ type: 'STRING', value: content, pos: cursor });
      cursor = i + 1; // skip closing quote
      continue;
    }

    // 8. Numbers (integers and floats)
    const numMatch = rest.match(/^\d+(?:\.\d+)?/);
    if (numMatch) {
      tokens.push({ type: 'NUMBER', value: numMatch[0], pos: cursor });
      cursor += numMatch[0].length;
      continue;
    }

    // 9. Identifiers (variables, symbols, dotted paths like `arrow.r`)
    const identMatch = rest.match(/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*/);
    if (identMatch) {
      tokens.push({ type: 'IDENT', value: identMatch[0], pos: cursor });
      cursor += identMatch[0].length;
      continue;
    }

    // 10. Primes (', '', ''')
    if (input[cursor] === "'") {
      let primeCount = 0;
      while (cursor < input.length && input[cursor] === "'") {
        primeCount++;
        cursor++;
      }
      tokens.push({ type: 'PRIME', value: "'".repeat(primeCount), pos: cursor - primeCount });
      continue;
    }

    // 11. Single character tokens
    const char = input[cursor];
    let type: TokenType = 'OP';
    if (char === '^' || char === '_') type = 'SCRIPT';
    else if (char === '/') type = 'SLASH';
    else if ('()[]{}'.includes(char)) type = 'DELIM';
    else if (char === '&') type = 'ALIGN';
    else if (char === ',') type = 'COMMA';
    else if (char === ';') type = 'SEMICOLON';
    else if (char === ':') type = 'COLON';

    tokens.push({ type, value: char, pos: cursor });
    cursor++;
  }

  tokens.push({ type: 'EOF', value: '', pos: cursor });
  return tokens;
}
