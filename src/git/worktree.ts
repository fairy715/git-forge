// Working with trees by path, without ever checking files out: look a path up, write or remove
// one file (building the new trees up to a new root), list a directory, compare two trees, and
// merge two trees against their common ancestor.

import { emptyTree, getObject, isDirMode, putObject, readTree, writeTree, type TreeEntry } from './objects.ts';

export interface Found {
  mode: string;
  oid: string;
}

function segments(path: string): string[] {
  return path.split('/').filter((part) => part !== '');
}

/** The entry at `path` under the tree, or null. The empty path is the tree itself. */
export function lookupPath(tree: string, path: string): Found | null {
  let at: Found = { mode: '40000', oid: tree };
  for (const name of segments(path)) {
    if (!isDirMode(at.mode)) return null;
    const entry = readTree(at.oid).find((candidate) => candidate.name === name);
    if (entry === undefined) return null;
    at = { mode: entry.mode, oid: entry.oid };
  }
  return at;
}

/**
 * The root tree after `path` is set to the blob `oid` (or removed when `oid` is null). Directories
 * are created as needed and a directory left empty is dropped. Returns null when a removal names a
 * path that is not there, or a write would put a file under a file.
 */
export function writePath(tree: string, path: string, oid: string | null, mode = '100644'): string | null {
  const parts = segments(path);
  if (parts.length === 0) return null;
  const step = (current: string | null, depth: number): string | null | undefined => {
    const entries: TreeEntry[] = current === null ? [] : [...readTree(current)];
    const name = parts[depth];
    const index = entries.findIndex((entry) => entry.name === name);
    if (depth === parts.length - 1) {
      if (oid === null) {
        if (index < 0) return undefined;
        entries.splice(index, 1);
      } else if (index < 0) entries.push({ mode, name, oid });
      else entries[index] = { mode: isDirMode(entries[index].mode) ? mode : entries[index].mode, name, oid };
    } else {
      const child = index < 0 ? null : entries[index];
      if (child !== null && !isDirMode(child.mode)) {
        if (oid === null) return undefined;
        // A file stands where a directory is needed: the write replaces it with the directory.
        entries.splice(index, 1);
      }
      const below = step(child !== null && isDirMode(child.mode) ? child.oid : null, depth + 1);
      if (below === undefined) return undefined;
      const at = entries.findIndex((entry) => entry.name === name);
      if (below === null) {
        if (at >= 0) entries.splice(at, 1);
      } else if (at < 0) entries.push({ mode: '40000', name, oid: below });
      else entries[at] = { mode: '40000', name, oid: below };
    }
    return entries.length === 0 ? null : writeTree(entries);
  };
  const root = step(tree, 0);
  if (root === undefined) return null;
  return root === null ? emptyTree() : root;
}

/** Every file under the tree, by full path. */
export function flatten(tree: string, prefix = '', out: Map<string, Found> = new Map()): Map<string, Found> {
  for (const entry of readTree(tree)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isDirMode(entry.mode)) flatten(entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

export interface Change {
  path: string;
  status: 'added' | 'removed' | 'modified';
  before: string | null;
  after: string | null;
}

/** The files that differ between two trees, by path, skipping identical subtrees whole. */
export function diffTrees(before: string | null, after: string | null, prefix = '', out: Change[] = []): Change[] {
  if (before === after) return out;
  const left = new Map<string, TreeEntry>();
  const right = new Map<string, TreeEntry>();
  if (before !== null) for (const entry of readTree(before)) left.set(entry.name, entry);
  if (after !== null) for (const entry of readTree(after)) right.set(entry.name, entry);
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  for (const name of names) {
    const a = left.get(name);
    const b = right.get(name);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const aDir = a !== undefined && isDirMode(a.mode);
    const bDir = b !== undefined && isDirMode(b.mode);
    if (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode) continue;
    if (aDir || bDir) {
      diffTrees(aDir ? (a as TreeEntry).oid : null, bDir ? (b as TreeEntry).oid : null, path, out);
      if (a !== undefined && !aDir) out.push({ path, status: 'removed', before: a.oid, after: null });
      if (b !== undefined && !bDir) out.push({ path, status: 'added', before: null, after: b.oid });
    } else if (a === undefined) out.push({ path, status: 'added', before: null, after: (b as TreeEntry).oid });
    else if (b === undefined) out.push({ path, status: 'removed', before: a.oid, after: null });
    else out.push({ path, status: 'modified', before: a.oid, after: b.oid });
  }
  return out;
}

/**
 * Merges `theirs` into `ours`, both descended from `base`: a path changed on one side takes that
 * side, a path changed the same way on both is kept, and a path changed differently on both is a
 * conflict. Returns the merged root tree, or null on any conflict.
 */
export function mergeTrees(base: string | null, ours: string, theirs: string): string | null {
  if (ours === theirs || base === theirs) return ours;
  if (base === ours) return theirs;
  const baseFiles = base === null ? new Map<string, Found>() : flatten(base);
  const ourFiles = flatten(ours);
  const theirFiles = flatten(theirs);
  let merged = ours;
  for (const path of new Set([...baseFiles.keys(), ...theirFiles.keys()])) {
    const was = baseFiles.get(path)?.oid ?? null;
    const mine = ourFiles.get(path)?.oid ?? null;
    const yours = theirFiles.get(path)?.oid ?? null;
    if (yours === was || yours === mine) continue;
    if (mine !== was) return null;
    const next = writePath(merged, path, yours, theirFiles.get(path)?.mode ?? '100644');
    if (next === null) return null;
    merged = next;
  }
  return merged;
}

// ---- line counts ------------------------------------------------------------------------------

function linesOf(oid: string | null): string[] {
  if (oid === null) return [];
  const object = getObject(oid);
  if (object === undefined || object.data.length === 0) return [];
  const text = object.data.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * How many lines a change adds and deletes: the two files' lines less their longest common
 * subsequence, found with Myers' greedy search (bounded; a pair too different to search counts
 * every line as changed).
 */
export function lineCounts(before: string | null, after: string | null): { additions: number; deletions: number } {
  const a = linesOf(before);
  const b = linesOf(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n === 0 || m === 0) return { additions: m, deletions: n };
  const max = Math.min(n + m, 2000);
  const offset = max + 1;
  const reach = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && reach[offset + k - 1] < reach[offset + k + 1]) ? reach[offset + k + 1] : reach[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[head + x] === b[head + y]) {
        x += 1;
        y += 1;
      }
      reach[offset + k] = x;
      if (x >= n && y >= m) return { additions: (d + m - n) / 2, deletions: (d + n - m) / 2 };
    }
  }
  return { additions: m, deletions: n };
}

/** Stores file bytes as a blob and returns its id. */
export function writeBlob(data: Buffer): string {
  return putObject('blob', data);
}
