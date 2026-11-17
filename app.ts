// The forge's one HTTP server. It sends each request to its surface: the health probe, git smart
// HTTP under /<owner>/<repo>.git, REST under /api/v3, GraphQL at /api/graphql and MCP at /mcp.
// Whatever a handler throws becomes a JSON error, so no request can take the process down.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, notFound, readBody, readCall, requireAuth, sendBytes, sendError, sendJson, type Call } from './src/http.ts';
import { advertise, GitRequestError, receivePack, uploadPack } from './src/git/transport.ts';
import { rest } from './src/rest.ts';
import { findRepo } from './src/store.ts';

type Surface = (call: Call) => void | Promise<void>;

let graphql: Surface | null = null;
let mcp: Surface | null = null;

/** Lets the GraphQL and MCP modules attach themselves without this file importing them eagerly. */
export function mount(surface: 'graphql' | 'mcp', handler: Surface): void {
  if (surface === 'graphql') graphql = handler;
  else mcp = handler;
}

const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function git(call: Call, owner: string, name: string, action: string): void {
  requireAuth(call);
  const repo = findRepo(decodeURIComponent(owner), decodeURIComponent(name));
  if (repo === null) throw new ApiError(404, 'Repository not found.');
  const wantsV2 = /version=2/.test(String(call.req.headers['git-protocol'] ?? ''));
  if (action === 'info/refs') {
    if (call.method !== 'GET') throw notFound();
    const service = new URLSearchParams(call.search).get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new ApiError(403, 'Only the smart HTTP protocol is served.');
    sendBytes(call, 200, `application/x-${service}-advertisement`, advertise(repo, service, wantsV2));
    return;
  }
  if (call.method !== 'POST') throw notFound();
  try {
    if (action === 'git-upload-pack') sendBytes(call, 200, 'application/x-git-upload-pack-result', uploadPack(repo, call.body, wantsV2));
    else sendBytes(call, 200, 'application/x-git-receive-pack-result', receivePack(repo, call.body));
  } catch (err) {
    if (err instanceof GitRequestError) throw new ApiError(400, err.message);
    throw err;
  }
}

function route(call: Call): void | Promise<void> {
  const path = call.path;
  if (path === '/healthz') return sendJson(call, 200, { ok: true });
  if (path === '/api/v3' || path.startsWith('/api/v3/')) return rest(call);
  if (path === '/api/graphql' || path === '/graphql') {
    if (graphql === null) throw notFound();
    return graphql(call);
  }
  if (path === '/mcp' || path === '/mcp/') {
    if (mcp === null) throw notFound();
    return mcp(call);
  }
  const match = GIT_PATH.exec(path);
  if (match !== null) return git(call, match[1], match[2], match[3]);
  throw notFound();
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let call: Call | null = null;
  try {
    const method = req.method ?? 'GET';
    const body = method === 'GET' || method === 'HEAD' ? EMPTY : await readBody(req);
    call = readCall(req, res, body);
    await route(call);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const fallback = call ?? readCall(req, res, EMPTY);
    if (err instanceof ApiError) sendError(fallback, err);
    else sendError(fallback, new ApiError(500, err instanceof Error ? `Server Error: ${err.message}` : 'Server Error'));
  }
}

const EMPTY = Buffer.alloc(0);

/** Builds the server; the caller listens (on an ephemeral port in a trial). */
export function createApp(): Server {
  const server = createServer((req, res) => {
    void serve(req, res);
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 0;
  return server;
}
