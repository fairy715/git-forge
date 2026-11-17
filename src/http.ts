// The HTTP plumbing every surface shares: reading a request (body, bearer token, query), JSON and
// binary replies with the headers GitHub clients look for, and the error shape.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync, inflateSync } from 'node:zlib';

export interface Call {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** The path with no query string, percent-escapes left as sent. */
  path: string;
  /** The raw query string, without the "?". */
  search: string;
  body: Buffer;
  /** http://host:port as the client addressed this server, for the URLs in replies. */
  origin: string;
  /** Whether the request carries the trial's bearer token. */
  authed: boolean;
  /** Whether it carries any credential at all (a wrong one is "Bad credentials"). */
  hasCredential: boolean;
}

/** A reply made by throwing: the status, and the JSON error body GitHub would send. */
export class ApiError extends Error {
  status: number;
  extra: Record<string, unknown>;

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const notFound = (): ApiError => new ApiError(404, 'Not Found');
export const invalid = (message: string, errors: unknown[] = []): ApiError => new ApiError(422, message, errors.length > 0 ? { errors } : {});

const DOCS = 'https://docs.github.com/rest';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const BODY_LIMIT = 256 * 1024 * 1024;

let served = 0;

/** A request id: unique per reply, and the same sequence on every run. */
function requestId(): string {
  served += 1;
  const hex = served.toString(16).toUpperCase().padStart(8, '0');
  return `F0A6:${hex.slice(0, 4)}:${hex.slice(4)}:1D2C3B:${(served * 2654435761 % 4294967296).toString(16).toUpperCase().padStart(8, '0')}`;
}

/** The credential a request presents: a bearer or token header, or the password of basic auth. */
function credentialOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined || header === '') return null;
  const space = header.indexOf(' ');
  const scheme = (space < 0 ? header : header.slice(0, space)).toLowerCase();
  const value = space < 0 ? '' : header.slice(space + 1).trim();
  if (scheme === 'bearer' || scheme === 'token') return value;
  if (scheme === 'basic') {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    const user = colon < 0 ? decoded : decoded.slice(0, colon);
    const password = colon < 0 ? '' : decoded.slice(colon + 1);
    return password !== '' && password !== 'x-oauth-basic' ? password : user;
  }
  return value;
}

export function readCall(req: IncomingMessage, res: ServerResponse, body: Buffer): Call {
  const url = req.url ?? '/';
  const mark = url.indexOf('?');
  const credential = credentialOf(req);
  let payload = body;
  const encoding = req.headers['content-encoding'];
  if (payload.length > 0 && encoding !== undefined) {
    if (encoding === 'gzip' || encoding === 'x-gzip') payload = gunzipSync(payload);
    else if (encoding === 'deflate') payload = inflateSync(payload);
  }
  return {
    req,
    res,
    method: req.method ?? 'GET',
    path: mark < 0 ? url : url.slice(0, mark),
    search: mark < 0 ? '' : url.slice(mark + 1),
    body: payload,
    origin: `http://${req.headers.host ?? 'localhost'}`,
    // With no token configured (a local run) any credential is the owner's.
    authed: credential !== null && credential !== '' && (EXPECTED_TOKEN === '' || credential === EXPECTED_TOKEN),
    hasCredential: credential !== null && credential !== '',
  };
}

/** Collects a request body, refusing one past the limit. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new ApiError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function query(call: Call): URLSearchParams {
  return new URLSearchParams(call.search);
}

/** The request body as a JSON object: an empty body is {}, anything unparsable is a 400. */
export function jsonBody(call: Call): Record<string, unknown> {
  if (call.body.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(call.body.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ApiError(400, 'Body should be a JSON object');
  return value as Record<string, unknown>;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** Sends JSON already serialized. */
export function sendRaw(call: Call, status: number, body: Buffer | string, headers: Record<string, string> | null = null): void {
  const res = call.res;
  res.statusCode = status;
  res.setHeader('content-type', JSON_TYPE);
  res.setHeader('content-length', typeof body === 'string' ? Buffer.byteLength(body) : body.length);
  res.setHeader('x-github-request-id', requestId());
  res.setHeader('x-github-media-type', 'github.v3; format=json');
  if (headers !== null) for (const name in headers) res.setHeader(name, headers[name]);
  res.end(body);
}

export function sendJson(call: Call, status: number, value: unknown, headers: Record<string, string> | null = null): void {
  sendRaw(call, status, JSON.stringify(value), headers);
}

export function sendEmpty(call: Call, status: number): void {
  const res = call.res;
  res.statusCode = status;
  res.setHeader('x-github-request-id', requestId());
  res.setHeader('content-length', 0);
  res.end();
}

export function sendError(call: Call, error: ApiError): void {
  const headers = error.status === 401 ? { 'www-authenticate': 'Basic realm="GitHub"' } : null;
  sendJson(call, error.status, { message: error.message, ...error.extra, documentation_url: DOCS, status: String(error.status) }, headers);
}

export function sendBytes(call: Call, status: number, type: string, body: Buffer): void {
  const res = call.res;
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.setHeader('content-length', body.length);
  res.setHeader('cache-control', 'no-cache, max-age=0, must-revalidate');
  res.setHeader('x-github-request-id', requestId());
  res.end(body);
}

/** Throws the 401 a request with no (or a wrong) credential gets. */
export function requireAuth(call: Call): void {
  if (!call.authed) throw new ApiError(401, call.hasCredential ? 'Bad credentials' : 'Requires authentication');
}

/** `per_page` and `page` from a query, clamped as GitHub clamps them. */
export function paging(params: URLSearchParams): { perPage: number; page: number } {
  const perPage = Number(params.get('per_page') ?? '30');
  const page = Number(params.get('page') ?? '1');
  return {
    perPage: Number.isFinite(perPage) && perPage >= 1 ? Math.min(100, Math.floor(perPage)) : 30,
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
  };
}

/**
 * One page of `items`, with the Link header (next, prev, first, last) that lets a client walk the
 * rest; the links keep the request's other query parameters.
 */
export function sendPage<T>(call: Call, items: T[], render: (item: T) => unknown): void {
  const params = query(call);
  const { perPage, page } = paging(params);
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const link = (target: number, rel: string): string => {
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `<${call.origin}${call.path}?${params.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (page < pages) links.push(link(page + 1, 'next'), link(pages, 'last'));
  if (page > 1) links.push(link(1, 'first'), link(Math.min(page - 1, pages), 'prev'));
  sendJson(call, 200, slice.map(render), links.length > 0 ? { link: links.join(', ') } : null);
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
