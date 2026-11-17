// The Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP, answered as one
// JSON body per POST. It serves the 2026-07-28 revision (server/discover, no handshake) and the
// handshake revisions before it (initialize, notifications/initialized), and offers the forge as
// tools named and shaped after github-mcp-server's, each a thin wrapper over forge.ts.

import { mount } from '../app.ts';
import { ApiError, requireAuth, sendEmpty, sendRaw, type Call } from './http.ts';
import {
  editIssue,
  makeComment,
  makeIssue,
  makePull,
  makeRef,
  makeRepo,
  mergePull,
  pullFiles,
  writeFile,
} from './forge.ts';
import { history, isDirMode, readCommit } from './git/objects.ts';
import { lookupPath } from './git/worktree.ts';
import { allRepos, branchNames, branchTip, findRepo, headBranch, resolveCommit, viewerLogin, type Repo } from './store.ts';
import {
  branchView,
  commentView,
  commitView,
  dirView,
  entryView,
  fileView,
  issueView,
  pullFileView,
  pullView,
  refView,
  repoView,
  userView,
} from './views.ts';

const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'git-forge', title: 'git-forge', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };
const INSTRUCTIONS = 'A GitHub-compatible forge. Repositories belong to the token\'s login; create one with create_repo, then use the issue, pull request, branch and file tools on it.';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  readOnly: boolean;
  run: (args: Args, origin: string) => unknown;
}

const text = (description: string): { type: string; description: string } => ({ type: 'string', description });
const int = (description: string): { type: string; description: string } => ({ type: 'number', description });
const flag = (description: string): { type: string; description: string } => ({ type: 'boolean', description });

const OWNER = text('Repository owner (the login the repository belongs to)');
const REPO = text('Repository name');

/** The repository a call names, or the 404 the REST route would answer. */
function repoOf(args: Args): Repo {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : '';
  if (name.includes('/') && owner === '') [owner, name] = name.split('/', 2);
  const repo = findRepo(owner === '' ? viewerLogin() : owner, name);
  if (repo === null) throw new ApiError(404, `Repository ${owner}/${name} not found`);
  return repo;
}

function numberArg(args: Args, ...names: string[]): number {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return -1;
}

function page<T>(items: T[], args: Args): T[] {
  const perPage = Math.min(100, Math.max(1, numberArg(args, 'perPage', 'per_page') > 0 ? numberArg(args, 'perPage', 'per_page') : 30));
  const at = Math.max(1, numberArg(args, 'page'));
  return items.slice((at - 1) * perPage, at * perPage);
}

