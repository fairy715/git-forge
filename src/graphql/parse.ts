// A GraphQL document parser: operations with variables, selection sets with aliases, arguments
// and directives, named and inline fragments, and every value form (variables, numbers, strings
// and block strings, booleans, null, enums, lists and input objects). It reads the executable
// language only; type definitions are not something a client sends.

export class SyntaxError extends Error {
  line: number;
  column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

export type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int' | 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

export interface Directive {
  name: string;
  args: Record<string, Value>;
}

export interface FieldNode {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, Value>;
  directives: Directive[];
  selections: Selection[] | null;
  line: number;
  column: number;
}

export interface SpreadNode {
  kind: 'spread';
  name: string;
  directives: Directive[];
}

export interface InlineNode {
  kind: 'inline';
  on: string | null;
  directives: Directive[];
  selections: Selection[];
}

export type Selection = FieldNode | SpreadNode | InlineNode;

export interface VariableDef {
  name: string;
  type: string;
  fallback: Value | null;
}

export interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDef[];
  selections: Selection[];
}

export interface Fragment {
  name: string;
  on: string;
  selections: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, Fragment>;
}

interface Token {
  kind: 'punct' | 'name' | 'int' | 'float' | 'string' | 'end';
  text: string;
  line: number;
  column: number;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);
const NAME_START = /[_A-Za-z]/;
const NAME_PART = /[_0-9A-Za-z]/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  let line = 1;
  let lineStart = 0;
  const fail = (message: string): never => {
    throw new SyntaxError(message, line, at - lineStart + 1);
  };
  while (at < source.length) {
    const ch = source[at];
    if (ch === '\n') {
      at += 1;
      line += 1;
      lineStart = at;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',' || ch === '﻿') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    const column = at - lineStart + 1;
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'punct', text: '...', line, column });
      at += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', text: ch, line, column });
      at += 1;
      continue;
    }
    if (NAME_START.test(ch)) {
      let end = at + 1;
      while (end < source.length && NAME_PART.test(source[end])) end += 1;
      tokens.push({ kind: 'name', text: source.slice(at, end), line, column });
      at = end;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(at));
      if (match === null) fail(`Unexpected character "${ch}"`);
      const number = match as RegExpExecArray;
      tokens.push({ kind: number[1] !== undefined || number[2] !== undefined ? 'float' : 'int', text: number[0], line, column });
      at += number[0].length;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const close = source.indexOf('"""', at + 3);
        if (close < 0) fail('Unterminated block string');
        const raw = source.slice(at + 3, close).replace(/\\"""/g, '"""');
        tokens.push({ kind: 'string', text: blockString(raw), line, column });
        for (let i = at; i < close; i += 1) {
          if (source[i] === '\n') {
            line += 1;
            lineStart = i + 1;
          }
        }
        at = close + 3;
        continue;
      }
      let end = at + 1;
      let text = '';
      for (;;) {
        if (end >= source.length || source[end] === '\n') fail('Unterminated string');
        const c = source[end];
        if (c === '"') break;
        if (c === '\\') {
          const next = source[end + 1];
          if (next === 'u') {
            text += String.fromCharCode(parseInt(source.slice(end + 2, end + 6), 16));
            end += 6;
          } else {
            const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
            if (map[next] === undefined) fail(`Invalid escape \\${next}`);
            text += map[next];
            end += 2;
          }
        } else {
          text += c;
          end += 1;
        }
      }
      tokens.push({ kind: 'string', text, line, column });
      at = end + 1;
      continue;
    }
    fail(`Unexpected character "${ch}"`);
  }
  tokens.push({ kind: 'end', text: '<EOF>', line, column: at - lineStart + 1 });
  return tokens;
}

