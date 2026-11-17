// HTTP/1.1 straight on TCP sockets. The forge answers many small requests one after another, and
// node:http's per-request machinery (streams, header objects, timers) costs several times what
// the handlers do, so this serves the subset the forge needs itself: request line and headers,
// bodies by Content-Length or chunked encoding, Expect: 100-continue, HEAD, keep-alive with
// pipelining in order, and replies that always carry a Content-Length and leave in a single write.

import { createServer, type Server, type Socket } from 'node:net';

export interface Request {
  method: string;
  /** The request target as sent: path and query string. */
  url: string;
  /** Header names in lower case; a repeated header keeps its values joined by ", ". */
  headers: Record<string, string>;
  body: Buffer;
}

export interface Reply {
  status: number;
  /** Extra header lines, each "name: value\r\n" (content-length is added here). */
  head: string;
  body: Buffer | string;
}

export type Handler = (request: Request) => Reply | Promise<Reply>;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
};

const HEAD_END = Buffer.from('\r\n\r\n', 'latin1');
const EMPTY: Buffer = Buffer.alloc(0);
const HEAD_LIMIT = 64 * 1024;
const BODY_LIMIT = 512 * 1024 * 1024;

interface Parsed {
  request: Request;
  /** Bytes of the buffer this request used. */
  used: number;
  close: boolean;
}

class BadRequest extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Decodes a chunked body starting at `from`; null while the last chunk has not arrived. */
function dechunk(buffer: Buffer, from: number): { body: Buffer; end: number } | null {
  const parts: Buffer[] = [];
  let at = from;
  for (;;) {
    const line = buffer.indexOf('\r\n', at, 'latin1');
    if (line < 0) return null;
    const size = parseInt(buffer.toString('latin1', at, line), 16);
    if (Number.isNaN(size) || size < 0) throw new BadRequest(400, 'a chunk size is not hexadecimal');
    at = line + 2;
    if (size === 0) {
      // Trailer lines, then the blank line that ends the body.
      for (;;) {
        const next = buffer.indexOf('\r\n', at, 'latin1');
        if (next < 0) return null;
        if (next === at) return { body: parts.length === 1 ? parts[0] : Buffer.concat(parts), end: next + 2 };
        at = next + 2;
      }
    }
    if (at + size + 2 > buffer.length) return null;
    parts.push(buffer.subarray(at, at + size));
    at += size + 2;
  }
}

/**
 * Reads one request from the front of `buffer`, or returns null when more bytes are needed.
 * `onContinue` is called once when the client waits for "100 Continue" before sending its body.
 */
function parseRequest(buffer: Buffer, onContinue: () => void): Parsed | null {
  const headEnd = buffer.indexOf(HEAD_END);
  if (headEnd < 0) {
    if (buffer.length > HEAD_LIMIT) throw new BadRequest(431, 'the request head is too large');
    return null;
  }
  const head = buffer.toString('latin1', 0, headEnd);
  const firstEnd = head.indexOf('\r\n');
  const first = firstEnd < 0 ? head : head.slice(0, firstEnd);
  const a = first.indexOf(' ');
  const b = first.lastIndexOf(' ');
  if (a <= 0 || b <= a) throw new BadRequest(400, 'the request line is malformed');
  const version = first.slice(b + 1);
  if (!version.startsWith('HTTP/1.')) throw new BadRequest(400, 'only HTTP/1.x is served');
  const headers: Record<string, string> = {};
  let at = firstEnd < 0 ? head.length : firstEnd + 2;
  while (at < head.length) {
    let end = head.indexOf('\r\n', at);
    if (end < 0) end = head.length;
    const colon = head.indexOf(':', at);
    if (colon > at && colon < end) {
      const name = head.slice(at, colon).toLowerCase();
      const value = head.slice(colon + 1, end).trim();
      headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
    }
    at = end + 2;
  }
  const bodyStart = headEnd + 4;
  let body: Buffer = EMPTY;
  let used = bodyStart;
  const encoding = headers['transfer-encoding'];
  if (encoding !== undefined && /chunked/i.test(encoding)) {
    if (headers.expect !== undefined && buffer.length === bodyStart) onContinue();
    const chunked = dechunk(buffer, bodyStart);
    if (chunked === null) {
      if (buffer.length > BODY_LIMIT) throw new BadRequest(413, 'the request body is too large');
      return null;
    }
    body = chunked.body;
    used = chunked.end;
  } else {
    const length = headers['content-length'];
    if (length !== undefined) {
      const size = Number(length);
      if (!Number.isInteger(size) || size < 0) throw new BadRequest(400, 'Content-Length is not a whole number');
      if (size > BODY_LIMIT) throw new BadRequest(413, 'the request body is too large');
      if (buffer.length < bodyStart + size) {
        if (headers.expect !== undefined && buffer.length === bodyStart) onContinue();
        return null;
      }
      body = buffer.subarray(bodyStart, bodyStart + size);
      used = bodyStart + size;
    }
  }
  const connection = (headers.connection ?? '').toLowerCase();
  return {
    request: { method: first.slice(0, a), url: first.slice(a + 1, b), headers, body },
    used,
    close: connection === 'close' || (version === 'HTTP/1.0' && connection !== 'keep-alive'),
  };
}

