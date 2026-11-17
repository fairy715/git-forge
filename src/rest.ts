// GitHub's REST v3 API under /api/v3: repositories, branches and refs, commits, file contents,
// labels, issues and their comments, and pull requests with their files and merges. Each route
// reads its input, calls forge.ts, and answers with the view GitHub would.

import { ApiError, jsonBody, notFound, query, requireAuth, sendEmpty, sendJson, sendPage, sendRaw, type Call } from './http.ts';
import {
  editIssue,
  editPull,
  labelsNamed,
  makeComment,
  makeIssue,
  makeLabel,
  makePull,
  makeRef,
  makeRepo,
  mergePull,
  moveRef,
  pullCommits,
  pullFiles,
  removeRef,
  touch,
  writeFile,
} from './forge.ts';
import { getObject, history, isDirMode, readCommit, readTree } from './git/objects.ts';
import { lookupPath } from './git/worktree.ts';
import {
  allRepos,
  branchNames,
  branchTip,
  deleteRepo,
  findRepo,
  headBranch,
  resolveCommit,
  viewerLogin,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  branchView,
  commentView,
  commitView,
  dirView,
  entryView,
  fileView,
  gitCommitView,
  issueView,
  labelView,
  pullAsIssueView,
  pullFileView,
  pullView,
  refView,
  repoView,
  userView,
} from './views.ts';

const PREFIX = '/api/v3';
const SCOPES = { 'x-oauth-scopes': 'repo, read:org, workflow', 'x-accepted-oauth-scopes': '' };

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function numberOf(part: string): number {
  return /^\d{1,15}$/.test(part) ? Number(part) : -1;
}

/** Handles one /api/v3 request. */
export function rest(call: Call): void {
  requireAuth(call);
  const tail = call.path.slice(PREFIX.length);
  const parts = tail.split('/').filter((part) => part !== '').map(decode);
  const method = call.method;

  if (parts.length === 0) {
    if (method !== 'GET') throw notFound();
    const api = `${call.origin}${PREFIX}`;
    sendJson(call, 200, { current_user_url: `${api}/user`, current_user_repositories_url: `${api}/user/repos{?type,page,per_page,sort}`, repository_url: `${api}/repos/{owner}/{repo}`, user_url: `${api}/users/{user}`, rate_limit_url: `${api}/rate_limit` }, SCOPES);
    return;
  }
  switch (parts[0]) {
    case 'meta':
      if (method === 'GET' && parts.length === 1) return sendJson(call, 200, { verifiable_password_authentication: false, installed_version: '3.14.0' });
      break;
    case 'rate_limit':
      if (method === 'GET' && parts.length === 1) {
        const rate = { limit: 5000, used: 0, remaining: 5000, reset: 0 };
        return sendJson(call, 200, { resources: { core: rate, graphql: rate, search: { limit: 30, used: 0, remaining: 30, reset: 0 } }, rate });
      }
      break;
    case 'user':
      if (parts.length === 1 && method === 'GET') return sendJson(call, 200, { ...userView(call.origin), name: viewerLogin(), email: null, public_repos: 0, total_private_repos: allRepos().length }, SCOPES);
      if (parts.length === 2 && parts[1] === 'repos') return userRepos(call, method);
      break;
    case 'users':
      if (parts.length === 2 && method === 'GET') {
        if (parts[1].toLowerCase() !== viewerLogin().toLowerCase()) throw notFound();
        return sendJson(call, 200, userView(call.origin));
      }
      if (parts.length === 3 && parts[2] === 'repos' && method === 'GET') {
        if (parts[1].toLowerCase() !== viewerLogin().toLowerCase()) throw notFound();
        return userRepos(call, method);
      }
      break;
    case 'repos':
      if (parts.length >= 3) {
        const repo = findRepo(parts[1], parts[2]);
        if (repo === null) throw notFound();
        return repoRoute(call, method, repo, parts.slice(3));
      }
      break;
    default:
      break;
  }
  throw notFound();
}

function userRepos(call: Call, method: string): void {
  if (method === 'POST') {
    const repo = makeRepo(jsonBody(call));
    sendJson(call, 201, repoView(call.origin, repo));
    return;
  }
  if (method !== 'GET') throw notFound();
  sendPage(call, allRepos(), (repo) => repoView(call.origin, repo));
}