/** A block string's value: common indentation and blank first and last lines removed. */
function blockString(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let indent = Infinity;
  for (let i = 1; i < lines.length; i += 1) {
    const lead = lines[i].length - lines[i].trimStart().length;
    if (lead < lines[i].length && lead < indent) indent = lead;
  }
  if (indent !== Infinity) for (let i = 1; i < lines.length; i += 1) lines[i] = lines[i].slice(indent);
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

export function parse(source: string): Document {
  const tokens = tokenize(source);
  let at = 0;
  const peek = (): Token => tokens[at];
  const fail = (message: string, token: Token = peek()): never => {
    throw new SyntaxError(message, token.line, token.column);
  };
  const isPunct = (text: string): boolean => peek().kind === 'punct' && peek().text === text;
  const take = (text: string): void => {
    if (!isPunct(text)) fail(`Expected "${text}", found "${peek().text}"`);
    at += 1;
  };
  const maybe = (text: string): boolean => {
    if (!isPunct(text)) return false;
    at += 1;
    return true;
  };
  const name = (): string => {
    const token = peek();
    if (token.kind !== 'name') fail(`Expected a name, found "${token.text}"`);
    at += 1;
    return token.text;
  };

  const value = (constant: boolean): Value => {
    const token = peek();
    if (token.kind === 'punct') {
      if (token.text === '$') {
        if (constant) fail('A variable is not allowed here');
        at += 1;
        return { kind: 'var', name: name() };
      }
      if (token.text === '[') {
        at += 1;
        const items: Value[] = [];
        while (!maybe(']')) items.push(value(constant));
        return { kind: 'list', items };
      }
      if (token.text === '{') {
        at += 1;
        const fields: Record<string, Value> = {};
        while (!maybe('}')) {
          const key = name();
          take(':');
          fields[key] = value(constant);
        }
        return { kind: 'object', fields };
      }
      return fail(`Unexpected "${token.text}"`);
    }
    at += 1;
    if (token.kind === 'int') return { kind: 'int', value: Number(token.text) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.text) };
    if (token.kind === 'string') return { kind: 'string', value: token.text };
    if (token.kind === 'name') {
      if (token.text === 'true' || token.text === 'false') return { kind: 'boolean', value: token.text === 'true' };
      if (token.text === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.text };
    }
    return fail('Unexpected end of document', token);
  };

  const args = (constant: boolean): Record<string, Value> => {
    const out: Record<string, Value> = {};
    if (!maybe('(')) return out;
    while (!maybe(')')) {
      const key = name();
      take(':');
      out[key] = value(constant);
    }
    return out;
  };

  const directives = (constant: boolean): Directive[] => {
    const out: Directive[] = [];
    while (maybe('@')) out.push({ name: name(), args: args(constant) });
    return out;
  };

  const typeRef = (): string => {
    let text: string;
    if (maybe('[')) {
      text = `[${typeRef()}]`;
      take(']');
    } else text = name();
    return maybe('!') ? `${text}!` : text;
  };

  const selectionSet = (): Selection[] => {
    take('{');
    const out: Selection[] = [];
    while (!maybe('}')) {
      if (maybe('...')) {
        if (peek().kind === 'name' && peek().text !== 'on') {
          out.push({ kind: 'spread', name: name(), directives: directives(false) });
        } else {
          let on: string | null = null;
          if (peek().kind === 'name') {
            at += 1;
            on = name();
          }
          out.push({ kind: 'inline', on, directives: directives(false), selections: selectionSet() });
        }
        continue;
      }
      const start = peek();
      let alias = name();
      let field = alias;
      if (maybe(':')) field = name();
      else alias = field;
      const fieldArgs = args(false);
      const fieldDirectives = directives(false);
      out.push({ kind: 'field', alias, name: field, args: fieldArgs, directives: fieldDirectives, selections: isPunct('{') ? selectionSet() : null, line: start.line, column: start.column });
    }
    if (out.length === 0) fail('A selection set cannot be empty');
    return out;
  };

  const document: Document = { operations: [], fragments: new Map() };
  while (peek().kind !== 'end') {
    if (isPunct('{')) {
      document.operations.push({ type: 'query', name: null, variables: [], selections: selectionSet() });
      continue;
    }
    const keyword = name();
    if (keyword === 'fragment') {
      const fragmentName = name();
      if (name() !== 'on') fail('Expected "on" in a fragment definition');
      const on = name();
      directives(true);
      document.fragments.set(fragmentName, { name: fragmentName, on, selections: selectionSet() });
      continue;
    }
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') fail(`Unexpected "${keyword}"`, tokens[at - 1]);
    const operation: Operation = { type: keyword as Operation['type'], name: peek().kind === 'name' ? name() : null, variables: [], selections: [] };
    if (maybe('(')) {
      while (!maybe(')')) {
        take('$');
        const variable = name();
        take(':');
        const type = typeRef();
        const fallback = maybe('=') ? value(true) : null;
        directives(true);
        operation.variables.push({ name: variable, type, fallback });
      }
    }
    directives(false);
    operation.selections = selectionSet();
    document.operations.push(operation);
  }
  if (document.operations.length === 0) fail('The document holds no operation');
  return document;
}
