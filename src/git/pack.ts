// Packfiles: reading the pack a push carries (whole objects and both delta forms, bases found in
// the pack or already in the store) and writing the pack a fetch answers with (whole objects only,
// each a cached zlib stream, so building one is mostly a concatenation).

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { getObject, hashObject, packedBytes, putObjectAs, type ObjectType } from './objects.ts';

const TYPE_OF_CODE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_OF_TYPE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OFS_DELTA = 6;
const REF_DELTA = 7;

export class PackError extends Error {}

/** Inflates the zlib stream at `offset` and says where the next entry begins. */
function inflateAt(pack: Buffer, offset: number, size: number): { data: Buffer; next: number } {
  // `info` exposes the engine, whose bytesWritten is how much input the stream consumed.
  const result = inflateSync(pack.subarray(offset), { info: true, maxOutputLength: Math.max(size, 1) + 64 }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (result.buffer.length !== size) throw new PackError(`an object inflated to ${result.buffer.length} bytes, its header says ${size}`);
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
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
      const { data, next } = inflateAt(bytes, at, size);
      pending.push({ offset: start, delta: data, baseOffset: start - back, baseOid: '' });
      at = next;
    } else if (code === REF_DELTA) {
      const baseOid = bytes.toString('hex', at, at + 20);
      at += 20;
      const { data, next } = inflateAt(bytes, at, size);
      pending.push({ offset: start, delta: data, baseOffset: -1, baseOid });
      at = next;
    } else {
      const type = TYPE_OF_CODE[code];
      if (type === undefined) throw new PackError(`object type ${code} is not a git object`);
      const { data, next } = inflateAt(bytes, at, size);
      resolved.set(start, { type, data });
      putObjectAs(hashObject(type, data), type, data);
      at = next;
    }
  }
  if (at !== trailer) throw new PackError('the pack holds bytes after its last object');
  const sum = createHash('sha1').update(bytes.subarray(0, trailer)).digest();
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