function repoRoute(call: Call, method: string, repo: Repo, rest: string[]): void {
  const origin = call.origin;
  if (rest.length === 0) {
    if (method === 'GET') return sendJson(call, 200, repoView(origin, repo));
    if (method === 'DELETE') {
      deleteRepo(repo);
      return sendEmpty(call, 204);
    }
    if (method === 'PATCH') {
      const body = jsonBody(call);
      if (typeof body.description === 'string' || body.description === null) repo.description = body.description as string | null;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && branchTip(repo, body.default_branch) !== null) repo.defaultBranch = body.default_branch;
      touch(repo);
      return sendJson(call, 200, repoView(origin, repo));
    }
    throw notFound();
  }
  switch (rest[0]) {
    case 'branches':
      return branches(call, method, repo, rest.slice(1));
    case 'git':
      return gitData(call, method, repo, rest.slice(1));
    case 'commits':
      return commits(call, method, repo, rest.slice(1));
    case 'contents':
      return contents(call, method, repo, rest.slice(1).join('/'));
    case 'labels':
      return labels(call, method, repo, rest.slice(1));
    case 'issues':
      return issues(call, method, repo, rest.slice(1));
    case 'pulls':
      return pulls(call, method, repo, rest.slice(1));
    default:
      throw notFound();
  }
}

// ---- branches, refs and commits ---------------------------------------------------------------

function branches(call: Call, method: string, repo: Repo, rest: string[]): void {
  if (method !== 'GET') throw notFound();
  if (rest.length === 0) {
    sendPage(call, branchNames(repo), (name) => branchView(call.origin, repo, name, branchTip(repo, name) as string, false));
    return;
  }
  const name = rest.join('/');
  const tip = branchTip(repo, name);
  if (tip === null) throw new ApiError(404, 'Branch not found');
  sendJson(call, 200, branchView(call.origin, repo, name, tip, true));
}

function gitData(call: Call, method: string, repo: Repo, rest: string[]): void {
  const origin = call.origin;
  const kind = rest[0];
  if (kind === 'refs' && rest.length === 1 && method === 'POST') {
    const body = jsonBody(call);
    const made = makeRef(repo, body.ref, body.sha);
    return sendJson(call, 201, refView(origin, repo, made.ref, made.sha));
  }
  if ((kind === 'refs' || kind === 'ref' || kind === 'matching-refs') && method === 'GET') {
    const wanted = rest.length > 1 ? `refs/${rest.slice(1).join('/')}` : 'refs/';
    const exact = repo.refs.get(wanted);
    if (exact !== undefined) return sendJson(call, 200, kind === 'matching-refs' ? [refView(origin, repo, wanted, exact)] : refView(origin, repo, wanted, exact));
    if (kind === 'ref') throw notFound();
    const matches = [...repo.refs.keys()].filter((ref) => ref.startsWith(wanted)).sort();
    if (matches.length === 0 && kind === 'refs' && rest.length > 1) throw notFound();
    return sendJson(call, 200, matches.map((ref) => refView(origin, repo, ref, repo.refs.get(ref) as string)));
  }
  if (kind === 'refs' && rest.length > 1 && (method === 'PATCH' || method === 'DELETE')) {
    const ref = `refs/${rest.slice(1).join('/')}`;
    if (method === 'DELETE') {
      removeRef(repo, ref);
      return sendEmpty(call, 204);
    }
    const body = jsonBody(call);
    const moved = moveRef(repo, ref, body.sha, body.force === true);
    return sendJson(call, 200, refView(origin, repo, moved.ref, moved.sha));
  }
  if (method === 'GET' && rest.length === 2) {
    const object = getObject(rest[1]);
    const api = `${origin}${PREFIX}/repos/${viewerLogin()}/${repo.name}`;
    if (kind === 'commits' && object?.type === 'commit') return sendJson(call, 200, gitCommitView(origin, repo, rest[1]));
    if (kind === 'blobs' && object?.type === 'blob') {
      return sendJson(call, 200, { sha: rest[1], node_id: `B_${rest[1]}`, size: object.data.length, url: `${api}/git/blobs/${rest[1]}`, content: object.data.toString('base64'), encoding: 'base64' });
    }
    if (kind === 'trees') {
      const tree = object?.type === 'commit' ? readCommit(rest[1]).tree : object?.type === 'tree' ? rest[1] : (resolveCommit(repo, rest[1]) === null ? null : readCommit(resolveCommit(repo, rest[1]) as string).tree);
      if (tree === null) throw notFound();
      const recursive = query(call).has('recursive');
      const out: unknown[] = [];
      const walk = (oid: string, prefix: string): void => {
        for (const entry of readTree(oid)) {
          const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
          const dir = isDirMode(entry.mode);
          out.push({ path, mode: dir ? '040000' : entry.mode, type: dir ? 'tree' : 'blob', sha: entry.oid, ...(dir ? {} : { size: getObject(entry.oid)?.data.length ?? 0 }), url: `${api}/git/${dir ? 'trees' : 'blobs'}/${entry.oid}` });
          if (dir && recursive) walk(entry.oid, path);
        }
      };
      walk(tree, '');
      return sendJson(call, 200, { sha: tree, url: `${api}/git/trees/${tree}`, tree: out, truncated: false });
    }
  }
  throw notFound();
}

