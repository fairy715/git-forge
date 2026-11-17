// What the forge does, independent of which surface asked: REST, GraphQL and the MCP tools all
// call these, so a repository made through one reads back the same through the others. A refused
// operation throws the ApiError its REST form would answer with.

import { ApiError, invalid, notFound } from './http.ts';
import { commitOf, getObject, hasObject, isAncestor, isDirMode, mergeBase, readCommit, writeCommit, emptyTree } from './git/objects.ts';
import { diffTrees, lineCounts, lookupPath, mergeTrees, writeBlob, writePath, type Change } from './git/worktree.ts';
import {
  branchTip,
  createRepo,
  dropRef,
  headBranch,
  newId,
  nodeId,
  nowIso,
  setRef,
  tick,
  viewerLogin,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

function identity(): string {
  const login = viewerLogin();
  return `${login} <${login}@users.noreply.github.com>`;
}

// ---- repositories -----------------------------------------------------------------------------

export function makeRepo(input: { name: unknown; description?: unknown; private?: unknown; visibility?: unknown; default_branch?: unknown; auto_init?: unknown }): Repo {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') throw invalid('Repository creation failed.', [{ resource: 'Repository', code: 'missing_field', field: 'name' }]);
  if (!NAME_RE.test(name) || name === '.' || name === '..') {
    throw invalid('Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name can only contain ASCII letters, digits, and the characters ., -, and _' }]);
  }
  const isPrivate = typeof input.private === 'boolean' ? input.private : input.visibility === 'private';
  const repo = createRepo(name.replace(/\.git$/, ''), typeof input.description === 'string' ? input.description : null, isPrivate);
  if (repo === null) {
    throw invalid('Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
  }
  if (input.auto_init === true) {
    const readme = writeBlob(Buffer.from(`# ${repo.name}\n`, 'utf8'));
    const tree = writePath(emptyTree(), 'README.md', readme) as string;
    setRef(repo, `refs/heads/${repo.defaultBranch}`, writeCommit(tree, [], identity(), tick(), 'Initial commit'));
  }
  return repo;
}

export function touch(repo: Repo): void {
  repo.updatedAt = nowIso();
}

// ---- branches and commits ---------------------------------------------------------------------

