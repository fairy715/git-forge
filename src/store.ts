// The forge's state, all in memory for the life of the process: the token's login, repositories
// with their refs, labels, issues, comments and pull requests, and a clock that never reads the
// wall time (so two runs of the same requests leave the same state).

import { commitOf } from './git/objects.ts';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  nodeId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** The JSON GET /issues/{n} answers with, kept until the issue changes. */
  cached: Buffer | null;
}

export interface Pull {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  /** The head commit as of the last look (frozen once the pull request closes). */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface Repo {
  id: number;
  nodeId: string;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  /** Full ref name ("refs/heads/main", "refs/tags/v1") to object id. */
  refs: Map<string, string>;
  /** Bumped on every ref change; cached fetch answers are keyed on it. */
  version: number;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
}

// ---- the clock --------------------------------------------------------------------------------

const EPOCH_FALLBACK = Date.UTC(2026, 0, 1) / 1000;

function startSeconds(): number {
  const given = process.env.MAKEFUN_TRIAL_NOW;
  if (given !== undefined && given !== '') {
    const parsed = Date.parse(given);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
    if (/^\d+$/.test(given)) return Number(given) > 1e11 ? Math.floor(Number(given) / 1000) : Number(given);
  }
  return EPOCH_FALLBACK;
}

let seconds = startSeconds();

/** The next instant: every write advances the clock one second, so creation order is total. */
export function tick(): number {
  seconds += 1;
  return seconds;
}

export function isoOf(epochSeconds: number): string {
  return `${new Date(epochSeconds * 1000).toISOString().slice(0, 19)}Z`;
}

export function nowIso(): string {
  return isoOf(tick());
}

// ---- ids --------------------------------------------------------------------------------------

let nextId = 1000;

export function newId(): number {
  nextId += 1;
  return nextId;
}

/** A GraphQL global id: stable for the object's life and never reused. */
export function nodeId(kind: string, id: number): string {
  return `${kind}_${Buffer.from(`${kind}:${id}`, 'utf8').toString('base64url')}`;
}

// ---- the viewer -------------------------------------------------------------------------------

/**
 * The login the bearer token belongs to. Nothing tells the forge its name up front, so it takes
 * the owner the token's holder first uses for a repository it created (a request under any other
 * owner then finds nothing, as another account's namespace would).
 */
let login: string | null = null;

export function viewerLogin(): string {
  return login ?? 'forge-owner';
}

// ---- repositories -----------------------------------------------------------------------------

const repos = new Map<string, Repo>();

export function allRepos(): Repo[] {
  return [...repos.values()];
}

/** The repository `owner/name` as the token's holder sees it, or null (wrong owner or unknown). */
export function findRepo(owner: string, name: string): Repo | null {
  const repo = repos.get(name.toLowerCase());
  if (repo === undefined) return null;
  if (login === null) login = owner;
  return owner.toLowerCase() === login.toLowerCase() ? repo : null;
}

export function repoByName(name: string): Repo | null {
  return repos.get(name.toLowerCase()) ?? null;
}

export function createRepo(name: string, description: string | null, isPrivate: boolean, defaultBranch = 'main'): Repo | null {
  const key = name.toLowerCase();
  if (repos.has(key)) return null;
  const id = newId();
  const at = nowIso();
  const repo: Repo = {
    id,
    nodeId: nodeId('R', id),
    name,
    description,
    private: isPrivate,
    defaultBranch,
    refs: new Map(),
    version: 0,
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdAt: at,
    updatedAt: at,
    pushedAt: at,
  };
  repos.set(key, repo);
  return repo;
}

export function deleteRepo(repo: Repo): void {
  repos.delete(repo.name.toLowerCase());
}

// ---- refs -------------------------------------------------------------------------------------

export function setRef(repo: Repo, ref: string, oid: string): void {
  repo.refs.set(ref, oid);
  repo.version += 1;
}

export function dropRef(repo: Repo, ref: string): void {
  repo.refs.delete(ref);
  repo.version += 1;
}

/** The commit a branch points at, or null. */
export function branchTip(repo: Repo, branch: string): string | null {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  return oid === undefined ? null : commitOf(oid);
}

export function branchNames(repo: Repo): string[] {
  const names: string[] = [];
  for (const ref of repo.refs.keys()) if (ref.startsWith('refs/heads/')) names.push(ref.slice(11));
  return names.sort();
}

/**
 * What HEAD names: the default branch while it exists (or while the repository has no branch at
 * all), else the first branch, so a repository pushed to under another name still has a HEAD.
 */
export function headBranch(repo: Repo): string {
  if (repo.refs.has(`refs/heads/${repo.defaultBranch}`)) return repo.defaultBranch;
  const names = branchNames(repo);
  return names.length > 0 ? names[0] : repo.defaultBranch;
}

/** Resolves a branch name, tag name, full ref or commit id to a commit, or null. */
export function resolveCommit(repo: Repo, ref: string | undefined | null): string | null {
  if (ref === undefined || ref === null || ref === '') return branchTip(repo, headBranch(repo));
  for (const full of [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/${ref}`]) {
    const oid = repo.refs.get(full);
    if (oid !== undefined) return commitOf(oid);
  }
  return /^[0-9a-f]{40}$/.test(ref) ? commitOf(ref) : null;
}
