// HTTP/1.1 straight on TCP sockets. The forge answers many small requests one after another, and
// node:http's per-request machinery (streams, header objects, timers) costs several times what
// the handlers do, so this serves the subset the forge needs itself: request line and headers,
// bodies by Content-Length or chunked encoding, Expect: 100-continue, HEAD, keep-alive with
// pipelining in order, and replies that always carry a Content-Length and leave in a single write.
//
// A request that only reads is answered again from the bytes of its last reply while nothing has
// changed: the request's own bytes are the key, so a repeat is recognised before it is parsed.

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
  /** Set when the same request would get the same reply until the forge's state next changes. */
  repeatable?: boolean;
}

/**
 * The one field of a reply that differs between two sendings of it (the request id): where it sits
 * in a reply's bytes (-1 when the reply has none), and how to write the next value there.
 */
export interface Stamp {
  locate(reply: Buffer): number;
  refresh(reply: Buffer, at: number): void;
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
/** A binary reply body up to this size is copied behind its head and sent as one buffer. */
const SMALL_BODY = 16 * 1024;

// ---- replies kept for repeats ------------------------------------------------------------------

/** Requests longer than this are not looked up (the ones that repeat are short). */
const REPEAT_REQUEST_LIMIT = 4096;
const REPEAT_REPLY_LIMIT = 256 * 1024;
const REPEAT_TOTAL_LIMIT = 32 * 1024 * 1024;
const REPEAT_COUNT_LIMIT = 4096;

interface Kept {
  bytes: Buffer;
  stampAt: number;
}

/** A request's bytes (as latin1 text) to the reply they last got; emptied on every change of state. */
const kept = new Map<string, Kept>();
let keptBytes = 0;

/** Drops every kept reply. Whatever changes what a read would answer calls this. */
export function forgetReplies(): void {
  if (kept.size === 0) return;
  kept.clear();
  keptBytes = 0;
}

function keep(key: string, bytes: Buffer, stamp: Stamp | null): void {
  if (bytes.length > REPEAT_REPLY_LIMIT) return;
  // Full: start over rather than choose what to drop (a change of state empties it anyway).
  if (kept.size >= REPEAT_COUNT_LIMIT || keptBytes + bytes.length > REPEAT_TOTAL_LIMIT) forgetReplies();
  kept.set(key, { bytes, stampAt: stamp === null ? -1 : stamp.locate(bytes) });
  keptBytes += bytes.length;
}

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

/**
 * Writes a reply; `headOnly` (the answer to a HEAD request) sends the headers and no body. With
 * `whole` the reply goes out as one buffer, which is returned so that it can be sent again.
 */
function writeReply(socket: Socket, reply: Reply, close: boolean, headOnly = false, whole = false): Buffer | null {
  const reason = REASONS[reply.status] ?? 'Status';
  const body = reply.body;
  const length = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
  const head = `HTTP/1.1 ${reply.status} ${reason}\r\n${reply.head}content-length: ${length}\r\n${close ? 'connection: close\r\n' : ''}\r\n`;
  if (whole) {
    let bytes: Buffer;
    if (headOnly || length === 0) bytes = Buffer.from(head, 'latin1');
    else if (typeof body === 'string') bytes = Buffer.from(head + body, 'utf8');
    else bytes = Buffer.concat([Buffer.from(head, 'latin1'), body]);
    socket.write(bytes);
    return bytes;
  }
  if (headOnly) socket.write(head, 'latin1');
  else if (typeof body === 'string') socket.write(head + body);
  else if (length === 0) socket.write(head, 'latin1');
  else if (length <= SMALL_BODY) {
    // One buffer and one write: copying a small body costs less than a second queued write.
    const bytes = Buffer.allocUnsafe(head.length + length);
    bytes.write(head, 0, 'latin1');
    body.copy(bytes, head.length);
    socket.write(bytes);
  } else {
    socket.cork();
    socket.write(head, 'latin1');
    socket.write(body);
    socket.uncork();
  }
  return null;
}

function plain(status: number, message: string): Reply {
  return { status, head: 'content-type: application/json; charset=utf-8\r\n', body: JSON.stringify({ message }) };
}

/** Serves one connection: requests are answered in the order they arrive, one at a time. */
function attach(socket: Socket, handler: Handler, stamp: Stamp | null): void {
  let pending: Buffer = EMPTY;
  let busy = false;
  let continued = false;
  socket.setNoDelay(true);

  // `key` is the text of the chunk being pumped when that chunk may be one whole request.
  const pump = (key: string | null): void => {
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
      // The key names this request only when the request is all there was.
      const name = rest === EMPTY ? key : null;
      key = null;
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
          pump(null);
        });
        return;
      }
      if (name !== null && result.repeatable === true && !close && !socket.destroyed) {
        const bytes = writeReply(socket, result, false, headOnly, true);
        if (bytes !== null) keep(name, bytes, stamp);
        continue;
      }
      finish(result);
      if (close) return;
    }
  };

  socket.on('data', (chunk: Buffer) => {
    let key: string | null = null;
    if (pending.length === 0 && !busy && chunk.length <= REPEAT_REQUEST_LIMIT) {
      key = chunk.toString('latin1');
      const again = kept.get(key);
      if (again !== undefined) {
        if (stamp !== null && again.stampAt >= 0) stamp.refresh(again.bytes, again.stampAt);
        socket.write(again.bytes);
        return;
      }
    }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    pump(key);
  });
  socket.on('error', () => socket.destroy());
}

/** A TCP server speaking HTTP/1.1 to `handler`; the caller listens. `stamp` refreshes a repeated reply. */
export function serveHttp(handler: Handler, stamp: Stamp | null = null): Server {
  return createServer({ noDelay: true, keepAlive: true }, (socket) => attach(socket, handler, stamp));
}
