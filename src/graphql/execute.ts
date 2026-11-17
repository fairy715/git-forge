// A small GraphQL engine: a schema described as data (types, fields with resolvers, enums, input
// objects, interfaces), validation of a document against it, execution with variables, fragments
// and the @skip/@include directives, and the introspection system (__schema, __type, __typename)
// served from the same schema description.

import type { Directive, Document, FieldNode, Fragment, Operation, Selection, Value } from './parse.ts';

export type Resolver = (source: any, args: Record<string, any>) => unknown;

export interface FieldDef {
  type: string;
  args?: Record<string, string>;
  description?: string;
  resolve?: Resolver;
}

export interface TypeDef {
  kind: 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  name: string;
  description?: string;
  fields?: Record<string, FieldDef>;
  /** INPUT_OBJECT fields: name to type. */
  inputs?: Record<string, string>;
  /** ENUM values. */
  values?: string[];
  /** Interfaces an OBJECT implements. */
  implements?: string[];
  /** The concrete type of a value of an INTERFACE or UNION. */
  typeOf?: (value: any) => string;
}

export interface Schema {
  types: Map<string, TypeDef>;
  query: string;
  mutation: string | null;
}

export interface GraphError {
  message: string;
  locations?: { line: number; column: number }[];
  path?: (string | number)[];
  type?: string;
}

/** A failure a resolver reports to the client: the message, and GitHub's error `type`. */
export class FieldError extends Error {
  type: string;

  constructor(message: string, type = 'UNPROCESSABLE') {
    super(message);
    this.type = type;
  }
}

// ---- type references --------------------------------------------------------------------------

interface TypeRef {
  kind: 'NON_NULL' | 'LIST' | 'NAMED';
  name: string;
  of: TypeRef | null;
}

const refCache = new Map<string, TypeRef>();

/** "[Issue!]!" as nested references. */
function refOf(text: string): TypeRef {
  const cached = refCache.get(text);
  if (cached !== undefined) return cached;
  let ref: TypeRef;
  if (text.endsWith('!')) ref = { kind: 'NON_NULL', name: '', of: refOf(text.slice(0, -1)) };
  else if (text.startsWith('[')) ref = { kind: 'LIST', name: '', of: refOf(text.slice(1, -1)) };
  else ref = { kind: 'NAMED', name: text, of: null };
  refCache.set(text, ref);
  return ref;
}

function namedOf(ref: TypeRef): string {
  let at = ref;
  while (at.of !== null) at = at.of;
  return at.name;
}

// ---- values -----------------------------------------------------------------------------------

/** A literal with the variables filled in, as plain JSON (an enum is its name). */
function valueOf(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const key in value.fields) {
        const item = valueOf(value.fields[key], variables);
        if (item !== undefined) out[key] = item;
      }
      return out;
    }
  }
}