function commits(call: Call, method: string, repo: Repo, rest: string[]): void {
  if (method !== 'GET') throw notFound();
  if (rest.length === 0) {
    const params = query(call);
    const asked = params.get('sha');
    const tip = resolveCommit(repo, asked);
    if (tip === null) {
      if (asked !== null && asked !== '') throw notFound();
      if (repo.refs.size === 0) throw new ApiError(409, 'Git Repository is empty.');
      throw notFound();
    }
    let list = history(tip);
    const path = params.get('path');
    if (path !== null && path !== '') {
      list = list.filter((sha) => {
        const commit = readCommit(sha);
        const mine = lookupPath(commit.tree, path)?.oid ?? null;
        if (commit.parents.length === 0) return mine !== null;
        return commit.parents.some((parent) => (lookupPath(readCommit(parent).tree, path)?.oid ?? null) !== mine);
      });
    }
    sendPage(call, list, (sha) => commitView(call.origin, repo, sha));
    return;
  }
  const sha = resolveCommit(repo, rest.join('/'));
  if (sha === null) throw new ApiError(422, `No commit found for SHA: ${rest.join('/')}`);
  sendJson(call, 200, { ...commitView(call.origin, repo, sha), stats: { additions: 0, deletions: 0, total: 0 }, files: [] });
}

// ---- contents ---------------------------------------------------------------------------------

function contents(call: Call, method: string, repo: Repo, path: string): void {
  const origin = call.origin;
  if (method === 'GET') {
    const ref = query(call).get('ref');
    const commit = resolveCommit(repo, ref);
    if (commit === null) {
      if (repo.refs.size === 0) throw new ApiError(404, 'This repository is empty.');
      throw new ApiError(404, ref === null ? 'Not Found' : `No commit found for the ref ${ref}`);
    }
    const found = lookupPath(readCommit(commit).tree, path);
    if (found === null) throw notFound();
    const shown = ref ?? headBranch(repo);
    const clean = path.split('/').filter((part) => part !== '').join('/');
    if (isDirMode(found.mode)) return sendJson(call, 200, dirView(origin, repo, shown, clean, found.oid));
    return sendJson(call, 200, fileView(origin, repo, shown, clean, found.mode, found.oid));
  }
  if (method === 'PUT' || method === 'DELETE') {
    const body = jsonBody(call);
    const done = writeFile(repo, { path, message: body.message, content: body.content, sha: body.sha, branch: body.branch }, method === 'DELETE');
    const clean = path.split('/').filter((part) => part !== '').join('/');
    const commit = gitCommitView(origin, repo, done.commit);
    commit.html_url = `${origin}/${viewerLogin()}/${repo.name}/commit/${done.commit}`;
    if (done.blob === null) return sendJson(call, 200, { content: null, commit });
    const content = entryView(origin, repo, done.branch, clean, '100644', done.blob);
    content.encoding = 'base64';
    return sendJson(call, done.created ? 201 : 200, { content, commit });
  }
  throw notFound();
}

// ---- labels, issues and comments --------------------------------------------------------------