const TOOLS: Tool[] = [
  {
    name: 'get_me',
    title: 'Get my user profile',
    description: 'Get the profile of the authenticated user: the login every repository created with this token belongs to.',
    required: [],
    properties: {},
    readOnly: true,
    run: (_args, origin) => userView(origin),
  },
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a new repository owned by the authenticated user.',
    required: ['name'],
    properties: { name: text('Repository name'), description: text('Repository description'), private: flag('Whether the repository is private'), autoInit: flag('Initialize the repository with a README commit') },
    readOnly: false,
    run: (args, origin) => repoView(origin, makeRepo({ name: args.name, description: args.description, private: args.private, auto_init: args.autoInit ?? args.auto_init })),
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Get a repository: its name, owner, description, visibility and default branch.',
    required: ['owner', 'repo'],
    properties: { owner: OWNER, repo: REPO },
    readOnly: true,
    run: (args, origin) => repoView(origin, repoOf(args)),
  },
  {
    name: 'list_repos',
    title: 'List repositories',
    description: 'List the repositories the authenticated user owns.',
    required: [],
    properties: { perPage: int('Results per page (max 100)'), page: int('Page number, from 1') },
    readOnly: true,
    run: (args, origin) => page(allRepos(), args).map((repo) => repoView(origin, repo)),
  },
  {
    name: 'create_issue',
    title: 'Open new issue',
    description: 'Open a new issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: { owner: OWNER, repo: REPO, title: text('Issue title'), body: text('Issue body content'), labels: { type: 'array', description: 'Names of existing labels to apply' } },
    readOnly: false,
    run: (args, origin) => {
      const repo = repoOf(args);
      return issueView(origin, repo, makeIssue(repo, { title: args.title, body: args.body, labels: args.labels }));
    },
  },
  {
    name: 'get_issue',
    title: 'Get issue details',
    description: 'Get one issue of a repository by its number.',
    required: ['owner', 'repo', 'issue_number'],
    properties: { owner: OWNER, repo: REPO, issue_number: int('The number of the issue') },
    readOnly: true,
    run: (args, origin) => {
      const repo = repoOf(args);
      const issue = repo.issues.get(numberArg(args, 'issue_number', 'number'));
      if (issue === undefined) throw new ApiError(404, 'Issue not found');
      return issueView(origin, repo, issue);
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List the issues of a repository, newest first, filtered by state.',
    required: ['owner', 'repo'],
    properties: {
      owner: OWNER,
      repo: REPO,
      state: { type: 'string', description: 'Which issues to list (default open)', enum: ['open', 'closed', 'all'] },
      direction: { type: 'string', description: 'Order by creation time (default desc)', enum: ['asc', 'desc'] },
      perPage: int('Results per page (max 100)'),
      page: int('Page number, from 1'),
    },
    readOnly: true,
    run: (args, origin) => {
      const repo = repoOf(args);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      list.sort((a, b) => (args.direction === 'asc' ? a.number - b.number : b.number - a.number));
      return page(list, args).map((issue) => issueView(origin, repo, issue));
    },
  },
  {
    name: 'update_issue',
    title: 'Edit issue',
    description: 'Change an issue: its title, body, labels, or state (open or closed).',
    required: ['owner', 'repo', 'issue_number'],
    properties: { owner: OWNER, repo: REPO, issue_number: int('The number of the issue'), title: text('New title'), body: text('New body'), state: { type: 'string', description: 'New state', enum: ['open', 'closed'] } },
    readOnly: false,
    run: (args, origin) => {
      const repo = repoOf(args);
      const issue = repo.issues.get(numberArg(args, 'issue_number', 'number'));
      if (issue === undefined) throw new ApiError(404, 'Issue not found');
      return issueView(origin, repo, editIssue(repo, issue, { title: args.title, body: args.body, state: args.state, labels: args.labels }));
    },
  },
  {
    name: 'add_issue_comment',
    title: 'Add comment to issue',
    description: 'Add a comment to an issue or a pull request.',
    required: ['owner', 'repo', 'issue_number', 'body'],
    properties: { owner: OWNER, repo: REPO, issue_number: int('The number of the issue or pull request'), body: text('Comment content') },
    readOnly: false,
    run: (args, origin) => {
      const repo = repoOf(args);
      const number = numberArg(args, 'issue_number', 'number');
      const target = repo.issues.get(number) ?? repo.pulls.get(number);
      if (target === undefined) throw new ApiError(404, 'Issue not found');
      return commentView(origin, repo, number, makeComment(target, args.body));
    },
  },
  {
    name: 'list_branches',
    title: 'List branches',
    description: 'List the branches of a repository with the commit each points at.',
    required: ['owner', 'repo'],
    properties: { owner: OWNER, repo: REPO },
    readOnly: true,
    run: (args, origin) => {
      const repo = repoOf(args);
      return branchNames(repo).map((name) => branchView(origin, repo, name, branchTip(repo, name) as string, false));
    },
  },
  {
    name: 'create_branch',
    title: 'Create branch',
    description: 'Create a branch from another branch (the default branch when none is given).',
    required: ['owner', 'repo', 'branch'],
    properties: { owner: OWNER, repo: REPO, branch: text('Name of the new branch'), from_branch: text('Branch to start from (default: the repository default branch)') },
    readOnly: false,
    run: (args, origin) => {
      const repo = repoOf(args);
      const from = typeof args.from_branch === 'string' && args.from_branch !== '' ? args.from_branch : headBranch(repo);
      const tip = branchTip(repo, from);
      if (tip === null) throw new ApiError(404, `Branch ${from} not found`);
      const made = makeRef(repo, `refs/heads/${String(args.branch)}`, tip);
      return refView(origin, repo, made.ref, made.sha);
    },
  },
  {
    name: 'list_commits',
    title: 'List commits',
    description: 'List the commits of a branch (the default branch when none is given), newest first.',
    required: ['owner', 'repo'],
    properties: { owner: OWNER, repo: REPO, sha: text('Branch name, tag name or commit SHA to list from'), perPage: int('Results per page (max 100)'), page: int('Page number, from 1') },
    readOnly: true,
    run: (args, origin) => {
      const repo = repoOf(args);
      const tip = resolveCommit(repo, typeof args.sha === 'string' ? args.sha : null);
      if (tip === null) throw new ApiError(404, 'No commit found');
      return page(history(tip), args).map((sha) => commitView(origin, repo, sha));
    },
  },
  {
    name: 'get_file_contents',
    title: 'Get file or directory contents',
    description: 'Get a file (base64 content) or list a directory of a repository at a branch, tag or commit.',
    required: ['owner', 'repo', 'path'],
    properties: { owner: OWNER, repo: REPO, path: text('Path of the file or directory ("" or "/" for the root)'), ref: text('Branch name, tag name or commit SHA (default: the default branch)') },
    readOnly: true,
    run: (args, origin) => {
      const repo = repoOf(args);
      const ref = typeof args.ref === 'string' && args.ref !== '' ? args.ref : null;
      const commit = resolveCommit(repo, ref);
      if (commit === null) throw new ApiError(404, 'No commit found');
      const path = String(args.path ?? '').split('/').filter((part) => part !== '').join('/');
      const found = lookupPath(readCommit(commit).tree, path);
      if (found === null) throw new ApiError(404, 'Not Found');
      const shown = ref ?? headBranch(repo);
      return isDirMode(found.mode) ? dirView(origin, repo, shown, path, found.oid) : fileView(origin, repo, shown, path, found.mode, found.oid);
    },
  },
  {
    name: 'create_or_update_file',
    title: 'Create or update file',
    description: 'Create or update one file as a commit on a branch. Updating needs the sha of the blob being replaced.',
    required: ['owner', 'repo', 'path', 'content', 'message'],
    properties: { owner: OWNER, repo: REPO, path: text('Path of the file'), content: text('The new file content, as plain text'), message: text('Commit message'), branch: text('Branch to commit to (default: the default branch)'), sha: text('Blob SHA of the file being replaced (required when updating)') },
    readOnly: false,
    run: (args, origin) => {
      const repo = repoOf(args);
      const done = writeFile(repo, { path: String(args.path ?? ''), message: args.message, content: Buffer.from(String(args.content ?? ''), 'utf8').toString('base64'), sha: args.sha, branch: args.branch }, false);
      return { content: entryView(origin, repo, done.branch, String(args.path), '100644', done.blob as string), commit: commitView(origin, repo, done.commit) };
    },
  },
  {
    name: 'create_pull_request',
    title: 'Open new pull request',
    description: 'Open a pull request asking to merge a head branch into a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: { owner: OWNER, repo: REPO, title: text('Pull request title'), body: text('Pull request description'), head: text('Branch containing the changes'), base: text('Branch to merge into'), draft: flag('Create as a draft') },
    readOnly: false,
    run: (args, origin) => {
      const repo = repoOf(args);
      return pullView(origin, repo, makePull(repo, { title: args.title, body: args.body, head: args.head, base: args.base }), true);
    },
  },
  {
    name: 'get_pull_request',
    title: 'Get pull request details',
    description: 'Get one pull request of a repository by its number, with its merge state.',
    required: ['owner', 'repo', 'pull_number'],
    properties: { owner: OWNER, repo: REPO, pull_number: int('The number of the pull request') },
    readOnly: true,
    run: (args, origin) => {
      const repo = repoOf(args);
      const pull = repo.pulls.get(numberArg(args, 'pull_number', 'pullNumber', 'number'));
      if (pull === undefined) throw new ApiError(404, 'Pull request not found');
      return pullView(origin, repo, pull, true);
    },
  },
  {
    name: 'list_pull_requests',
    title: 'List pull requests',
    description: 'List the pull requests of a repository, newest first, filtered by state.',
    required: ['owner', 'repo'],
    properties: { owner: OWNER, repo: REPO, state: { type: 'string', description: 'Which pull requests to list (default open)', enum: ['open', 'closed', 'all'] }, perPage: int('Results per page (max 100)'), page: int('Page number, from 1') },
    readOnly: true,
    run: (args, origin) => {
      const repo = repoOf(args);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.state === state).sort((a, b) => b.number - a.number);
      return page(list, args).map((pull) => pullView(origin, repo, pull, false));
    },
  },
  {
    name: 'get_pull_request_files',
    title: 'Get pull request files',
    description: 'List the files a pull request changes, with the lines added and deleted in each.',
    required: ['owner', 'repo', 'pull_number'],
    properties: { owner: OWNER, repo: REPO, pull_number: int('The number of the pull request') },
    readOnly: true,
    run: (args, origin) => {
      const repo = repoOf(args);
      const pull = repo.pulls.get(numberArg(args, 'pull_number', 'pullNumber', 'number'));
      if (pull === undefined) throw new ApiError(404, 'Pull request not found');
      return pullFiles(repo, pull).map((file) => pullFileView(origin, repo, pull, file));
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge an open pull request into its base branch (merge, squash or rebase).',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: OWNER,
      repo: REPO,
      pull_number: int('The number of the pull request'),
      merge_method: { type: 'string', description: 'How to merge (default merge)', enum: ['merge', 'squash', 'rebase'] },
      commit_title: text('Title for the merge commit'),
      commit_message: text('Extra detail for the merge commit'),
    },
    readOnly: false,
    run: (args) => {
      const repo = repoOf(args);
      const pull = repo.pulls.get(numberArg(args, 'pull_number', 'pullNumber', 'number'));
      if (pull === undefined) throw new ApiError(404, 'Pull request not found');
      const merged = mergePull(repo, pull, { merge_method: args.merge_method, commit_title: args.commit_title, commit_message: args.commit_message });
      return { merged: true, sha: merged.sha, message: merged.message, number: pull.number };
    },
  },
];