function argsOf(args: Record<string, Value>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key in args) {
    const value = valueOf(args[key], variables);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Whether @skip and @include let a selection through. */
function included(directives: Directive[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    const condition = directive.args.if === undefined ? undefined : valueOf(directive.args.if, variables);
    if (directive.name === 'skip' && condition === true) return false;
    if (directive.name === 'include' && condition === false) return false;
  }
  return true;
}

// ---- introspection ----------------------------------------------------------------------------

const META_FIELDS: Record<string, FieldDef> = {
  __typename: { type: 'String!' },
};

function refView(schema: Schema, ref: TypeRef): unknown {
  if (ref.kind === 'NAMED') return schema.types.get(ref.name) ?? { kind: 'SCALAR', name: ref.name };
  return { wrapper: ref };
}

function fieldViews(schema: Schema, type: TypeDef): unknown[] | null {
  if (type.kind !== 'OBJECT' && type.kind !== 'INTERFACE') return null;
  return Object.entries(type.fields ?? {}).map(([name, field]) => ({ name, field, schema }));
}

function inputViews(inputs: Record<string, string> | undefined): unknown[] {
  return Object.entries(inputs ?? {}).map(([name, type]) => ({ name, type }));
}

/** The introspection types, added to every schema. */
function metaTypes(schema: Schema): TypeDef[] {
  const typeOfRef = (text: string): unknown => refView(schema, refOf(text));
  return [
    {
      kind: 'OBJECT',
      name: '__Schema',
      fields: {
        description: { type: 'String', resolve: () => null },
        types: { type: '[__Type!]!', resolve: () => [...schema.types.values()] },
        queryType: { type: '__Type!', resolve: () => schema.types.get(schema.query) },
        mutationType: { type: '__Type', resolve: () => (schema.mutation === null ? null : schema.types.get(schema.mutation)) },
        subscriptionType: { type: '__Type', resolve: () => null },
        directives: {
          type: '[__Directive!]!',
          resolve: () => [
            { name: 'include', description: 'Includes the field or fragment when `if` is true.', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if', type: 'Boolean!' }] },
            { name: 'skip', description: 'Skips the field or fragment when `if` is true.', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if', type: 'Boolean!' }] },
          ],
        },
      },
    },
    {
      kind: 'OBJECT',
      name: '__Type',
      fields: {
        kind: { type: '__TypeKind!', resolve: (t) => (t.wrapper !== undefined ? t.wrapper.kind : t.kind) },
        name: { type: 'String', resolve: (t) => (t.wrapper !== undefined ? null : t.name) },
        description: { type: 'String', resolve: (t) => t.description ?? null },
        specifiedByURL: { type: 'String', resolve: () => null },
        fields: { type: '[__Field!]', args: { includeDeprecated: 'Boolean' }, resolve: (t) => (t.wrapper !== undefined ? null : fieldViews(schema, t)) },
        interfaces: {
          type: '[__Type!]',
          resolve: (t) => (t.kind === 'OBJECT' ? (t.implements ?? []).map((name: string) => schema.types.get(name)) : t.kind === 'INTERFACE' ? [] : null),
        },
        possibleTypes: {
          type: '[__Type!]',
          resolve: (t) => (t.kind === 'INTERFACE' || t.kind === 'UNION' ? [...schema.types.values()].filter((other) => (other.implements ?? []).includes(t.name)) : null),
        },
        enumValues: { type: '[__EnumValue!]', args: { includeDeprecated: 'Boolean' }, resolve: (t) => (t.kind === 'ENUM' ? (t.values ?? []).map((name: string) => ({ name })) : null) },
        inputFields: { type: '[__InputValue!]', args: { includeDeprecated: 'Boolean' }, resolve: (t) => (t.kind === 'INPUT_OBJECT' ? inputViews(t.inputs) : null) },
        ofType: { type: '__Type', resolve: (t) => (t.wrapper !== undefined ? refView(schema, t.wrapper.of) : null) },
      },
    },
    {
      kind: 'OBJECT',
      name: '__Field',
      fields: {
        name: { type: 'String!' },
        description: { type: 'String', resolve: (f) => f.field.description ?? null },
        args: { type: '[__InputValue!]!', args: { includeDeprecated: 'Boolean' }, resolve: (f) => inputViews(f.field.args) },
        type: { type: '__Type!', resolve: (f) => typeOfRef(f.field.type) },
        isDeprecated: { type: 'Boolean!', resolve: () => false },
        deprecationReason: { type: 'String', resolve: () => null },
      },
    },
    {
      kind: 'OBJECT',
      name: '__InputValue',
      fields: {
        name: { type: 'String!' },
        description: { type: 'String', resolve: () => null },
        type: { type: '__Type!', resolve: (v) => typeOfRef(v.type) },
        defaultValue: { type: 'String', resolve: () => null },
        isDeprecated: { type: 'Boolean!', resolve: () => false },
        deprecationReason: { type: 'String', resolve: () => null },
      },
    },
    {
      kind: 'OBJECT',
      name: '__EnumValue',
      fields: {
        name: { type: 'String!' },
        description: { type: 'String', resolve: () => null },
        isDeprecated: { type: 'Boolean!', resolve: () => false },
        deprecationReason: { type: 'String', resolve: () => null },
      },
    },
    {
      kind: 'OBJECT',
      name: '__Directive',
      fields: {
        name: { type: 'String!' },
        description: { type: 'String' },
        isRepeatable: { type: 'Boolean!', resolve: () => false },
        locations: { type: '[__DirectiveLocation!]!' },
        args: { type: '[__InputValue!]!', args: { includeDeprecated: 'Boolean' } },
      },
    },
    { kind: 'ENUM', name: '__TypeKind', values: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] },
    { kind: 'ENUM', name: '__DirectiveLocation', values: ['QUERY', 'MUTATION', 'SUBSCRIPTION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT', 'VARIABLE_DEFINITION'] },
  ];
}

const SCALARS = ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'HTML', 'Base64String'];

/** Builds a schema from its types, adding the built-in scalars and the introspection system. */
export function makeSchema(types: TypeDef[], query: string, mutation: string | null): Schema {
  const schema: Schema = { types: new Map(), query, mutation };
  for (const name of SCALARS) schema.types.set(name, { kind: 'SCALAR', name });
  for (const type of types) schema.types.set(type.name, type);
  for (const type of metaTypes(schema)) schema.types.set(type.name, type);
  const root = schema.types.get(query) as TypeDef;
  root.fields = {
    ...root.fields,
    __schema: { type: '__Schema!', resolve: () => ({}) },
    __type: { type: '__Type', args: { name: 'String!' }, resolve: (_source, args) => schema.types.get(String(args.name)) ?? null },
  };
  return schema;
}

// ---- validation -------------------------------------------------------------------------------

interface Run {
  schema: Schema;
  fragments: Map<string, Fragment>;
  variables: Record<string, unknown>;
  errors: GraphError[];
}

function fieldOf(type: TypeDef, name: string): FieldDef | undefined {
  if (name === '__typename') return META_FIELDS.__typename;
  return type.fields?.[name];
}

/** Reports every field, argument, fragment and type a document names that the schema lacks. */
function validate(run: Run, type: TypeDef, selections: Selection[], seen: Set<string>): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const field = fieldOf(type, selection.name);
      if (field === undefined) {
        run.errors.push({
          message: `Field '${selection.name}' doesn't exist on type '${type.name}'`,
          locations: [{ line: selection.line, column: selection.column }],
          path: ['query', selection.name],
          type: 'undefinedField',
        });
        continue;
      }
      for (const arg in selection.args) {
        if (field.args?.[arg] === undefined) {
          run.errors.push({ message: `Field '${selection.name}' doesn't accept argument '${arg}'`, locations: [{ line: selection.line, column: selection.column }], type: 'argumentNotAccepted' });
        }
      }
      for (const arg in field.args ?? {}) {
        if ((field.args as Record<string, string>)[arg].endsWith('!') && selection.args[arg] === undefined) {
          run.errors.push({ message: `Field '${selection.name}' is missing required arguments: ${arg}`, locations: [{ line: selection.line, column: selection.column }], type: 'missingRequiredArguments' });
        }
      }
      const target = run.schema.types.get(namedOf(refOf(field.type)));
      const composite = target !== undefined && (target.kind === 'OBJECT' || target.kind === 'INTERFACE' || target.kind === 'UNION');
      if (composite && selection.selections === null) {
        run.errors.push({ message: `Field must have selections (field '${selection.name}' returns ${target.name} but has no selections. Did you mean '${selection.name} { ... }'?)`, locations: [{ line: selection.line, column: selection.column }], type: 'selectionMismatch' });
      } else if (!composite && selection.selections !== null) {
        run.errors.push({ message: `Selections can't be made on scalars (field '${selection.name}' returns ${namedOf(refOf(field.type))} but has selections)`, locations: [{ line: selection.line, column: selection.column }], type: 'selectionMismatch' });
      } else if (composite && selection.selections !== null) {
        validate(run, target, selection.selections, seen);
      }
    } else {
      let on: string | null;
      let inner: Selection[];
      if (selection.kind === 'spread') {
        const fragment = run.fragments.get(selection.name);
        if (fragment === undefined) {
          run.errors.push({ message: `Fragment ${selection.name} was used, but not defined`, type: 'undefinedFragment' });
          continue;
        }
        if (seen.has(`${fragment.name}@${type.name}`)) continue;
        seen.add(`${fragment.name}@${type.name}`);
        on = fragment.on;
        inner = fragment.selections;
      } else {
        on = selection.on;
        inner = selection.selections;
      }
      const target = on === null ? type : run.schema.types.get(on);
      if (target === undefined) {
        run.errors.push({ message: `No such type ${on}, so it can't be a fragment condition`, type: 'undefinedType' });
        continue;
      }
      validate(run, target, inner, seen);
    }
  }
}

