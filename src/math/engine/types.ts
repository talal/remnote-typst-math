export type TokenType =
  | 'IDENT'
  | 'NUMBER'
  | 'STRING'
  | 'SHORTHAND'
  | 'OP'
  | 'DELIM'
  | 'SCRIPT'
  | 'SLASH'
  | 'COMMA'
  | 'SEMICOLON'
  | 'COLON'
  | 'ALIGN'
  | 'LINEBREAK'
  | 'PRIME'
  | 'ROOT'
  | 'EOF';

export type Token = {
  type: TokenType;
  value: string;
  pos: number;
};

export type MathNode =
  | { type: 'ident'; name: string }
  | { type: 'number'; value: string }
  | { type: 'string'; value: string }
  | { type: 'symbol'; name: string; latex: string }
  | { type: 'script'; base: MathNode; sub?: MathNode; sup?: MathNode }
  | { type: 'fraction'; numer: MathNode; denom: MathNode }
  | { type: 'root'; index?: MathNode; radicand: MathNode }
  | { type: 'call'; name: string; args: MathNode[]; namedArgs: Record<string, MathNode> }
  | { type: 'matrix'; rows: MathNode[][]; delim?: string }
  | { type: 'cases'; branches: MathNode[][] }
  | { type: 'delimited'; open: string; close: string; body: MathNode }
  | { type: 'binary'; op: string; left: MathNode; right: MathNode }
  | { type: 'unary'; op: string; argument: MathNode }
  | { type: 'postfix'; op: string; argument: MathNode }
  | { type: 'align' }
  | { type: 'linebreak' }
  | { type: 'sequence'; elements: MathNode[] };