const BY_NAME = new Map<string, Tool>();
for (const tool of TOOLS) BY_NAME.set(tool.name, tool);

/** The tools/list answer, built once so every call returns the same bytes. */
const TOOL_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  annotations: { title: tool.title, readOnlyHint: tool.readOnly },
}));

class RpcError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** A server-prefixed name ("github__create_issue", "forge.create_issue") finds its tool too. */
function toolNamed(name: string): Tool | undefined {
  const exact = BY_NAME.get(name);
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  for (const tool of TOOLS) if (lower.endsWith(tool.name) && /[^a-z0-9]$/.test(lower.slice(0, lower.length - tool.name.length))) return tool;
  return undefined;
}

function callTool(params: Args, origin: string): unknown {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = toolNamed(name);
  if (tool === undefined) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
  const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments) ? (params.arguments as Args) : {};
  const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) throw new RpcError(INVALID_PARAMS, `Invalid arguments for tool ${tool.name}: missing required ${missing.join(', ')}`);
  try {
    const value = tool.run(args, origin);
    const result: Args = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
    result.structuredContent = Array.isArray(value) ? { items: value, total_count: value.length } : value;
    return result;
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    // A refusal by the forge is the tool's own failure, reported in-band so a model can read it.
    return { content: [{ type: 'text', text: JSON.stringify({ message: err.message, status: err.status, ...err.extra }) }], isError: true };
  }
}