// ---- execution --------------------------------------------------------------------------------

/** Thrown to carry a null up to the nearest field that may be null. */
class NullBubble extends Error {}

function typeMatches(schema: Schema, concrete: TypeDef, condition: string | null): boolean {
  if (condition === null || condition === concrete.name) return true;
  const target = schema.types.get(condition);
  return target !== undefined && (target.kind === 'INTERFACE' || target.kind === 'UNION') && (concrete.implements ?? []).includes(condition);
}

/** The fields a selection set asks of a concrete type, in order, fragments flattened. */
function collect(run: Run, type: TypeDef, selections: Selection[], into: Map<string, FieldNode[]>): void {
  for (const selection of selections) {
    if (!included(selection.directives, run.variables)) continue;
    if (selection.kind === 'field') {
      const group = into.get(selection.alias);
      if (group === undefined) into.set(selection.alias, [selection]);
      else group.push(selection);
    } else if (selection.kind === 'spread') {
      const fragment = run.fragments.get(selection.name);
      if (fragment !== undefined && typeMatches(run.schema, type, fragment.on)) collect(run, type, fragment.selections, into);
    } else if (typeMatches(run.schema, type, selection.on)) {
      collect(run, type, selection.selections, into);
    }
  }
}

function completeValue(run: Run, ref: TypeRef, nodes: FieldNode[], value: unknown, path: (string | number)[]): unknown {
  if (ref.kind === 'NON_NULL') {
    const inner = completeValue(run, ref.of as TypeRef, nodes, value, path);
    if (inner === null) throw new NullBubble();
    return inner;
  }
  if (value === null || value === undefined) return null;
  if (ref.kind === 'LIST') {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item, index) => {
      try {
        return completeValue(run, ref.of as TypeRef, nodes, item, [...path, index]);
      } catch (err) {
        if (err instanceof NullBubble && (ref.of as TypeRef).kind !== 'NON_NULL') return null;
        throw err;
      }
    });
  }
  let type = run.schema.types.get(ref.name);
  if (type === undefined || type.kind === 'SCALAR' || type.kind === 'ENUM') return value;
  if (type.kind === 'INTERFACE' || type.kind === 'UNION') {
    const concrete = type.typeOf === undefined ? undefined : run.schema.types.get(type.typeOf(value));
    if (concrete === undefined) return null;
    type = concrete;
  }
  const selections: Selection[] = [];
  for (const node of nodes) if (node.selections !== null) selections.push(...node.selections);
  return executeSelections(run, type, selections, value, path);
}

