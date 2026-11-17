// POST /api/graphql: GitHub's GraphQL v4 endpoint. The body is {query, variables, operationName},
// or a JSON array of such objects, answered in order. A document that does not parse or validate
// is still HTTP 200 with an `errors` array, as GitHub answers it.

import { mount } from '../../app.ts';
import { ApiError, requireAuth, sendJson, type Call } from '../http.ts';
import { execute, type Result } from './execute.ts';
import { parse, SyntaxError, type Document } from './parse.ts';
import { schema } from './schema.ts';

const parsed = new Map<string, Document>();
const PARSED_MAX = 200;

/** Parsed documents are kept: a client sends the same few documents over and over. */
function documentOf(source: string): Document {
  const kept = parsed.get(source);
  if (kept !== undefined) return kept;
  const document = parse(source);
  if (parsed.size >= PARSED_MAX) parsed.delete(parsed.keys().next().value as string);
  parsed.set(source, document);
  return document;
}

function runOne(request: unknown): Result {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  const { query, variables, operationName } = request as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof query !== 'string' || query.trim() === '') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  let given: Record<string, unknown> = {};
  if (typeof variables === 'string' && variables.trim() !== '') {
    try {
      given = JSON.parse(variables) as Record<string, unknown>;
    } catch {
      return { errors: [{ message: 'The variables attribute is not valid JSON.' }] };
    }
  } else if (typeof variables === 'object' && variables !== null && !Array.isArray(variables)) given = variables as Record<string, unknown>;
  let document: Document;
  try {
    document = documentOf(query);
  } catch (err) {
    if (err instanceof SyntaxError) return { errors: [{ message: `Parse error on line ${err.line}, column ${err.column}: ${err.message}`, locations: [{ line: err.line, column: err.column }] }] };
    throw err;
  }
  return execute(schema, document, typeof operationName === 'string' ? operationName : null, given);
}

function graphql(call: Call): void {
  requireAuth(call);
  if (call.method !== 'POST') throw new ApiError(404, 'Not Found');
  let body: unknown;
  try {
    body = JSON.parse(call.body.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  sendJson(call, 200, Array.isArray(body) ? body.map(runOne) : runOne(body));
}

mount('graphql', graphql);
