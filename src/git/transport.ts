// Git's smart-HTTP protocol, server side: the ref advertisements (v0 and v2), upload-pack (v2
// ls-refs and fetch, plus the v0 fetch a client without v2 falls back to) with shallow clones and
// deepening, and receive-pack (v0) with per-ref fast-forward checks and a side-band report.

import { createHash } from 'node:crypto';
import { getObject, hasObject, isAncestor, isDirMode, isOid, peel, readCommit, readTree, tagTarget, ZERO_OID } from './objects.ts';
import { buildPack, ingestPack } from './pack.ts';
import { dropRef, headBranch, nowIso, setRef, type Repo } from '../store.ts';

const AGENT = 'agent=git-forge/1.0';
const UPLOAD_CAPS_V0 = `side-band-64k shallow no-progress ofs-delta object-format=sha1 ${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta object-format=sha1 ${AGENT}`;
/** The most data one side-band packet carries: a 65520-byte pkt-line less its length and band. */
const BAND_CHUNK = 65515;

export class GitRequestError extends Error {}

// ---- pkt-lines --------------------------------------------------------------------------------

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii'), body]);
}

interface Packets {
  /** Each data line without its trailing newline; 'flush' and 'delim' mark the control packets. */
  lines: (string | 'flush' | 'delim')[];
  /** Where the pkt-line stream stopped: the first byte after the flush that ended it. */
  end: number;
}

/**
 * Reads pkt-lines from `bytes` up to and including the `flushes`-th flush (or the end). A length
 * that is not four hex digits, or that runs past the buffer, is a malformed request.
 */
function readPackets(bytes: Buffer, flushes: number): Packets {
  const lines: (string | 'flush' | 'delim')[] = [];
  let at = 0;
  let seen = 0;
  while (at < bytes.length) {
    const head = bytes.toString('ascii', at, at + 4);
    if (at + 4 > bytes.length || !/^[0-9a-f]{4}$/i.test(head)) throw new GitRequestError('malformed pkt-line length');
    const length = parseInt(head, 16);
    if (length === 0) {
      lines.push('flush');
      at += 4;
      seen += 1;
      if (seen >= flushes) break;
      continue;
    }
    if (length === 1) {
      lines.push('delim');
      at += 4;
      continue;
    }
    if (length < 4 || at + length > bytes.length) throw new GitRequestError('a pkt-line runs past the request body');
    lines.push(bytes.toString('utf8', at + 4, at + length).replace(/\n$/, ''));
    at += length;
  }
  return { lines, end: at };
}

/** `data` as side-band packets on `band`. */
function banded(band: number, data: Buffer, out: Buffer[]): void {
  for (let at = 0; at < data.length; at += BAND_CHUNK) {
    const chunk = data.subarray(at, Math.min(data.length, at + BAND_CHUNK));
    const head = Buffer.allocUnsafe(5);
    head.write((chunk.length + 5).toString(16).padStart(4, '0'), 0, 'ascii');
    head[4] = band;
    out.push(head, chunk);
  }
}

// ---- refs -------------------------------------------------------------------------------------

interface RefLine {
  name: string;
  oid: string;
  peeled: string | null;
}

function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const peeled = peel(oid);
    lines.push({ name, oid, peeled: peeled === oid ? null : peeled });
  }
  return lines;
}

function headOf(repo: Repo): { target: string; oid: string | null } {
  const target = `refs/heads/${headBranch(repo)}`;
  return { target, oid: repo.refs.get(target) ?? null };
}