function dispatch(method: string, params: Args, origin: string): unknown {
  switch (method) {
    case 'server/discover':
      return { supportedVersions: REVISIONS, capabilities: CAPABILITIES, serverInfo: SERVER, instructions: INSTRUCTIONS };
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return { protocolVersion: REVISIONS.includes(asked) ? asked : REVISIONS[1], capabilities: CAPABILITIES, serverInfo: SERVER, instructions: INSTRUCTIONS };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOL_LIST };
    case 'tools/call':
      return callTool(params, origin);
    case 'resources/list':
      return { resources: [] };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'prompts/list':
      return { prompts: [] };
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** Answers one JSON-RPC message, or null for a notification (which gets no answer). */
function answer(message: unknown, origin: string): unknown | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request' } };
  }
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  const isRequest = typeof id === 'string' || typeof id === 'number';
  if (typeof method !== 'string') {
    // A response sent by the client (to a server request this forge never makes) needs no answer.
    return isRequest && !('result' in (message as object)) && !('error' in (message as object))
      ? { jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'Invalid Request' } }
      : null;
  }
  if (!isRequest) return null;
  try {
    const args = typeof params === 'object' && params !== null && !Array.isArray(params) ? (params as Args) : {};
    return { jsonrpc: '2.0', id, result: dispatch(method, args, origin) };
  } catch (err) {
    if (err instanceof RpcError) return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message } };
    return { jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' } };
  }
}

function mcp(call: Call): void {
  requireAuth(call);
  if (call.method === 'DELETE') return sendEmpty(call, 204);
  if (call.method !== 'POST') {
    return sendRaw(call, 405, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'This endpoint answers POST; it opens no server stream' } }), { allow: 'POST, DELETE' });
  }
  let message: unknown;
  try {
    message = JSON.parse(call.body.toString('utf8'));
  } catch {
    return sendRaw(call, 400, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } }));
  }
  if (Array.isArray(message)) {
    if (message.length === 0) return sendRaw(call, 400, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request' } }));
    const answers = message.map((each) => answer(each, call.origin)).filter((each) => each !== null);
    return answers.length === 0 ? sendEmpty(call, 202) : sendRaw(call, 200, JSON.stringify(answers));
  }
  const reply = answer(message, call.origin);
  if (reply === null) return sendEmpty(call, 202);
  sendRaw(call, 200, JSON.stringify(reply));
}

mount('mcp', mcp);