function executeSelections(run: Run, type: TypeDef, selections: Selection[], source: unknown, path: (string | number)[]): Record<string, unknown> {
  const groups = new Map<string, FieldNode[]>();
  collect(run, type, selections, groups);
  const out: Record<string, unknown> = {};
  for (const [alias, nodes] of groups) {
    const node = nodes[0];
    if (node.name === '__typename') {
      out[alias] = type.name;
      continue;
    }
    const field = fieldOf(type, node.name);
    if (field === undefined) continue;
    const ref = refOf(field.type);
    const fieldPath = [...path, alias];
    try {
      const args = argsOf(node.args, run.variables);
      const raw = field.resolve === undefined ? (source as Record<string, unknown> | null)?.[node.name] : field.resolve(source, args);
      out[alias] = completeValue(run, ref, nodes, raw, fieldPath);
    } catch (err) {
      if (err instanceof NullBubble) {
        if (ref.kind === 'NON_NULL') throw err;
        out[alias] = null;
        continue;
      }
      const error: GraphError = { message: err instanceof Error ? err.message : String(err), locations: [{ line: node.line, column: node.column }], path: fieldPath };
      if (err instanceof FieldError) error.type = err.type;
      run.errors.push(error);
      if (ref.kind === 'NON_NULL') throw new NullBubble();
      out[alias] = null;
    }
  }
  return out;
}

/** Whether a variable's JSON value fits its declared type, loosely: null against non-null fails. */
function coerceVariables(run: Run, operation: Operation, given: Record<string, unknown>): void {
  for (const variable of operation.variables) {
    let value = given[variable.name];
    if (value === undefined && variable.fallback !== null) value = valueOf(variable.fallback, {});
    if ((value === undefined || value === null) && variable.type.endsWith('!')) {
      run.errors.push({ message: `Variable $${variable.name} of type ${variable.type} was provided invalid value`, type: 'INVALID_VARIABLE' });
      continue;
    }
    if (value !== undefined) run.variables[variable.name] = value;
  }
}

export interface Result {
  data?: unknown;
  errors?: GraphError[];
}

/** Runs one operation of a parsed document. */
export function execute(schema: Schema, document: Document, operationName: string | null, variables: Record<string, unknown>): Result {
  let operation: Operation | undefined;
  if (operationName !== null && operationName !== '') operation = document.operations.find((each) => each.name === operationName);
  else if (document.operations.length === 1) operation = document.operations[0];
  if (operation === undefined) {
    const message = operationName !== null && operationName !== '' ? `No operation named "${operationName}"` : 'An operation name is required';
    return { errors: [{ message }] };
  }
  const rootName = operation.type === 'mutation' ? schema.mutation : operation.type === 'query' ? schema.query : null;
  const root = rootName === null ? undefined : schema.types.get(rootName);
  if (root === undefined) return { errors: [{ message: `Schema is not configured for ${operation.type}s` }] };

  const run: Run = { schema, fragments: document.fragments, variables: {}, errors: [] };
  validate(run, root, operation.selections, new Set());
  if (run.errors.length > 0) return { errors: run.errors };
  coerceVariables(run, operation, variables);
  if (run.errors.length > 0) return { errors: run.errors };
  let data: unknown;
  try {
    data = executeSelections(run, root, operation.selections, {}, []);
  } catch (err) {
    if (!(err instanceof NullBubble)) throw err;
    data = null;
  }
  return run.errors.length > 0 ? { data, errors: run.errors } : { data };
}