function labels(call: Call, method: string, repo: Repo, rest: string[]): void {
  const origin = call.origin;
  if (rest.length === 0) {
    if (method === 'POST') return sendJson(call, 201, labelView(origin, repo, makeLabel(repo, jsonBody(call))));
    if (method === 'GET') return sendPage(call, [...repo.labels.values()], (label) => labelView(origin, repo, label));
    throw notFound();
  }
  const label = repo.labels.get(rest.join('/').toLowerCase());
  if (label === undefined) throw notFound();
  if (method === 'GET') return sendJson(call, 200, labelView(origin, repo, label));
  if (method === 'DELETE') {
    repo.labels.delete(label.name.toLowerCase());
    for (const issue of repo.issues.values()) {
      if (issue.labels.includes(label)) {
        issue.labels = issue.labels.filter((other) => other !== label);
        issue.cached = null;
      }
    }
    return sendEmpty(call, 204);
  }
  if (method === 'PATCH') {
    const body = jsonBody(call);
    if (typeof body.color === 'string') label.color = body.color.replace(/^#/, '');
    if (typeof body.description === 'string') label.description = body.description;
    for (const issue of repo.issues.values()) if (issue.labels.includes(label)) issue.cached = null;
    return sendJson(call, 200, labelView(origin, repo, label));
  }
  throw notFound();
}

type Listed = { kind: 'issue'; issue: Issue } | { kind: 'pull'; pull: Pull };

function listedTime(item: Listed, field: 'created' | 'updated'): string {
  const of = item.kind === 'issue' ? item.issue : item.pull;
  return field === 'created' ? of.createdAt : of.updatedAt;
}

function listedNumber(item: Listed): number {
  return item.kind === 'issue' ? item.issue.number : item.pull.number;
}

function issues(call: Call, method: string, repo: Repo, rest: string[]): void {
  const origin = call.origin;
  if (rest.length === 0) {
    if (method === 'POST') {
      const issue = makeIssue(repo, jsonBody(call));
      return sendJson(call, 201, issueView(origin, repo, issue));
    }
    if (method !== 'GET') throw notFound();
    const params = query(call);
    const state = params.get('state') ?? 'open';
    const wantedLabels = (params.get('labels') ?? '').split(',').map((name) => name.trim().toLowerCase()).filter((name) => name !== '');
    const items: Listed[] = [];
    for (const issue of repo.issues.values()) {
      if (state !== 'all' && issue.state !== state) continue;
      if (wantedLabels.some((name) => !issue.labels.some((label) => label.name.toLowerCase() === name))) continue;
      items.push({ kind: 'issue', issue });
    }
    // As on GitHub, the issues list also shows pull requests (marked by `pull_request`).
    if (wantedLabels.length === 0) {
      for (const pull of repo.pulls.values()) if (state === 'all' || pull.state === state) items.push({ kind: 'pull', pull });
    }
    const sort = params.get('sort');
    const field = sort === 'updated' ? 'updated' : 'created';
    const up = params.get('direction') === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      const x = listedTime(a, field);
      const y = listedTime(b, field);
      return (x < y ? -1 : x > y ? 1 : listedNumber(a) - listedNumber(b)) * up;
    });
    sendPage(call, items, (item) => (item.kind === 'issue' ? issueView(origin, repo, item.issue) : pullAsIssueView(origin, repo, item.pull)));
    return;
  }
  const number = numberOf(rest[0]);
  const issue = repo.issues.get(number);
  const pull = issue === undefined ? repo.pulls.get(number) : undefined;
  if (issue === undefined && pull === undefined) throw notFound();
  if (rest.length === 1) {
    if (method === 'GET') {
      if (issue === undefined) return sendJson(call, 200, pullAsIssueView(origin, repo, pull as Pull));
      // The single-issue read is the hot path of the read workload: its JSON is kept per origin.
      if (issue.cached === null || cachedOrigin !== origin) {
        if (cachedOrigin !== origin) {
          for (const other of allRepos()) for (const each of other.issues.values()) each.cached = null;
          cachedOrigin = origin;
        }
        issue.cached = Buffer.from(JSON.stringify(issueView(origin, repo, issue)), 'utf8');
      }
      return sendRaw(call, 200, issue.cached);
    }
    if (method === 'PATCH') {
      const body = jsonBody(call);
      if (issue === undefined) return sendJson(call, 200, pullAsIssueView(origin, repo, editPull(repo, pull as Pull, body)));
      return sendJson(call, 200, issueView(origin, repo, editIssue(repo, issue, body)));
    }
    throw notFound();
  }
  const target = (issue ?? pull) as Issue | Pull;
  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'POST') return sendJson(call, 201, commentView(origin, repo, number, makeComment(target, jsonBody(call).body)));
    if (method === 'GET') return sendPage(call, target.comments, (comment) => commentView(origin, repo, number, comment));
  }
  if (rest[1] === 'labels' && issue !== undefined) {
    if (method === 'GET' && rest.length === 2) return sendJson(call, 200, issue.labels.map((label) => labelView(origin, repo, label)));
    if ((method === 'POST' || method === 'PUT') && rest.length === 2) {
      const body = call.body.length === 0 ? {} : jsonBody(call);
      const added = labelsNamed(repo, Array.isArray(body.labels) ? body.labels : []);
      issue.labels = method === 'PUT' ? added : [...issue.labels, ...added.filter((label) => !issue.labels.includes(label))];
      issue.cached = null;
      return sendJson(call, 200, issue.labels.map((label) => labelView(origin, repo, label)));
    }
    if (method === 'DELETE') {
      const name = rest.slice(2).join('/').toLowerCase();
      issue.labels = rest.length === 2 ? [] : issue.labels.filter((label) => label.name.toLowerCase() !== name);
      issue.cached = null;
      return rest.length === 2 ? sendEmpty(call, 204) : sendJson(call, 200, issue.labels.map((label) => labelView(origin, repo, label)));
    }
  }
  throw notFound();
}