/** GET info/refs: the v2 capability advertisement, or the v0 ref list with the service preamble. */
export function advertise(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): Buffer {
  if (service === 'git-upload-pack' && v2) {
    return Buffer.concat([pkt('version 2\n'), pkt(`${AGENT}\n`), pkt('ls-refs=unborn\n'), pkt('fetch=shallow\n'), pkt('object-format=sha1\n'), FLUSH]);
  }
  const out: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const head = headOf(repo);
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:${head.target}` : RECEIVE_CAPS;
  const lines: string[] = [];
  if (service === 'git-upload-pack' && head.oid !== null) lines.push(`${head.oid} HEAD`);
  for (const ref of refLines(repo)) {
    lines.push(`${ref.oid} ${ref.name}`);
    if (ref.peeled !== null) lines.push(`${ref.peeled} ${ref.name}^{}`);
  }
  if (lines.length === 0) out.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  else lines.forEach((line, index) => out.push(pkt(index === 0 ? `${line}\0${caps}\n` : `${line}\n`)));
  out.push(FLUSH);
  return Buffer.concat(out);
}

function lsRefs(repo: Repo, args: string[]): Buffer {
  const peeling = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice(11));
  const wanted = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  if (wanted('HEAD')) {
    const head = headOf(repo);
    const tail = symrefs ? ` symref-target:${head.target}` : '';
    if (head.oid !== null) out.push(pkt(`${head.oid} HEAD${tail}\n`));
    else if (unborn) out.push(pkt(`unborn HEAD${tail}\n`));
  }
  for (const ref of refLines(repo)) {
    if (!wanted(ref.name)) continue;
    out.push(pkt(`${ref.oid} ${ref.name}${peeling && ref.peeled !== null ? ` peeled:${ref.peeled}` : ''}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---- choosing what a fetch sends --------------------------------------------------------------

interface FetchAsk {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

interface FetchPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
  common: string[];
}

/** Adds a tree and everything under it to `into`, skipping what `skip` or `into` already holds. */
function addTree(tree: string, into: Set<string>, skip: Set<string> | null): void {
  if (into.has(tree) || (skip !== null && skip.has(tree))) return;
  if (!hasObject(tree)) return;
  into.add(tree);
  for (const entry of readTree(tree)) {
    if (isDirMode(entry.mode)) addTree(entry.oid, into, skip);
    else if (entry.mode !== '160000' && !(skip !== null && skip.has(entry.oid)) && hasObject(entry.oid)) into.add(entry.oid);
  }
}

function planFetch(ask: FetchAsk): FetchPlan {
  const clientShallow = new Set(ask.shallow);

  // What the client already holds: its haves and their history, cut at its shallow boundary.
  const heldCommits = new Set<string>();
  const common: string[] = [];
  const stack: string[] = [];
  for (const have of ask.haves) {
    const object = getObject(have);
    if (object === undefined) continue;
    common.push(have);
    stack.push(peel(have));
  }
  while (stack.length > 0) {
    const at = stack.pop() as string;
    if (heldCommits.has(at)) continue;
    const object = getObject(at);
    if (object === undefined || object.type !== 'commit') continue;
    heldCommits.add(at);
    if (!clientShallow.has(at)) for (const parent of readCommit(at).parents) stack.push(parent);
  }

  // The commits to deliver: the wants' history, to the asked depth, stopping at held commits.
  const send = new Set<string>();
  const sendCommits: string[] = [];
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const depthOf = new Map<string, number>();
  let frontier: string[] = [];
  for (const want of ask.wants) {
    let at = want;
    // An annotated tag is delivered along with what it names.
    for (let hop = 0; hop < 8; hop += 1) {
      const object = getObject(at);
      if (object === undefined || object.type !== 'tag') break;
      if (!ask.haves.includes(at)) send.add(at);
      const target = tagTarget(object.data);
      if (target === null) break;
      at = target.oid;
    }
    const object = getObject(at);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      if (!depthOf.has(at)) {
        depthOf.set(at, 1);
        frontier.push(at);
      }
    } else if (object.type === 'tree') addTree(at, send, null);
    else send.add(at);
  }
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const at of frontier) {
      const depth = depthOf.get(at) as number;
      const held = heldCommits.has(at);
      if (!held) sendCommits.push(at);
      const parents = readCommit(at).parents.filter((parent) => hasObject(parent));
      if (ask.depth !== null && depth >= ask.depth) {
        if (parents.length > 0) shallow.push(at);
        continue;
      }
      // Without a depth the walk stops at what the client holds; with one it runs to the depth,
      // since deepening reaches past the client's old boundary.
      if (held && ask.depth === null) continue;
      if (held && !clientShallow.has(at)) continue;
      for (const parent of parents) {
        if (depthOf.has(parent)) continue;
        depthOf.set(parent, depth + 1);
        next.push(parent);
      }
    }
    frontier = next;
  }
  if (ask.depth !== null) {
    const boundary = new Set(shallow);
    for (const oid of clientShallow) if (depthOf.has(oid) && !boundary.has(oid)) unshallow.push(oid);
  }

  // Trees and blobs the client holds are left out of the pack.
  const heldObjects = new Set<string>();
  if (sendCommits.length > 0) for (const commit of heldCommits) addTree(readCommit(commit).tree, heldObjects, null);
  for (const commit of sendCommits) {
    send.add(commit);
    addTree(readCommit(commit).tree, send, heldObjects);
  }
  return {
    objects: [...send],
    shallow: shallow.filter((oid) => !clientShallow.has(oid)),
    unshallow,
    common,
  };
}