/** Writes a reply; `headOnly` (the answer to a HEAD request) sends the headers and no body. */
function writeReply(socket: Socket, reply: Reply, close: boolean, headOnly = false): void {
  const reason = REASONS[reply.status] ?? 'Status';
  const body = reply.body;
  const length = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
  const head = `HTTP/1.1 ${reply.status} ${reason}\r\n${reply.head}content-length: ${length}\r\n${close ? 'connection: close\r\n' : ''}\r\n`;
  if (headOnly) socket.write(head, 'latin1');
  else if (typeof body === 'string') socket.write(head + body);
  else if (length === 0) socket.write(head, 'latin1');
  else {
    socket.cork();
    socket.write(head, 'latin1');
    socket.write(body);
    socket.uncork();
  }
}

function plain(status: number, message: string): Reply {
  return { status, head: 'content-type: application/json; charset=utf-8\r\n', body: JSON.stringify({ message }) };
}

/** Serves one connection: requests are answered in the order they arrive, one at a time. */
function attach(socket: Socket, handler: Handler): void {
  let pending: Buffer = EMPTY;
  let busy = false;
  let continued = false;
  socket.setNoDelay(true);

  const pump = (): void => {
    while (!busy && pending.length > 0 && !socket.destroyed) {
      let parsed: Parsed | null;
      try {
        parsed = parseRequest(pending, () => {
          if (!continued) {
            continued = true;
            socket.write('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');
          }
        });
      } catch (err) {
        writeReply(socket, plain(err instanceof BadRequest ? err.status : 400, err instanceof Error ? err.message : 'Bad Request'), true);
        socket.end();
        pending = EMPTY;
        return;
      }
      if (parsed === null) return;
      continued = false;
      // The request's bytes are copied out only when more data follows them in the buffer.
      const rest = pending.length === parsed.used ? EMPTY : pending.subarray(parsed.used);
      pending = rest;
      const close = parsed.close;
      // HEAD is GET without the body: the handler sees a GET, and only the headers go back.
      const headOnly = parsed.request.method === 'HEAD';
      if (headOnly) parsed.request.method = 'GET';
      const finish = (reply: Reply): void => {
        if (socket.destroyed) return;
        writeReply(socket, reply, close, headOnly);
        if (close) socket.end();
      };
      let result: Reply | Promise<Reply>;
      try {
        result = handler(parsed.request);
      } catch (err) {
        finish(plain(500, err instanceof Error ? err.message : 'Server Error'));
        continue;
      }
      if (result instanceof Promise) {
        busy = true;
        result.then(finish, (err: unknown) => finish(plain(500, err instanceof Error ? err.message : 'Server Error'))).finally(() => {
          busy = false;
          pump();
        });
        return;
      }
      finish(result);
      if (close) return;
    }
  };

  socket.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    pump();
  });
  socket.on('error', () => socket.destroy());
}

/** A TCP server speaking HTTP/1.1 to `handler`; the caller listens. */
export function serveHttp(handler: Handler): Server {
  return createServer({ noDelay: true, keepAlive: true }, (socket) => attach(socket, handler));
}
