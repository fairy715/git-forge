// Git's object model, held in memory: blobs, trees, commits and annotated tags addressed by the
// SHA-1 of "<type> <size>\0<bytes>". One store serves every repository (ids are content
// addresses, so sharing is safe); each repository only holds refs into it.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
  /** The zlib stream of `data`, made the first time a pack needs it and kept. */
  packed: Buffer | null;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export const ZERO_OID = '0'.repeat(40);

const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value);
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`);
  hash.update(data);
  return hash.digest('hex');
}

const objects = new Map<string, GitObject>();

/** Stores an object and returns its id; storing the same bytes twice keeps the first copy. */
export function putObject(type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data, packed: null });
  return oid;
}

/** Stores an object whose id the caller already computed (a pack reader does). */
export function putObjectAs(oid: string, type: ObjectType, data: Buffer): void {
  if (!objects.has(oid)) objects.set(oid, { type, data, packed: null });
}

export function getObject(oid: string): GitObject | undefined {
  return objects.get(oid);
}

export function hasObject(oid: string): boolean {
  return objects.has(oid);
}

/** The object's zlib stream, as a pack carries it. */
export function packedBytes(object: GitObject): Buffer {
  if (object.packed === null) object.packed = deflateSync(object.data, { level: 1 });
  return object.packed;
}

// ---- trees ------------------------------------------------------------------------------------

const treeCache = new Map<string, TreeEntry[]>();

/** A tree's entries, in the order the tree stores them. The result is shared: do not change it. */
export function readTree(oid: string): TreeEntry[] {
  const cached = treeCache.get(oid);
  if (cached !== undefined) return cached;
  const object = objects.get(oid);
  if (object === undefined || object.type !== 'tree') throw new Error(`not a tree: ${oid}`);
  const entries = parseTree(object.data);
  treeCache.set(oid, entries);
  return entries;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 20 > data.length) throw new Error('malformed tree');
    entries.push({
      mode: data.toString('ascii', at, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    at = nul + 21;
  }
  return entries;
}

export function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Git orders tree entries by name, a directory sorting as if its name ended in "/". */
function treeOrder(a: TreeEntry, b: TreeEntry): number {
  const x = Buffer.from(isDirMode(a.mode) ? `${a.name}/` : a.name, 'utf8');
  const y = Buffer.from(isDirMode(b.mode) ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(x, y);
}

/** Writes a tree from entries in any order and returns its id. */
export function writeTree(entries: TreeEntry[]): string {
  const sorted = [...entries].sort(treeOrder);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${isDirMode(entry.mode) ? '40000' : entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.oid, 'hex'));
  }
  const oid = putObject('tree', Buffer.concat(parts));
  if (!treeCache.has(oid)) treeCache.set(oid, sorted);
  return oid;
}

/** The empty tree, the root of a repository with no files. */
export function emptyTree(): string {
  return writeTree([]);
}

// ---- commits and tags -------------------------------------------------------------------------

const commitCache = new Map<string, Commit>();

export function readCommit(oid: string): Commit {
  const cached = commitCache.get(oid);
  if (cached !== undefined) return cached;
  const object = objects.get(oid);
  if (object === undefined || object.type !== 'commit') throw new Error(`not a commit: ${oid}`);
  const commit = parseCommit(object.data);
  commitCache.set(oid, commit);
  return commit;
}

export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const commit: Commit = { tree: '', parents: [], author: '', committer: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5);
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7));
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

/** Writes a commit; `who` is "Name <email>" and `when` seconds since the epoch (UTC). */
export function writeCommit(tree: string, parents: string[], who: string, when: number, message: string): string {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who} ${when} +0000`, `committer ${who} ${when} +0000`, '', message.endsWith('\n') ? message : `${message}\n`);
  return putObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** The object a tag object names, and that object's type, or null when the bytes are no tag. */
export function tagTarget(data: Buffer): { oid: string; type: string } | null {
  const text = data.toString('utf8');
  const object = /^object ([0-9a-f]{40})$/m.exec(text);
  const type = /^type (\w+)$/m.exec(text);
  return object === null ? null : { oid: object[1], type: type === null ? 'commit' : type[1] };
}

/** Follows annotated tags down to what they finally name (usually a commit). */
export function peel(oid: string): string {
  let at = oid;
  for (let hop = 0; hop < 8; hop += 1) {
    const object = objects.get(at);
    if (object === undefined || object.type !== 'tag') return at;
    const target = tagTarget(object.data);
    if (target === null) return at;
    at = target.oid;
  }
  return at;
}

/** The commit a ref value leads to, or null when it leads to no commit this store holds. */
export function commitOf(oid: string): string | null {
  const peeled = peel(oid);
  const object = objects.get(peeled);
  return object !== undefined && object.type === 'commit' ? peeled : null;
}

/** The seconds-since-epoch a commit's committer line carries. */
export function commitTime(commit: Commit): number {
  const match = /> (\d+) [+-]\d{4}$/.exec(commit.committer);
  return match === null ? 0 : Number(match[1]);
}

/** Whether `ancestor` is `descendant` or one of its ancestors. */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const at = queue.pop() as string;
    const object = objects.get(at);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of readCommit(at).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** Every commit reachable from `tip`, newest first by walking first parents then the rest. */
export function history(tip: string, limit = Infinity): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const at = queue.shift() as string;
    if (seen.has(at)) continue;
    seen.add(at);
    const object = objects.get(at);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(at);
    for (const parent of readCommit(at).parents) if (!seen.has(parent)) queue.push(parent);
  }
  return out;
}

/** A best common ancestor of two commits, or null when their histories never meet. */
export function mergeBase(a: string, b: string): string | null {
  const mine = new Set(history(a));
  for (const oid of history(b)) if (mine.has(oid)) return oid;
  return null;
}