// ---- upload-pack ------------------------------------------------------------------------------

const answers = new Map<string, Buffer>();
const ANSWER_CACHE_MAX = 64;

function fetchV2(args: string[]): Buffer {
  const ask: FetchAsk = { wants: [], haves: [], shallow: [], depth: null };
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) ask.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) ask.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) ask.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) ask.depth = Math.max(1, Number(arg.slice(7)) || 1);
    else if (arg === 'done') done = true;
  }
  for (const want of ask.wants) {
    if (!isOid(want) || !hasObject(want)) return Buffer.concat([pkt(`ERR upload-pack: not our ref ${want}\n`), FLUSH]);
  }
  const plan = planFetch(ask);
  const out: Buffer[] = [];
  if (!done) {
    out.push(pkt('acknowledgments\n'));
    if (plan.common.length === 0) out.push(pkt('NAK\n'));
    for (const oid of plan.common) out.push(pkt(`ACK ${oid}\n`));
    out.push(pkt('ready\n'), DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    out.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(DELIM);
  }
  out.push(pkt('packfile\n'));
  banded(1, buildPack(plan.objects), out);
  out.push(FLUSH);
  return Buffer.concat(out);
}

function fetchV0(lines: (string | 'flush' | 'delim')[]): Buffer {
  const ask: FetchAsk = { wants: [], haves: [], shallow: [], depth: null };
  let done = false;
  for (const line of lines) {
    if (line.startsWith('want ')) ask.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) ask.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) ask.shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) ask.depth = Math.max(1, Number(line.slice(7)) || 1);
    else if (line === 'done') done = true;
  }
  if (ask.wants.length === 0) return FLUSH;
  for (const want of ask.wants) {
    if (!isOid(want) || !hasObject(want)) return pkt(`ERR upload-pack: not our ref ${want}\n`);
  }
  const plan = planFetch(ask);
  const out: Buffer[] = [];
  if (ask.depth !== null) {
    for (const oid of plan.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(FLUSH);
  }
  if (!done) {
    out.push(pkt('NAK\n'));
    return Buffer.concat(out);
  }
  out.push(pkt(plan.common.length > 0 ? `ACK ${plan.common[plan.common.length - 1]}\n` : 'NAK\n'));
  banded(1, buildPack(plan.objects), out);
  out.push(FLUSH);
  return Buffer.concat(out);
}

