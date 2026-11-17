// Packfiles: reading the pack a push carries (whole objects and both delta forms, bases found in
// the pack or already in the store) and writing the pack a fetch answers with (whole objects only,
// each a cached zlib stream, so building one is mostly a concatenation).

import { createHash, hash } from 'node:crypto';
import { constants, deflateSync, Inflate, inflateSync } from 'node:zlib';
import { getObject, hashObject, packedBytes, putObjectAs, type ObjectType } from './objects.ts';

const TYPE_OF_CODE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_OF_TYPE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OFS_DELTA = 6;
const REF_DELTA = 7;

export class PackError extends Error {}

// ---- inflating --------------------------------------------------------------------------------
//
// A pack is one zlib stream per object, and a push of a small change carries three of them. Node's
// inflateSync builds a new engine (a native handle and a 16 KiB buffer) for every call, which costs
// several times the inflating itself, so the streams are fed to one engine kept for the purpose,
// through the same calls inflateSync makes on its own. Those calls are not public API: the engine
// is tried on a known stream when the module loads, and if it does not behave exactly as expected
// every stream goes through inflateSync instead.

interface Engine {
  _handle: { writeSync(flush: number, input: Buffer, inAt: number, inLength: number, output: Buffer, outAt: number, outLength: number): void; reset(): void } | null;
  /** After a write: [bytes of output space left, bytes of input left]. */
  _writeState: Uint32Array;
  on(event: 'error', listener: (err: Error) => void): void;
}

let engine: Engine | null = null;

function engineOf(): Engine {
  if (engine === null || engine._handle === null) {
    engine = new Inflate() as unknown as Engine;
    // A bad stream is reported here as well as through the state read below.
    engine.on('error', () => {});
  }
  return engine;
}

/**
 * Inflates the stream at `offset` into `out` from `outAt`, which must have room for `size` bytes
 * and one more (the spare byte shows a stream that holds more than `size`). Returns the offset of
 * the byte after the stream.
 */
function inflateInto(pack: Buffer, offset: number, size: number, out: Buffer, outAt: number): number {
  const kept = engineOf();
  const handle = kept._handle;
  if (handle === null) throw new PackError('the inflater is closed');
  const available = pack.length - offset;
  handle.writeSync(constants.Z_FINISH, pack, offset, available, out, outAt, size + 1);
  const outLeft = kept._writeState[0];
  const inLeft = kept._writeState[1];
  if (kept._handle === null) throw new PackError('an object is not a zlib stream');
  handle.reset();
  if (outLeft !== 1) throw new PackError(`an object did not inflate to the ${size} bytes its header says`);
  return offset + available - inLeft;
}

/** Whether the kept engine inflates a known stream, and reports what it used, as it must. */
function engineWorks(): boolean {
  try {
    const plain = Buffer.from('the forge checks its inflater on this line, twice over\n'.repeat(3), 'latin1');
    const stream = deflateSync(plain);
    const input = Buffer.concat([Buffer.alloc(5, 1), stream, Buffer.alloc(7, 2)]);
    for (let round = 0; round < 2; round += 1) {
      const out = Buffer.alloc(plain.length + 3);
      if (inflateInto(input, 5, plain.length, out, 2) !== 5 + stream.length) return false;
      if (!out.subarray(2, 2 + plain.length).equals(plain) || out[0] !== 0 || out[1] !== 0) return false;
    }
    // A stream longer than its stated size, and one cut short, must both be refused.
    for (const [bytes, size] of [[input, plain.length - 1], [input.subarray(0, 5 + stream.length - 6), plain.length]] as const) {
      let refused = false;
      try {
        inflateInto(bytes, 5, size, Buffer.alloc(plain.length + 3), 0);
      } catch {
        refused = true;
      }
      if (!refused) return false;
    }
    const out = Buffer.alloc(plain.length + 1);
    return inflateInto(input, 5, plain.length, out, 0) === 5 + stream.length && out.subarray(0, plain.length).equals(plain);
  } catch {
    return false;
  }
}

const KEPT_ENGINE = engineWorks();

/** The most a zlib stream can grow: a stated size beyond this is not worth a buffer. */
const MAX_INFLATE_RATIO = 1100;

/**
 * Inflates the zlib stream at `offset`, which must hold exactly `size` bytes, after `lead` bytes
 * left free at the front of the returned buffer (for an object header). Says where the next entry
 * begins.
 */
