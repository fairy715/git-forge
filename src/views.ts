// The JSON GitHub's REST API shows for each kind of thing. The REST routes send these, and the
// MCP tools answer with the same objects, so both read alike.

import { commitTime, getObject, isDirMode, readCommit, readTree } from './git/objects.ts';
import { pullMergeable, syncPull, type PullFile } from './forge.ts';
import { branchTip, isoOf, viewerLogin, type Comment, type Issue, type Label, type Pull, type Repo } from './store.ts';

type Json = Record<string, unknown>;

export function userView(origin: string): Json {
  const login = viewerLogin();
  return {
    login,
    id: 1,
    node_id: 'U_kgDOAAAAAQ',
    avatar_url: `${origin}/avatars/u/1`,
    gravatar_id: '',
    url: `${origin}/api/v3/users/${login}`,
    html_url: `${origin}/${login}`,
    repos_url: `${origin}/api/v3/users/${login}/repos`,
    type: 'User',
    site_admin: false,
  };
}

export function repoView(origin: string, repo: Repo): Json {
  const owner = viewerLogin();
  const full = `${owner}/${repo.name}`;
  const api = `${origin}/api/v3/repos/${full}`;
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userView(origin),
    html_url: `${origin}/${full}`,
    description: repo.description,
    fork: false,
    url: api,
    git_url: `${origin}/${full}.git`,
    clone_url: `${origin}/${full}.git`,
    ssh_url: `${origin}/${full}.git`,
    branches_url: `${api}/branches{/branch}`,
    commits_url: `${api}/commits{/sha}`,
    contents_url: `${api}/contents/{+path}`,
    issues_url: `${api}/issues{/number}`,
    pulls_url: `${api}/pulls{/number}`,
    labels_url: `${api}/labels{/name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    has_discussions: false,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    open_issues: openIssues,
    forks: 0,
    watchers: 0,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    delete_branch_on_merge: false,
  };
}

export function labelView(origin: string, repo: Repo, label: Label): Json {
  return {
    id: label.id,
    node_id: `LA_${label.id}`,
    url: `${origin}/api/v3/repos/${viewerLogin()}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function commentView(origin: string, repo: Repo, number: number, comment: Comment): Json {
  const api = `${origin}/api/v3/repos/${viewerLogin()}/${repo.name}`;
  return {
    id: comment.id,
    node_id: comment.nodeId,
    url: `${api}/issues/comments/${comment.id}`,
    html_url: `${origin}/${viewerLogin()}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
    issue_url: `${api}/issues/${number}`,
    body: comment.body,
    user: userView(origin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

export function issueView(origin: string, repo: Repo, issue: Issue): Json {
  const api = `${origin}/api/v3/repos/${viewerLogin()}/${repo.name}`;
  return {
    id: issue.id,
    node_id: issue.nodeId,
    url: `${api}/issues/${issue.number}`,
    repository_url: api,
    labels_url: `${api}/issues/${issue.number}/labels{/name}`,
    comments_url: `${api}/issues/${issue.number}/comments`,
    html_url: `${origin}/${viewerLogin()}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    title: issue.title,
    body: issue.body,
    user: userView(origin),
    labels: issue.labels.map((label) => labelView(origin, repo, label)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
  };
}

function branchSide(origin: string, repo: Repo, ref: string, sha: string): Json {
  return { label: `${viewerLogin()}:${ref}`, ref, sha, user: userView(origin), repo: repoView(origin, repo) };
}

/** A pull request; `full` adds the fields only the single-pull route computes. */
export function pullView(origin: string, repo: Repo, pull: Pull, full: boolean): Json {
  syncPull(repo, pull);
  const api = `${origin}/api/v3/repos/${viewerLogin()}/${repo.name}`;
  const view: Json = {
    id: pull.id,
    node_id: pull.nodeId,
    url: `${api}/pulls/${pull.number}`,
    html_url: `${origin}/${viewerLogin()}/${repo.name}/pull/${pull.number}`,
    diff_url: `${origin}/${viewerLogin()}/${repo.name}/pull/${pull.number}.diff`,
    issue_url: `${api}/issues/${pull.number}`,
    commits_url: `${api}/pulls/${pull.number}/commits`,
    comments_url: `${api}/issues/${pull.number}/comments`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userView(origin),
    labels: [],
    milestone: null,
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    head: branchSide(origin, repo, pull.head, pull.headSha),
    base: branchSide(origin, repo, pull.base, pull.state === 'open' ? (branchTip(repo, pull.base) ?? pull.baseSha) : pull.baseSha),
    author_association: 'OWNER',
    merged: pull.merged,
  };
  if (full) {
    const mergeable = pull.state === 'open' ? pullMergeable(repo, pull) : null;
    view.mergeable = mergeable;
    view.mergeable_state = mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty';
    view.merged_by = pull.merged ? userView(origin) : null;
    view.comments = pull.comments.length;
    view.maintainer_can_modify = false;
  }
  return view;
}

/** A pull request as the issues routes show it. */
export function pullAsIssueView(origin: string, repo: Repo, pull: Pull): Json {
  const api = `${origin}/api/v3/repos/${viewerLogin()}/${repo.name}`;
  return {
    id: pull.id,
    node_id: pull.nodeId,
    url: `${api}/issues/${pull.number}`,
    repository_url: api,
    comments_url: `${api}/issues/${pull.number}/comments`,
    html_url: `${origin}/${viewerLogin()}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    state_reason: null,
    title: pull.title,
    body: pull.body,
    user: userView(origin),
    labels: [],
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: pull.comments.length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    author_association: 'OWNER',
    pull_request: { url: `${api}/pulls/${pull.number}`, html_url: `${origin}/${viewerLogin()}/${repo.name}/pull/${pull.number}`, merged_at: pull.mergedAt },
  };
}

function person(line: string): Json {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: isoOf(0) };
  return { name: match[1], email: match[2], date: isoOf(Number(match[3])) };
}

export function gitCommitView(origin: string, repo: Repo, sha: string): Json {
  const commit = readCommit(sha);
  const api = `${origin}/api/v3/repos/${viewerLogin()}/${repo.name}`;
  return {
    sha,
    node_id: `C_${sha}`,
    url: `${api}/git/commits/${sha}`,
    author: person(commit.author),
    committer: person(commit.committer),
    message: commit.message.replace(/\n+$/, ''),
    tree: { sha: commit.tree, url: `${api}/git/trees/${commit.tree}` },
    parents: commit.parents.map((parent) => ({ sha: parent, url: `${api}/git/commits/${parent}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  };
}

export function commitView(origin: string, repo: Repo, sha: string): Json {
  const commit = readCommit(sha);
  const api = `${origin}/api/v3/repos/${viewerLogin()}/${repo.name}`;
  const git = gitCommitView(origin, repo, sha);
  delete git.sha;
  delete git.node_id;
  delete git.parents;
  git.url = `${api}/git/commits/${sha}`;
  git.comment_count = 0;
  return {
    sha,
    node_id: `C_${sha}`,
    commit: git,
    url: `${api}/commits/${sha}`,
    html_url: `${origin}/${viewerLogin()}/${repo.name}/commit/${sha}`,
    comments_url: `${api}/commits/${sha}/comments`,
    author: null,
    committer: null,
    parents: commit.parents.map((parent) => ({ sha: parent, url: `${api}/commits/${parent}` })),
  };
}

export function commitStamp(sha: string): string {
  return isoOf(commitTime(readCommit(sha)));
}

export function branchView(origin: string, repo: Repo, name: string, sha: string, full: boolean): Json {
  const api = `${origin}/api/v3/repos/${viewerLogin()}/${repo.name}`;
  if (!full) return { name, commit: { sha, url: `${api}/commits/${sha}` }, protected: false };
  return { name, commit: commitView(origin, repo, sha), protected: false, _links: { self: `${api}/branches/${encodeURIComponent(name)}` } };
}

export function refView(origin: string, repo: Repo, ref: string, sha: string): Json {
  const api = `${origin}/api/v3/repos/${viewerLogin()}/${repo.name}`;
  const object = getObject(sha);
  return {
    ref,
    node_id: `REF_${Buffer.from(`${repo.id}:${ref}`).toString('base64url')}`,
    url: `${api}/git/${ref}`,
    object: { sha, type: object?.type ?? 'commit', url: `${api}/git/${object?.type === 'tag' ? 'tags' : 'commits'}/${sha}` },
  };
}

/** One file or directory entry, without content, as a directory listing shows it. */
export function entryView(origin: string, repo: Repo, ref: string, path: string, mode: string, oid: string): Json {
  const api = `${origin}/api/v3/repos/${viewerLogin()}/${repo.name}`;
  const dir = isDirMode(mode);
  const size = dir ? 0 : (getObject(oid)?.data.length ?? 0);
  const type = dir ? 'dir' : mode === '160000' ? 'submodule' : mode === '120000' ? 'symlink' : 'file';
  const self = `${api}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
  const git = `${api}/git/${dir ? 'trees' : 'blobs'}/${oid}`;
  const html = `${origin}/${viewerLogin()}/${repo.name}/${dir ? 'tree' : 'blob'}/${ref}/${path}`;
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    sha: oid,
    size,
    url: self,
    html_url: html,
    git_url: git,
    download_url: dir ? null : `${origin}/${viewerLogin()}/${repo.name}/raw/${ref}/${path}`,
    type,
    _links: { self, git, html },
  };
}

export function fileView(origin: string, repo: Repo, ref: string, path: string, mode: string, oid: string): Json {
  const view = entryView(origin, repo, ref, path, mode, oid);
  const data = getObject(oid)?.data ?? Buffer.alloc(0);
  // GitHub breaks the base64 into 60-character lines.
  view.content = data.toString('base64').replace(/(.{60})/g, '$1\n');
  view.encoding = 'base64';
  return view;
}

export function dirView(origin: string, repo: Repo, ref: string, path: string, tree: string): Json[] {
  return readTree(tree).map((entry) => entryView(origin, repo, ref, path === '' ? entry.name : `${path}/${entry.name}`, entry.mode, entry.oid));
}

export function pullFileView(origin: string, repo: Repo, pull: Pull, file: PullFile): Json {
  const api = `${origin}/api/v3/repos/${viewerLogin()}/${repo.name}`;
  const path = file.change.path;
  return {
    sha: file.change.after ?? file.change.before,
    filename: path,
    status: file.change.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.additions + file.deletions,
    blob_url: `${origin}/${viewerLogin()}/${repo.name}/blob/${pull.headSha}/${path}`,
    raw_url: `${origin}/${viewerLogin()}/${repo.name}/raw/${pull.headSha}/${path}`,
    contents_url: `${api}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${pull.headSha}`,
  };
}
