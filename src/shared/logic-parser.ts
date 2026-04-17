// Parser for logic expressions like "1 AND 2", "1 AND (2 OR 3)", "(1 OR 2) AND (3 OR 4)".
// Produces an AST that the SOQL builder walks to emit WHERE fragments.
//
// Grammar (lowercase = nonterminal, UPPERCASE = terminal):
//   expr    := or_expr
//   or_expr := and_expr ('OR' and_expr)*
//   and_expr := term ('AND' term)*
//   term    := NUMBER | '(' expr ')'
//
// AND binds tighter than OR, matching SOQL semantics. Case-insensitive keywords.

export type LogicNode =
  | { type: 'index'; value: number }
  | { type: 'and'; left: LogicNode; right: LogicNode }
  | { type: 'or'; left: LogicNode; right: LogicNode };

type Token =
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'and'; pos: number }
  | { kind: 'or'; pos: number }
  | { kind: 'lparen'; pos: number }
  | { kind: 'rparen'; pos: number }
  | { kind: 'eof'; pos: number };

export class LogicParseError extends Error {
  constructor(message: string, public readonly position?: number) {
    super(message);
    this.name = 'LogicParseError';
  }
}

// ============ Tokenizer ============

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Parens
    if (ch === '(') {
      tokens.push({ kind: 'lparen', pos: i });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', pos: i });
      i++;
      continue;
    }

    // Numbers (condition indices)
    if (/\d/.test(ch)) {
      const start = i;
      while (i < input.length && /\d/.test(input[i])) i++;
      const value = parseInt(input.slice(start, i), 10);
      tokens.push({ kind: 'number', value, pos: start });
      continue;
    }

    // Keywords (AND, OR) — case insensitive, word-boundary aware
    if (/[a-zA-Z]/.test(ch)) {
      const start = i;
      while (i < input.length && /[a-zA-Z]/.test(input[i])) i++;
      const word = input.slice(start, i).toUpperCase();
      if (word === 'AND') {
        tokens.push({ kind: 'and', pos: start });
        continue;
      }
      if (word === 'OR') {
        tokens.push({ kind: 'or', pos: start });
        continue;
      }
      throw new LogicParseError(
        `Unexpected word '${input.slice(start, i)}' at position ${start}. Expected AND or OR.`,
        start
      );
    }

    throw new LogicParseError(`Unexpected character '${ch}' at position ${i}.`, i);
  }

  tokens.push({ kind: 'eof', pos: input.length });
  return tokens;
}

// ============ Parser (recursive descent) ============

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    return this.tokens[this.pos++];
  }

  parse(): LogicNode {
    const node = this.parseOr();
    const next = this.peek();
    if (next.kind !== 'eof') {
      throw new LogicParseError(
        `Unexpected token at position ${next.pos}. Expression should have ended.`,
        next.pos
      );
    }
    return node;
  }

  // or_expr := and_expr ('OR' and_expr)*
  private parseOr(): LogicNode {
    let left = this.parseAnd();
    while (this.peek().kind === 'or') {
      this.consume();
      const right = this.parseAnd();
      left = { type: 'or', left, right };
    }
    return left;
  }

  // and_expr := term ('AND' term)*
  private parseAnd(): LogicNode {
    let left = this.parseTerm();
    while (this.peek().kind === 'and') {
      this.consume();
      const right = this.parseTerm();
      left = { type: 'and', left, right };
    }
    return left;
  }

  // term := NUMBER | '(' expr ')'
  private parseTerm(): LogicNode {
    const tok = this.peek();
    if (tok.kind === 'number') {
      this.consume();
      return { type: 'index', value: tok.value };
    }
    if (tok.kind === 'lparen') {
      this.consume();
      const inner = this.parseOr();
      const closing = this.peek();
      if (closing.kind !== 'rparen') {
        throw new LogicParseError(
          `Expected ')' at position ${closing.pos}.`,
          closing.pos
        );
      }
      this.consume();
      return inner;
    }
    if (tok.kind === 'eof') {
      throw new LogicParseError('Unexpected end of expression.', tok.pos);
    }
    throw new LogicParseError(
      `Unexpected token at position ${tok.pos}. Expected a number or '('.`,
      tok.pos
    );
  }
}

// ============ Public API ============

/**
 * Parse a logic expression string into an AST.
 * @throws LogicParseError if the expression is malformed.
 */
export function parseLogic(input: string): LogicNode {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new LogicParseError('Logic expression is empty.');
  }
  const tokens = tokenize(trimmed);
  return new Parser(tokens).parse();
}

/**
 * Walk the AST and collect all condition indices referenced.
 * Used to validate that logic doesn't reference out-of-range indices.
 */
export function collectIndices(node: LogicNode): number[] {
  const indices: number[] = [];
  const walk = (n: LogicNode): void => {
    if (n.type === 'index') {
      indices.push(n.value);
    } else {
      walk(n.left);
      walk(n.right);
    }
  };
  walk(node);
  return indices;
}