/** Creates a ref ("refs/heads/x" or "refs/tags/x") at an existing commit. */
export function makeRef(repo: Repo, ref: unknown, sha: unknown): { ref: string; sha: string } {
  if (typeof ref !== 'string' || !/^refs\/(heads|tags)\/[^\s~^:?*\[\\]+$/.test(ref) || ref.endsWith('/') || ref.includes('..')) {
    throw invalid('Reference name is invalid');
  }
  if (typeof sha !== 'string' || !hasObject(sha)) throw invalid('Object does not exist');
  if (repo.refs.has(ref)) throw invalid('Reference already exists');
  setRef(repo, ref, sha);
  return { ref, sha };
}

export function moveRef(repo: Repo, ref: string, sha: unknown, force: boolean): { ref: string; sha: string } {
  const current = repo.refs.get(ref);
  if (current === undefined) throw invalid('Reference does not exist');
  if (typeof sha !== 'string' || !hasObject(sha)) throw invalid('Object does not exist');
  if (!force && !isAncestor(current, sha)) throw invalid('Update is not a fast forward');
  setRef(repo, ref, sha);
  return { ref, sha };
}

export function removeRef(repo: Repo, ref: string): void {
  if (!repo.refs.has(ref)) throw invalid('Reference does not exist');
  dropRef(repo, ref);
}

// ---- file contents ----------------------------------------------------------------------------

export interface FileWrite {
  path: string;
  message: unknown;
  content?: unknown;
  sha?: unknown;
  branch?: unknown;
}

export interface FileResult {
  created: boolean;
  commit: string;
  blob: string | null;
  size: number;
  branch: string;
}

function cleanPath(path: string): string {
  const cleaned = path.split('/').filter((part) => part !== '').join('/');
  if (cleaned === '' || cleaned.split('/').some((part) => part === '.' || part === '..' || part === '.git')) throw invalid('path contains a malformed path component');
  return cleaned;
}

/**
 * Creates, updates or (with no content) deletes one file as a commit on a branch. The first write
 * to a repository with no commits makes the branch. An update or delete must name the blob it
 * replaces; a blob that is no longer the file's is a 409.
 */
export function writeFile(repo: Repo, input: FileWrite, remove: boolean): FileResult {
  const path = cleanPath(input.path);
  const message = typeof input.message === 'string' && input.message !== '' ? input.message : null;
  if (message === null) throw invalid('Invalid request.\n\n"message" wasn\'t supplied.');
  const asked = typeof input.branch === 'string' && input.branch !== '' ? input.branch : null;
  const unborn = repo.refs.size === 0;
  const branch = asked ?? headBranch(repo);
  const parent = branchTip(repo, branch);
  if (parent === null && !unborn) throw new ApiError(404, asked === null ? 'Not Found' : `Branch ${branch} not found`);
  const baseTree = parent === null ? emptyTree() : readCommit(parent).tree;
  const existing = lookupPath(baseTree, path);
  const given = typeof input.sha === 'string' ? input.sha.toLowerCase() : null;

  let blob: string | null = null;
  let size = 0;
  if (remove) {
    if (existing === null || isDirMode(existing.mode)) throw notFound();
    if (given === null) throw invalid('Invalid request.\n\n"sha" wasn\'t supplied.');
    if (given !== existing.oid) throw new ApiError(409, `${path} does not match ${given}`);
  } else {
    if (typeof input.content !== 'string') throw invalid('Invalid request.\n\n"content" wasn\'t supplied.');
    if (existing !== null && isDirMode(existing.mode)) throw invalid('Invalid request.\n\nthe path names a directory.');
    if (existing !== null && given === null) throw invalid('Invalid request.\n\n"sha" wasn\'t supplied.');
    if (given !== null && (existing === null || given !== existing.oid)) throw new ApiError(409, `${path} does not match ${given}`);
    const data = Buffer.from(input.content.replace(/\s+/g, ''), 'base64');
    blob = writeBlob(data);
    size = data.length;
  }
  const tree = writePath(baseTree, path, blob);
  if (tree === null) throw invalid('the path cannot be written');
  const commit = writeCommit(tree, parent === null ? [] : [parent], identity(), tick(), message);
  setRef(repo, `refs/heads/${branch}`, commit);
  repo.pushedAt = nowIso();
  return { created: existing === null, commit, blob, size, branch };
}

// ---- labels, issues and comments --------------------------------------------------------------

export function makeLabel(repo: Repo, input: { name: unknown; color?: unknown; description?: unknown }): Label {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') throw invalid('Validation Failed', [{ resource: 'Label', code: 'missing_field', field: 'name' }]);
  if (repo.labels.has(name.toLowerCase())) throw invalid('Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
  const label: Label = {
    id: newId(),
    name,
    color: typeof input.color === 'string' && input.color !== '' ? input.color.replace(/^#/, '') : 'ededed',
    description: typeof input.description === 'string' ? input.description : null,
  };
  repo.labels.set(name.toLowerCase(), label);
  return label;
}

/** The repository's labels for a list of names (strings or {name}); an unknown name is a 422. */
export function labelsNamed(repo: Repo, names: unknown): Label[] {
  if (names === undefined || names === null) return [];
  if (!Array.isArray(names)) throw invalid('Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'labels' }]);
  const labels: Label[] = [];
  for (const entry of names) {
    const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? (entry as { name?: unknown }).name : null;
    const label = typeof name === 'string' ? repo.labels.get(name.toLowerCase()) : undefined;
    if (label === undefined) throw invalid('Validation Failed', [{ resource: 'Label', code: 'invalid', field: 'name', value: name }]);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

export function makeIssue(repo: Repo, input: { title: unknown; body?: unknown; labels?: unknown }): Issue {
  const title = typeof input.title === 'string' ? input.title : '';
  if (title.trim() === '') throw invalid('Validation Failed', [{ resource: 'Issue', code: 'missing_field', field: 'title' }]);
  const labels = labelsNamed(repo, input.labels);
  const id = newId();
  const at = nowIso();
  const issue: Issue = {
    id,
    nodeId: nodeId('I', id),
    number: repo.nextNumber,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels,
    comments: [],
    createdAt: at,
    updatedAt: at,
    closedAt: null,
    cached: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function editIssue(repo: Repo, issue: Issue, input: { title?: unknown; body?: unknown; state?: unknown; labels?: unknown }): Issue {
  if (input.state !== undefined && input.state !== 'open' && input.state !== 'closed') {
    throw invalid('Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'state' }]);
  }
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.trim() === '')) {
    throw invalid('Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'title' }]);
  }
  const labels = input.labels === undefined ? null : labelsNamed(repo, input.labels);
  const at = nowIso();
  if (typeof input.title === 'string') issue.title = input.title;
  if (typeof input.body === 'string') issue.body = input.body;
  if (input.body === null) issue.body = '';
  if (labels !== null) issue.labels = labels;
  if (input.state === 'closed' && issue.state !== 'closed') {
    issue.state = 'closed';
    issue.closedAt = at;
  } else if (input.state === 'open' && issue.state !== 'open') {
    issue.state = 'open';
    issue.closedAt = null;
  }
  issue.updatedAt = at;
  issue.cached = null;
  return issue;
}

export function makeComment(target: Issue | Pull, body: unknown): Comment {
  if (typeof body !== 'string' || body === '') throw invalid('Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
  const id = newId();
  const at = nowIso();
  const comment: Comment = { id, nodeId: nodeId('IC', id), body, createdAt: at, updatedAt: at };
  target.comments.push(comment);
  target.updatedAt = at;
  if ('cached' in target) target.cached = null;
  return comment;
}

// ---- pull requests ----------------------------------------------------------------------------

/** "owner:branch" or "branch" to the branch name. */
function branchOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  const colon = value.indexOf(':');
  return (colon < 0 ? value : value.slice(colon + 1)).replace(/^refs\/heads\//, '');
}

export function makePull(repo: Repo, input: { title?: unknown; body?: unknown; head: unknown; base: unknown }): Pull {
  const head = branchOf(input.head);
  const base = branchOf(input.base) || headBranch(repo);
  const missing = (field: string): ApiError => invalid('Validation Failed', [{ resource: 'PullRequest', code: 'missing_field', field }]);
  if (head === '') throw missing('head');
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (headSha === null) throw invalid('Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'head' }]);
  if (baseSha === null) throw invalid('Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'base' }]);
  if (head === base) throw invalid('Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'head', message: 'head and base must be different branches' }]);
  let title = typeof input.title === 'string' ? input.title : '';
  if (title.trim() === '') title = readCommit(headSha).message.split('\n')[0] || head;
  const id = newId();
  const at = nowIso();
  const pull: Pull = {
    id,
    nodeId: nodeId('PR', id),
    number: repo.nextNumber,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    head,
    base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
    comments: [],
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Brings an open pull request's head up to its branch; a closed one keeps what it had. */
export function syncPull(repo: Repo, pull: Pull): Pull {
  if (pull.state === 'open') {
    const head = branchTip(repo, pull.head);
    if (head !== null) pull.headSha = head;
  }
  return pull;
}

/** The trees a pull request compares: where its head left the base, and its head. */
function pullSides(repo: Repo, pull: Pull): { from: string | null; to: string } {
  syncPull(repo, pull);
  const baseTip = pull.state === 'open' ? (branchTip(repo, pull.base) ?? pull.baseSha) : pull.baseSha;
  const fork = mergeBase(baseTip, pull.headSha);
  return { from: fork === null ? null : readCommit(fork).tree, to: readCommit(pull.headSha).tree };
}

export interface PullFile {
  change: Change;
  additions: number;
  deletions: number;
}

export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const sides = pullSides(repo, pull);
  return diffTrees(sides.from, sides.to).map((change) => ({ change, ...lineCounts(change.before, change.after) }));
}

/** Whether the pull request would merge cleanly into its base right now. */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  syncPull(repo, pull);
  const baseTip = branchTip(repo, pull.base);
  if (baseTip === null) return false;
  const fork = mergeBase(baseTip, pull.headSha);
  return mergeTrees(fork === null ? null : readCommit(fork).tree, readCommit(baseTip).tree, readCommit(pull.headSha).tree) !== null;
}

/** The commits a pull request adds: its head's history that the base does not have. */
export function pullCommits(repo: Repo, pull: Pull): string[] {
  syncPull(repo, pull);
  const baseTip = pull.state === 'open' ? (branchTip(repo, pull.base) ?? pull.baseSha) : pull.baseSha;
  const out: string[] = [];
  const queue = [pull.headSha];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const at = queue.shift() as string;
    if (seen.has(at) || isAncestor(at, baseTip)) continue;
    seen.add(at);
    out.push(at);
    for (const parent of readCommit(at).parents) queue.push(parent);
  }
  return out.reverse();
}

export interface MergeInput {
  merge_method?: unknown;
  commit_title?: unknown;
  commit_message?: unknown;
  sha?: unknown;
}

/**
 * Merges an open pull request into its base branch. Squash (and rebase, which this forge lands
 * the same way) makes one commit on the base holding the merged tree; merge makes a two-parent
 * commit. A head that conflicts with the base, or a pull request that is not open, is a 405.
 */
export function mergePull(repo: Repo, pull: Pull, input: MergeInput): { sha: string; message: string } {
  if (pull.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable');
  syncPull(repo, pull);
  if (typeof input.sha === 'string' && input.sha !== '' && input.sha.toLowerCase() !== pull.headSha) {
    throw new ApiError(409, 'Head branch was modified. Review and try the merge again.');
  }
  const baseTip = branchTip(repo, pull.base);
  if (baseTip === null) throw new ApiError(405, 'Base branch was not found');
  const fork = mergeBase(baseTip, pull.headSha);
  const tree = mergeTrees(fork === null ? null : readCommit(fork).tree, readCommit(baseTip).tree, readCommit(pull.headSha).tree);
  if (tree === null) throw new ApiError(405, 'Pull Request is not mergeable');
  const method = input.merge_method === 'merge' || input.merge_method === 'rebase' ? input.merge_method : input.merge_method === undefined ? 'merge' : 'squash';
  const title = typeof input.commit_title === 'string' && input.commit_title !== '' ? input.commit_title : null;
  const detail = typeof input.commit_message === 'string' ? input.commit_message : null;
  let commit: string;
  if (method === 'merge') {
    const subject = title ?? `Merge pull request #${pull.number} from ${viewerLogin()}/${pull.head}`;
    commit = writeCommit(tree, [baseTip, pull.headSha], identity(), tick(), `${subject}\n\n${detail ?? pull.title}`);
  } else {
    const subject = title ?? `${pull.title} (#${pull.number})`;
    const body = detail ?? pull.body;
    commit = writeCommit(tree, [baseTip], identity(), tick(), body === '' ? subject : `${subject}\n\n${body}`);
  }
  pull.baseSha = baseTip;
  setRef(repo, `refs/heads/${pull.base}`, commit);
  const at = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = at;
  pull.closedAt = at;
  pull.updatedAt = at;
  pull.mergeCommitSha = commit;
  repo.pushedAt = at;
  return { sha: commit, message: 'Pull Request successfully merged' };
}

export function editPull(repo: Repo, pull: Pull, input: { title?: unknown; body?: unknown; state?: unknown; base?: unknown }): Pull {
  if (input.state !== undefined && input.state !== 'open' && input.state !== 'closed') {
    throw invalid('Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'state' }]);
  }
  const at = nowIso();
  if (typeof input.title === 'string' && input.title.trim() !== '') pull.title = input.title;
  if (typeof input.body === 'string') pull.body = input.body;
  if (typeof input.base === 'string' && branchTip(repo, input.base) !== null && pull.state === 'open') pull.base = input.base;
  if (input.state === 'closed' && pull.state === 'open') {
    syncPull(repo, pull);
    pull.state = 'closed';
    pull.closedAt = at;
  } else if (input.state === 'open' && pull.state === 'closed' && !pull.merged) {
    pull.state = 'open';
    pull.closedAt = null;
  }
  pull.updatedAt = at;
  return pull;
}

/** The blob at a path of a commit, with its bytes, or null. */
export function fileAt(commit: string, path: string): { oid: string; data: Buffer } | null {
  const found = lookupPath(readCommit(commit).tree, path);
  if (found === null || isDirMode(found.mode)) return null;
  const object = getObject(found.oid);
  return object === undefined ? null : { oid: found.oid, data: object.data };
}

export { commitOf };