function inflateAt(pack: Buffer, offset: number, size: number, lead = 0): { buffer: Buffer; next: number } {
  if (size > (pack.length - offset) * MAX_INFLATE_RATIO + 64) throw new PackError('an object states a size its bytes cannot hold');
  if (KEPT_ENGINE) {
    const buffer = Buffer.allocUnsafe(lead + size + 1);
    const next = inflateInto(pack, offset, size, buffer, lead);
    return { buffer: buffer.subarray(0, lead + size), next };
  }
  // `info` exposes the engine, whose bytesWritten is how much input the stream consumed.
  const result = inflateSync(pack.subarray(offset), { info: true, maxOutputLength: Math.max(size, 1) + 64 }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (result.buffer.length !== size) throw new PackError(`an object inflated to ${result.buffer.length} bytes, its header says ${size}`);
  const buffer = lead === 0 ? result.buffer : Buffer.concat([Buffer.alloc(lead), result.buffer]);
  return { buffer, next: offset + result.engine.bytesWritten };
}

/** Rebuilds an object from its base and a delta (copy and insert instructions). */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const baseSize = varint();
  const outSize = varint();
  if (baseSize !== base.length) throw new PackError('a delta names a base of the wrong size');
  const out = Buffer.allocUnsafe(outSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++];
    if (op & 0x80) {
      let offset = 0;
      let length = 0;
      if (op & 0x01) offset = delta[at++];
      if (op & 0x02) offset |= delta[at++] << 8;
      if (op & 0x04) offset |= delta[at++] << 16;
      if (op & 0x08) offset += delta[at++] * 0x1000000;
      if (op & 0x10) length = delta[at++];
      if (op & 0x20) length |= delta[at++] << 8;
      if (op & 0x40) length |= delta[at++] << 16;
      if (length === 0) length = 0x10000;
      if (offset + length > base.length || written + length > outSize) throw new PackError('a delta copies outside its base');
      base.copy(out, written, offset, offset + length);
      written += length;
    } else if (op > 0) {
      if (at + op > delta.length || written + op > outSize) throw new PackError('a delta inserts past its end');
      delta.copy(out, written, at, at + op);
      at += op;
      written += op;
    } else {
      throw new PackError('a delta holds a reserved instruction');
    }
  }
  if (written !== outSize) throw new PackError('a delta built an object of the wrong size');
  return out;
}

interface Pending {
  offset: number;
  delta: Buffer;
  baseOffset: number;
  baseOid: string;
}

/**
 * Reads the pack in `bytes` and stores every object in it. A delta may sit before its base, so
 * deltas are resolved after the pass, each once its base is known. Returns how many objects the
 * pack held.
 */
export function ingestPack(bytes: Buffer): number {
  if (bytes.length < 32 || bytes.toString('ascii', 0, 4) !== 'PACK') throw new PackError('not a packfile');
  const version = bytes.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`pack version ${version} is not supported`);
  const count = bytes.readUInt32BE(8);
  const trailer = bytes.length - 20;
  const resolved = new Map<number, { type: ObjectType; data: Buffer }>();
  const pending: Pending[] = [];
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    if (at >= trailer) throw new PackError('the pack ends before its last object');
    const start = at;
    let byte = bytes[at++];
    const code = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = bytes[at++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (code === OFS_DELTA) {
      byte = bytes[at++];
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = bytes[at++];
        back = (back + 1) * 128 + (byte & 0x7f);
      }
      const { buffer, next } = inflateAt(bytes, at, size);
      pending.push({ offset: start, delta: buffer, baseOffset: start - back, baseOid: '' });
      at = next;
    } else if (code === REF_DELTA) {
      const baseOid = bytes.toString('hex', at, at + 20);
      at += 20;
      const { buffer, next } = inflateAt(bytes, at, size);
      pending.push({ offset: start, delta: buffer, baseOffset: -1, baseOid });
      at = next;
    } else {
      const type = TYPE_OF_CODE[code];
      if (type === undefined) throw new PackError(`object type ${code} is not a git object`);
      // The object is inflated behind its own header ("blob 1024\0"), so that its id is one hash
      // of one buffer.
      const header = `${type} ${size}\0`;
      const { buffer, next } = inflateAt(bytes, at, size, header.length);
      buffer.write(header, 0, 'latin1');
      const data = buffer.subarray(header.length);
      resolved.set(start, { type, data });
      putObjectAs(hash('sha1', buffer, 'hex'), type, data);
      at = next;
    }
  }
  if (at !== trailer) throw new PackError('the pack holds bytes after its last object');
  const sum = hash('sha1', bytes.subarray(0, trailer), 'buffer');
  if (!sum.equals(bytes.subarray(trailer))) throw new PackError('the pack checksum does not match');

  let left = pending;
  while (left.length > 0) {
    const waiting: Pending[] = [];
    for (const entry of left) {
      const base = entry.baseOffset >= 0 ? resolved.get(entry.baseOffset) : getObject(entry.baseOid);
      if (base === undefined) {
        waiting.push(entry);
        continue;
      }
      const data = applyDelta(base.data, entry.delta);
      resolved.set(entry.offset, { type: base.type, data });
      putObjectAs(hashObject(base.type, data), base.type, data);
    }
    if (waiting.length === left.length) throw new PackError('a delta names a base that is neither in the pack nor in the repository');
    left = waiting;
  }
  return count;
}

/** A pack of the given objects, whole (no deltas), with its trailing checksum. */
export function buildPack(oids: Iterable<string>): Buffer {
  const parts: Buffer[] = [Buffer.alloc(12)];
  let count = 0;
  for (const oid of oids) {
    const object = getObject(oid);
    if (object === undefined) throw new PackError(`cannot pack the unknown object ${oid}`);
    let size = object.data.length;
    const header: number[] = [];
    let first = (CODE_OF_TYPE[object.type] << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    while (size > 0) {
      header.push(first | 0x80);
      first = size & 0x7f;
      size = Math.floor(size / 128);
    }
    header.push(first);
    parts.push(Buffer.from(header), packedBytes(object));
    count += 1;
  }
  parts[0].write('PACK', 0, 'ascii');
  parts[0].writeUInt32BE(2, 4);
  parts[0].writeUInt32BE(count, 8);
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
