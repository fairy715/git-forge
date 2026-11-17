// The forge's one HTTP server. It sends each request to its surface: the health probe, git smart
// HTTP under /<owner>/<repo>.git, REST under /api/v3, GraphQL at /api/graphql and MCP at /mcp.
// Whatever a handler throws becomes a JSON error, so no request can take the process down.

import type { Server } from 'node:net';
import { ApiError, notFound, readCall, requestIdStamp, requireAuth, sendBytes, sendError, sendJson, type Call } from './src/http.ts';
import { advertise, GitRequestError, receivePack, uploadPack } from './src/git/transport.ts';
import { rest } from './src/rest.ts';
import { findRepo } from './src/store.ts';
import { forgetReplies, serveHttp, type Reply, type Request } from './src/wire.ts';

type Surface = (call: Call) => void | Promise<void>;

let graphql: Surface | null = null;
let mcp: Surface | null = null;

/** Lets the GraphQL and MCP modules attach themselves without this file importing them eagerly. */
export function mount(surface: 'graphql' | 'mcp', handler: Surface): void {
  if (surface === 'graphql') graphql = handler;
  else mcp = handler;
}

const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** A path segment as text: percent-escapes decoded, when there are any. */
function segment(text: string): string {
  return text.includes('%') ? decodeURIComponent(text) : text;
}

function git(call: Call, owner: string, name: string, action: string): void {
  requireAuth(call);
  const repo = findRepo(segment(owner), segment(name));
  if (repo === null) throw new ApiError(404, 'Repository not found.');
  const protocol = call.headers['git-protocol'];
  const wantsV2 = protocol !== undefined && protocol.includes('version=2');
  if (action === 'info/refs') {
    if (call.method !== 'GET') throw notFound();
    // The query is nearly always exactly one of these two; anything else is parsed in full.
    const search = call.search;
    const service =
      search === 'service=git-upload-pack' ? 'git-upload-pack' : search === 'service=git-receive-pack' ? 'git-receive-pack' : new URLSearchParams(search).get('service');
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

const NO_REPLY: Reply = { status: 500, head: 'content-type: application/json; charset=utf-8\r\n', body: '{"message":"Server Error: the route sent no reply"}' };

function failed(call: Call, err: unknown): Reply {
  if (err instanceof ApiError) sendError(call, err);
  else sendError(call, new ApiError(500, err instanceof Error ? `Server Error: ${err.message}` : 'Server Error'));
  return call.reply as Reply;
}

/**
 * Whether a request only reads: a GET (HEAD arrives here as GET), or a fetch, which is a POST that
 * changes nothing. Every other request may change what a read answers.
 */
function onlyReads(request: Request): boolean {
  if (request.method === 'GET') return true;
  if (request.method !== 'POST') return false;
  const mark = request.url.indexOf('?');
  return (mark < 0 ? request.url : request.url.slice(0, mark)).endsWith('/git-upload-pack');
}

/** Marks a read's reply as good for the same request again (until the next change). */
function settled(reply: Reply, reads: boolean): Reply {
  if (reads) reply.repeatable = true;
  return reply;
}

function serve(request: Request): Reply | Promise<Reply> {
  const reads = onlyReads(request);
  if (!reads) forgetReplies();
  let call: Call;
  try {
    call = readCall(request);
  } catch {
    // A body whose Content-Encoding does not decode.
    const plain = readCall({ ...request, headers: { ...request.headers, 'content-encoding': '' } });
    return failed(plain, new ApiError(400, 'The request body could not be decoded'));
  }
  try {
    const pending = route(call);
    if (pending instanceof Promise) {
      // A handler that finishes later may change state after other requests were answered.
      return pending.then(() => call.reply ?? NO_REPLY, (err: unknown) => failed(call, err)).finally(() => forgetReplies());
    }
    return settled(call.reply ?? NO_REPLY, reads);
  } catch (err) {
    return settled(failed(call, err), reads);
  }
}

/** Builds the server; the caller listens (on an ephemeral port in a trial). */
export function createApp(): Server {
  return serveHttp(serve, requestIdStamp);
}