let cachedOrigin = '';

// ---- pull requests ----------------------------------------------------------------------------

function pulls(call: Call, method: string, repo: Repo, rest: string[]): void {
  const origin = call.origin;
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = jsonBody(call);
      const pull = makePull(repo, { title: body.title, body: body.body, head: body.head, base: body.base });
      return sendJson(call, 201, pullView(origin, repo, pull, true));
    }
    if (method !== 'GET') throw notFound();
    const params = query(call);
    const state = params.get('state') ?? 'open';
    const head = params.get('head');
    const base = params.get('base');
    const headBranchName = head === null ? null : head.slice(head.indexOf(':') + 1);
    const list = [...repo.pulls.values()].filter(
      (pull) => (state === 'all' || pull.state === state) && (headBranchName === null || pull.head === headBranchName) && (base === null || pull.base === base),
    );
    const field = params.get('sort') === 'updated' ? 'updatedAt' : 'createdAt';
    const up = params.get('direction') === 'asc' ? 1 : -1;
    list.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : a.number - b.number) * up);
    sendPage(call, list, (pull) => pullView(origin, repo, pull, false));
    return;
  }
  const pull = repo.pulls.get(numberOf(rest[0]));
  if (pull === undefined) throw notFound();
  if (rest.length === 1) {
    if (method === 'GET') return sendJson(call, 200, pullView(origin, repo, pull, true));
    if (method === 'PATCH') return sendJson(call, 200, pullView(origin, repo, editPull(repo, pull, jsonBody(call)), true));
    throw notFound();
  }
  if (rest.length === 2) {
    if (rest[1] === 'files' && method === 'GET') return sendPage(call, pullFiles(repo, pull), (file) => pullFileView(origin, repo, pull, file));
    if (rest[1] === 'commits' && method === 'GET') return sendPage(call, pullCommits(repo, pull), (sha) => commitView(origin, repo, sha));
    if (rest[1] === 'merge') {
      if (method === 'PUT') {
        const merged = mergePull(repo, pull, call.body.length === 0 ? {} : jsonBody(call));
        return sendJson(call, 200, { sha: merged.sha, merged: true, message: merged.message });
      }
      if (method === 'GET') {
        if (!pull.merged) throw notFound();
        return sendEmpty(call, 204);
      }
    }
    if (rest[1] === 'comments' && method === 'GET') return sendJson(call, 200, []);
    if (rest[1] === 'reviews' && method === 'GET') return sendJson(call, 200, []);
  }
  throw notFound();
}