/** POST git-upload-pack: a v2 command (ls-refs or fetch) or a v0 fetch negotiation. */
export function uploadPack(repo: Repo, body: Buffer, v2: boolean): Buffer {
  const key = `${repo.id}:${repo.version}:${v2 ? 2 : 0}:${createHash('sha1').update(body).digest('hex')}`;
  const cached = answers.get(key);
  if (cached !== undefined) return cached;
  const { lines } = readPackets(body, v2 ? 1 : 2);
  if (lines.length === 0) throw new GitRequestError('an empty upload-pack request');
  let answer: Buffer;
  const first = lines[0];
  if (typeof first === 'string' && first.startsWith('command=')) {
    const delim = lines.indexOf('delim');
    const args = (delim < 0 ? [] : lines.slice(delim + 1)).filter((line) => line !== 'flush' && line !== 'delim');
    if (first === 'command=ls-refs') answer = lsRefs(repo, args);
    else if (first === 'command=fetch') answer = fetchV2(args);
    else throw new GitRequestError(`unknown command ${first.slice(8)}`);
  } else if (typeof first === 'string' && first.startsWith('want ')) {
    answer = fetchV0(lines.filter((line) => line !== 'flush' && line !== 'delim'));
  } else if (first === 'flush') {
    answer = FLUSH;
  } else {
    throw new GitRequestError('the request is neither a v2 command nor a want list');
  }
  if (answers.size >= ANSWER_CACHE_MAX) answers.delete(answers.keys().next().value as string);
  answers.set(key, answer);
  return answer;
}

// ---- receive-pack -----------------------------------------------------------------------------

interface Command {
  before: string;
  after: string;
  ref: string;
}

/** Why a ref update is refused, or null when it may go ahead. */
function refusal(repo: Repo, command: Command): string | null {
  const current = repo.refs.get(command.ref) ?? null;
  if (!command.ref.startsWith('refs/') || /[\s~^:?*\[\\]|\.\.|\/$|\.lock$/.test(command.ref)) return 'funny refname';
  if (command.after === ZERO_OID) return current === null ? 'no such ref' : null;
  if (!hasObject(command.after)) return 'missing necessary objects';
  if (current === null || current === command.after) return null;
  if (command.ref.startsWith('refs/tags/')) return 'already exists';
  const from = peel(current);
  const to = peel(command.after);
  const target = getObject(to);
  if (target === undefined || target.type !== 'commit' || !isAncestor(from, to)) return 'non-fast-forward';
  return null;
}

/** POST git-receive-pack: store the pack, move each ref that may move, and report per ref. */
export function receivePack(repo: Repo, body: Buffer): Buffer {
  const { lines, end } = readPackets(body, 1);
  const commands: Command[] = [];
  let caps = '';
  for (const line of lines) {
    if (line === 'flush' || line === 'delim' || line.startsWith('shallow ')) continue;
    const nul = line.indexOf('\0');
    const text = nul < 0 ? line : line.slice(0, nul);
    if (nul >= 0) caps = line.slice(nul + 1);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(text);
    if (match === null) throw new GitRequestError('a receive-pack command is not "<old> <new> <ref>"');
    commands.push({ before: match[1], after: match[2], ref: match[3] });
  }
  if (commands.length === 0) throw new GitRequestError('a receive-pack request with no command');

  let unpack = 'ok';
  const pack = body.subarray(end);
  if (pack.length > 0) {
    try {
      ingestPack(pack);
    } catch (err) {
      unpack = err instanceof Error ? err.message.replace(/\s+/g, ' ') : 'unpack failed';
    }
  }
  const report: Buffer[] = [pkt(`unpack ${unpack}\n`)];
  let moved = false;
  for (const command of commands) {
    const why = unpack === 'ok' ? refusal(repo, command) : 'unpacker error';
    if (why !== null) {
      report.push(pkt(`ng ${command.ref} ${why}\n`));
      continue;
    }
    if (command.after === ZERO_OID) dropRef(repo, command.ref);
    else setRef(repo, command.ref, command.after);
    moved = true;
    report.push(pkt(`ok ${command.ref}\n`));
  }
  report.push(FLUSH);
  if (moved) repo.pushedAt = nowIso();
  const wanted = caps.split(' ');
  if (!wanted.includes('side-band-64k')) return Buffer.concat(report);
  const out: Buffer[] = [];
  banded(1, Buffer.concat(report), out);
  out.push(FLUSH);
  return Buffer.concat(out);
}
