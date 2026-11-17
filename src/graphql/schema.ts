// The forge's GraphQL schema: the part of GitHub's v4 schema that gh and github-mcp-server read
// and write (viewer, repositories, refs, issues, pull requests, comments, labels, node lookup, and
// the create/close/merge/comment mutations), resolved straight from the store.

import { ApiError } from '../http.ts';
import {
  editIssue,
  editPull,
  makeComment,
  makeIssue,
  makePull,
  makeRepo,
  mergePull,
  pullFiles,
  pullMergeable,
  syncPull,
} from '../forge.ts';
import { getObject, readCommit } from '../git/objects.ts';
import { allRepos, branchTip, findRepo, repoByName, viewerLogin, type Comment, type Issue, type Label, type Pull, type Repo } from '../store.ts';
import { commitStamp } from '../views.ts';
import { FieldError, makeSchema, type FieldDef, type Schema, type TypeDef } from './execute.ts';

// What resolvers pass around: a store object with the repository it lives in.
interface IssueNode {
  kind: 'Issue';
  repo: Repo;
  issue: Issue;
}
interface PullNode {
  kind: 'PullRequest';
  repo: Repo;
  pull: Pull;
}
interface CommentNode {
  kind: 'IssueComment';
  repo: Repo;
  number: number;
  comment: Comment;
}
interface RepoNode {
  kind: 'Repository';
  repo: Repo;
}
interface RefNode {
  kind: 'Ref';
  repo: Repo;
  name: string;
  prefix: string;
  oid: string;
}

const VIEWER = { kind: 'User' };
const USER_ID = 'U_kgDOAAAAAQ';

const repoNode = (repo: Repo): RepoNode => ({ kind: 'Repository', repo });
const issueNode = (repo: Repo, issue: Issue): IssueNode => ({ kind: 'Issue', repo, issue });
const pullNode = (repo: Repo, pull: Pull): PullNode => ({ kind: 'PullRequest', repo, pull: syncPull(repo, pull) });

/** Runs a forge operation, turning its refusal into a GraphQL error of GitHub's kind. */
function guarded<T>(work: () => T): T {
  try {
    return work();
  } catch (err) {
    if (err instanceof ApiError) throw new FieldError(err.message, err.status === 404 ? 'NOT_FOUND' : err.status === 403 ? 'FORBIDDEN' : 'UNPROCESSABLE');
    throw err;
  }
}

function webUrl(repo: Repo, tail = ''): string {
  return `https://github.com/${viewerLogin()}/${repo.name}${tail}`;
}

// ---- connections ------------------------------------------------------------------------------

const cursorOf = (index: number): string => Buffer.from(`cursor:${index}`, 'utf8').toString('base64');

function indexOf(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  return match === null ? null : Number(match[1]);
}

/** A Relay page of `items` for first/after/last/before. */
function connection<T>(items: T[], args: Record<string, any>): unknown {
  let from = 0;
  let to = items.length;
  const after = indexOf(args.after);
  const before = indexOf(args.before);
  if (after !== null) from = Math.min(items.length, after + 1);
  if (before !== null) to = Math.max(from, Math.min(to, before));
  if (typeof args.first === 'number') to = Math.min(to, from + Math.max(0, args.first));
  else if (typeof args.last === 'number') from = Math.max(from, to - Math.max(0, args.last));
  else to = Math.min(to, from + 100);
  const nodes = items.slice(from, to);
  return {
    nodes,
    edges: nodes.map((node, offset) => ({ node, cursor: cursorOf(from + offset) })),
    totalCount: items.length,
    pageInfo: {
      hasNextPage: to < items.length,
      hasPreviousPage: from > 0,
      startCursor: nodes.length > 0 ? cursorOf(from) : null,
      endCursor: nodes.length > 0 ? cursorOf(to - 1) : null,
    },
  };
}

const PAGE_ARGS = { first: 'Int', after: 'String', last: 'Int', before: 'String' };

function connectionTypes(name: string, node: string): TypeDef[] {
  return [
    {
      kind: 'OBJECT',
      name: `${name}Connection`,
      description: `A page of ${node} items.`,
      fields: { nodes: { type: `[${node}]` }, edges: { type: `[${name}Edge]` }, totalCount: { type: 'Int!' }, pageInfo: { type: 'PageInfo!' } },
    },
    { kind: 'OBJECT', name: `${name}Edge`, fields: { node: { type: node }, cursor: { type: 'String!' } } },
  ];
}

// ---- field helpers ----------------------------------------------------------------------------

function sortIssues<T extends { createdAt: string; updatedAt: string; number: number; comments: Comment[] }>(items: T[], orderBy: any): T[] {
  const field = orderBy?.field;
  const down = orderBy?.direction === 'DESC';
  const key = (item: T): string | number => (field === 'UPDATED_AT' ? item.updatedAt : field === 'COMMENTS' ? item.comments.length : item.createdAt);
  return [...items].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const byKey = x < y ? -1 : x > y ? 1 : 0;
    return (byKey !== 0 ? byKey : a.number - b.number) * (down ? -1 : 1);
  });
}

function pullState(pull: Pull): string {
  return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function findNode(id: unknown): unknown {
  if (typeof id !== 'string' || id === '') return null;
  if (id === USER_ID) return VIEWER;
  for (const repo of allRepos()) {
    if (repo.nodeId === id) return repoNode(repo);
    if (id.startsWith('I_')) for (const issue of repo.issues.values()) if (issue.nodeId === id) return issueNode(repo, issue);
    if (id.startsWith('PR_')) for (const pull of repo.pulls.values()) if (pull.nodeId === id) return pullNode(repo, pull);
    if (id.startsWith('IC_')) {
      for (const issue of repo.issues.values()) for (const comment of issue.comments) if (comment.nodeId === id) return { kind: 'IssueComment', repo, number: issue.number, comment };
      for (const pull of repo.pulls.values()) for (const comment of pull.comments) if (comment.nodeId === id) return { kind: 'IssueComment', repo, number: pull.number, comment };
    }
  }
  return null;
}

function nodeOfKind<T>(id: unknown, kind: string, what: string): T {
  const node = findNode(id) as { kind: string } | null;
  if (node === null || node.kind !== kind) throw new FieldError(`Could not resolve to a ${what} with the global id of '${String(id)}'`, 'NOT_FOUND');
  return node as T;
}

const actor: FieldDef = { type: 'Actor', resolve: () => VIEWER };

const commentFields: Record<string, FieldDef> = {
  id: { type: 'ID!', resolve: (c: CommentNode) => c.comment.nodeId },
  databaseId: { type: 'Int', resolve: (c: CommentNode) => c.comment.id },
  body: { type: 'String!', resolve: (c: CommentNode) => c.comment.body },
  bodyText: { type: 'String!', resolve: (c: CommentNode) => c.comment.body },
  author: actor,
  authorAssociation: { type: 'String!', resolve: () => 'OWNER' },
  createdAt: { type: 'DateTime!', resolve: (c: CommentNode) => c.comment.createdAt },
  updatedAt: { type: 'DateTime!', resolve: (c: CommentNode) => c.comment.updatedAt },
  url: { type: 'URI!', resolve: (c: CommentNode) => webUrl(c.repo, `/issues/${c.number}#issuecomment-${c.comment.id}`) },
};

function commentsOf(repo: Repo, number: number, comments: Comment[], args: Record<string, any>): unknown {
  return connection(comments.map((comment): CommentNode => ({ kind: 'IssueComment', repo, number, comment })), args);
}

const TYPES: TypeDef[] = [
  { kind: 'INTERFACE', name: 'Node', description: 'An object with a global ID.', fields: { id: { type: 'ID!' } }, typeOf: (value) => value.kind },
  { kind: 'INTERFACE', name: 'Actor', description: 'An account that can act on the forge.', fields: { login: { type: 'String!' }, url: { type: 'URI!' }, avatarUrl: { type: 'URI!' } }, typeOf: () => 'User' },
  { kind: 'INTERFACE', name: 'RepositoryOwner', fields: { id: { type: 'ID!' }, login: { type: 'String!' }, url: { type: 'URI!' } }, typeOf: () => 'User' },
  { kind: 'UNION', name: 'IssueOrPullRequest', typeOf: (value) => value.kind },
  { kind: 'INTERFACE', name: 'GitObject', fields: { id: { type: 'ID!' }, oid: { type: 'GitObjectID!' } }, typeOf: () => 'Commit' },
  { kind: 'ENUM', name: 'IssueState', values: ['OPEN', 'CLOSED'] },
  { kind: 'ENUM', name: 'IssueStateReason', values: ['COMPLETED', 'NOT_PLANNED', 'REOPENED', 'DUPLICATE'] },
  { kind: 'ENUM', name: 'IssueClosedStateReason', values: ['COMPLETED', 'NOT_PLANNED', 'DUPLICATE'] },
  { kind: 'ENUM', name: 'PullRequestState', values: ['OPEN', 'CLOSED', 'MERGED'] },
  { kind: 'ENUM', name: 'MergeableState', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  { kind: 'ENUM', name: 'PullRequestMergeMethod', values: ['MERGE', 'SQUASH', 'REBASE'] },
  { kind: 'ENUM', name: 'RepositoryPermission', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  { kind: 'ENUM', name: 'RepositoryVisibility', values: ['PRIVATE', 'PUBLIC', 'INTERNAL'] },
  { kind: 'ENUM', name: 'SearchType', values: ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  { kind: 'ENUM', name: 'IssueOrderField', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  { kind: 'ENUM', name: 'OrderDirection', values: ['ASC', 'DESC'] },
  { kind: 'ENUM', name: 'PatchStatus', values: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'] },
  { kind: 'INPUT_OBJECT', name: 'IssueOrder', inputs: { field: 'IssueOrderField!', direction: 'OrderDirection!' } },
  { kind: 'INPUT_OBJECT', name: 'IssueFilters', inputs: { states: '[IssueState!]', labels: '[String!]' } },
  { kind: 'INPUT_OBJECT', name: 'CreateRepositoryInput', inputs: { name: 'String!', visibility: 'RepositoryVisibility!', description: 'String', ownerId: 'ID', clientMutationId: 'String' } },
  { kind: 'INPUT_OBJECT', name: 'CreateIssueInput', inputs: { repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]', assigneeIds: '[ID!]', clientMutationId: 'String' } },
  { kind: 'INPUT_OBJECT', name: 'UpdateIssueInput', inputs: { id: 'ID!', title: 'String', body: 'String', state: 'IssueState', clientMutationId: 'String' } },
  { kind: 'INPUT_OBJECT', name: 'CloseIssueInput', inputs: { issueId: 'ID!', stateReason: 'IssueClosedStateReason', clientMutationId: 'String' } },
  { kind: 'INPUT_OBJECT', name: 'ReopenIssueInput', inputs: { issueId: 'ID!', clientMutationId: 'String' } },
  { kind: 'INPUT_OBJECT', name: 'CreatePullRequestInput', inputs: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', maintainerCanModify: 'Boolean', headRepositoryId: 'ID', clientMutationId: 'String' } },
  { kind: 'INPUT_OBJECT', name: 'UpdatePullRequestInput', inputs: { pullRequestId: 'ID!', title: 'String', body: 'String', baseRefName: 'String', state: 'PullRequestState', clientMutationId: 'String' } },
  { kind: 'INPUT_OBJECT', name: 'ClosePullRequestInput', inputs: { pullRequestId: 'ID!', clientMutationId: 'String' } },
  { kind: 'INPUT_OBJECT', name: 'ReopenPullRequestInput', inputs: { pullRequestId: 'ID!', clientMutationId: 'String' } },
  { kind: 'INPUT_OBJECT', name: 'MergePullRequestInput', inputs: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID', authorEmail: 'String', clientMutationId: 'String' } },
  { kind: 'INPUT_OBJECT', name: 'AddCommentInput', inputs: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' } },
  { kind: 'OBJECT', name: 'PageInfo', fields: { hasNextPage: { type: 'Boolean!' }, hasPreviousPage: { type: 'Boolean!' }, startCursor: { type: 'String' }, endCursor: { type: 'String' } } },
  {
    kind: 'OBJECT',
    name: 'User',
    description: 'The account the token belongs to.',
    implements: ['Node', 'Actor', 'RepositoryOwner'],
    fields: {
      id: { type: 'ID!', resolve: () => USER_ID },
      databaseId: { type: 'Int', resolve: () => 1 },
      login: { type: 'String!', resolve: () => viewerLogin() },
      name: { type: 'String', resolve: () => viewerLogin() },
      email: { type: 'String!', resolve: () => '' },
      url: { type: 'URI!', resolve: () => `https://github.com/${viewerLogin()}` },
      avatarUrl: { type: 'URI!', args: { size: 'Int' }, resolve: () => 'https://avatars.githubusercontent.com/u/1?v=4' },
      isViewer: { type: 'Boolean!', resolve: () => true },
      repositories: { type: 'RepositoryConnection!', args: PAGE_ARGS, resolve: (_user, args) => connection(allRepos().map(repoNode), args) },
      repository: { type: 'Repository', args: { name: 'String!' }, resolve: (_user, args) => (repoByName(String(args.name)) === null ? null : repoNode(repoByName(String(args.name)) as Repo)) },
    },
  },
  {
    kind: 'OBJECT',
    name: 'Label',
    implements: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (label: Label) => `LA_${label.id}` },
      name: { type: 'String!' },
      color: { type: 'String!' },
      description: { type: 'String' },
    },
  },
  ...connectionTypes('Label', 'Label'),
  {
    kind: 'OBJECT',
    name: 'Commit',
    implements: ['Node', 'GitObject'],
    fields: {
      id: { type: 'ID!', resolve: (c: { oid: string }) => `C_${c.oid}` },
      oid: { type: 'GitObjectID!' },
      abbreviatedOid: { type: 'String!', resolve: (c: { oid: string }) => c.oid.slice(0, 7) },
      message: { type: 'String!', resolve: (c: { oid: string }) => readCommit(c.oid).message.replace(/\n+$/, '') },
      messageHeadline: { type: 'String!', resolve: (c: { oid: string }) => readCommit(c.oid).message.split('\n')[0] },
      committedDate: { type: 'DateTime!', resolve: (c: { oid: string }) => commitStamp(c.oid) },
      authoredDate: { type: 'DateTime!', resolve: (c: { oid: string }) => commitStamp(c.oid) },
    },
  },
  {
    kind: 'OBJECT',
    name: 'Ref',
    description: 'A branch or a tag.',
    implements: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (ref: RefNode) => `REF_${Buffer.from(`${ref.repo.id}:${ref.prefix}${ref.name}`).toString('base64url')}` },
      name: { type: 'String!' },
      prefix: { type: 'String!' },
      target: { type: 'GitObject', resolve: (ref: RefNode) => (getObject(ref.oid)?.type === 'commit' ? { oid: ref.oid } : null) },
      repository: { type: 'Repository!', resolve: (ref: RefNode) => repoNode(ref.repo) },
    },
  },
  ...connectionTypes('Ref', 'Ref'),
  { kind: 'OBJECT', name: 'IssueComment', implements: ['Node'], fields: commentFields },
  ...connectionTypes('IssueComment', 'IssueComment'),
  {
    kind: 'OBJECT',
    name: 'Issue',
    implements: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (n: IssueNode) => n.issue.nodeId },
      databaseId: { type: 'Int', resolve: (n: IssueNode) => n.issue.id },
      number: { type: 'Int!', resolve: (n: IssueNode) => n.issue.number },
      title: { type: 'String!', resolve: (n: IssueNode) => n.issue.title },
      body: { type: 'String!', resolve: (n: IssueNode) => n.issue.body },
      bodyText: { type: 'String!', resolve: (n: IssueNode) => n.issue.body },
      state: { type: 'IssueState!', resolve: (n: IssueNode) => (n.issue.state === 'open' ? 'OPEN' : 'CLOSED') },
      stateReason: { type: 'IssueStateReason', resolve: (n: IssueNode) => (n.issue.state === 'closed' ? 'COMPLETED' : null) },
      closed: { type: 'Boolean!', resolve: (n: IssueNode) => n.issue.state === 'closed' },
      closedAt: { type: 'DateTime', resolve: (n: IssueNode) => n.issue.closedAt },
      createdAt: { type: 'DateTime!', resolve: (n: IssueNode) => n.issue.createdAt },
      updatedAt: { type: 'DateTime!', resolve: (n: IssueNode) => n.issue.updatedAt },
      url: { type: 'URI!', resolve: (n: IssueNode) => webUrl(n.repo, `/issues/${n.issue.number}`) },
      author: actor,
      authorAssociation: { type: 'String!', resolve: () => 'OWNER' },
      locked: { type: 'Boolean!', resolve: () => false },
      isPinned: { type: 'Boolean', resolve: () => false },
      repository: { type: 'Repository!', resolve: (n: IssueNode) => repoNode(n.repo) },
      labels: { type: 'LabelConnection', args: PAGE_ARGS, resolve: (n: IssueNode, args) => connection(n.issue.labels, args) },
      comments: { type: 'IssueCommentConnection!', args: PAGE_ARGS, resolve: (n: IssueNode, args) => commentsOf(n.repo, n.issue.number, n.issue.comments, args) },
    },
  },
  ...connectionTypes('Issue', 'Issue'),
  {
    kind: 'OBJECT',
    name: 'PullRequestChangedFile',
    fields: { path: { type: 'String!' }, additions: { type: 'Int!' }, deletions: { type: 'Int!' }, changeType: { type: 'PatchStatus!' } },
  },
  ...connectionTypes('PullRequestChangedFile', 'PullRequestChangedFile'),
  {
    kind: 'OBJECT',
    name: 'PullRequest',
    implements: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (n: PullNode) => n.pull.nodeId },
      databaseId: { type: 'Int', resolve: (n: PullNode) => n.pull.id },
      number: { type: 'Int!', resolve: (n: PullNode) => n.pull.number },
      title: { type: 'String!', resolve: (n: PullNode) => n.pull.title },
      body: { type: 'String!', resolve: (n: PullNode) => n.pull.body },
      bodyText: { type: 'String!', resolve: (n: PullNode) => n.pull.body },
      state: { type: 'PullRequestState!', resolve: (n: PullNode) => pullState(n.pull) },
      merged: { type: 'Boolean!', resolve: (n: PullNode) => n.pull.merged },
      closed: { type: 'Boolean!', resolve: (n: PullNode) => n.pull.state === 'closed' },
      isDraft: { type: 'Boolean!', resolve: () => false },
      mergeable: { type: 'MergeableState!', resolve: (n: PullNode) => (n.pull.state !== 'open' ? 'UNKNOWN' : pullMergeable(n.repo, n.pull) ? 'MERGEABLE' : 'CONFLICTING') },
      headRefName: { type: 'String!', resolve: (n: PullNode) => n.pull.head },
      baseRefName: { type: 'String!', resolve: (n: PullNode) => n.pull.base },
      headRefOid: { type: 'GitObjectID!', resolve: (n: PullNode) => n.pull.headSha },
      baseRefOid: { type: 'GitObjectID!', resolve: (n: PullNode) => n.pull.baseSha },
      isCrossRepository: { type: 'Boolean!', resolve: () => false },
      headRepositoryOwner: { type: 'RepositoryOwner', resolve: () => VIEWER },
      headRepository: { type: 'Repository', resolve: (n: PullNode) => repoNode(n.repo) },
      baseRepository: { type: 'Repository', resolve: (n: PullNode) => repoNode(n.repo) },
      repository: { type: 'Repository!', resolve: (n: PullNode) => repoNode(n.repo) },
      mergeCommit: { type: 'Commit', resolve: (n: PullNode) => (n.pull.mergeCommitSha === null ? null : { oid: n.pull.mergeCommitSha }) },
      mergedAt: { type: 'DateTime', resolve: (n: PullNode) => n.pull.mergedAt },
      closedAt: { type: 'DateTime', resolve: (n: PullNode) => n.pull.closedAt },
      createdAt: { type: 'DateTime!', resolve: (n: PullNode) => n.pull.createdAt },
      updatedAt: { type: 'DateTime!', resolve: (n: PullNode) => n.pull.updatedAt },
      url: { type: 'URI!', resolve: (n: PullNode) => webUrl(n.repo, `/pull/${n.pull.number}`) },
      author: actor,
      authorAssociation: { type: 'String!', resolve: () => 'OWNER' },
      additions: { type: 'Int!', resolve: (n: PullNode) => pullFiles(n.repo, n.pull).reduce((sum, file) => sum + file.additions, 0) },
      deletions: { type: 'Int!', resolve: (n: PullNode) => pullFiles(n.repo, n.pull).reduce((sum, file) => sum + file.deletions, 0) },
      changedFiles: { type: 'Int!', resolve: (n: PullNode) => pullFiles(n.repo, n.pull).length },
      files: {
        type: 'PullRequestChangedFileConnection',
        args: PAGE_ARGS,
        resolve: (n: PullNode, args) =>
          connection(
            pullFiles(n.repo, n.pull).map((file) => ({
              path: file.change.path,
              additions: file.additions,
              deletions: file.deletions,
              changeType: file.change.status === 'added' ? 'ADDED' : file.change.status === 'removed' ? 'DELETED' : 'MODIFIED',
            })),
            args,
          ),
      },
      labels: { type: 'LabelConnection', args: PAGE_ARGS, resolve: (_n, args) => connection([], args) },
      comments: { type: 'IssueCommentConnection!', args: PAGE_ARGS, resolve: (n: PullNode, args) => commentsOf(n.repo, n.pull.number, n.pull.comments, args) },
    },
  },
  ...connectionTypes('PullRequest', 'PullRequest'),
  {
    kind: 'OBJECT',
    name: 'Repository',
    implements: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (n: RepoNode) => n.repo.nodeId },
      databaseId: { type: 'Int', resolve: (n: RepoNode) => n.repo.id },
      name: { type: 'String!', resolve: (n: RepoNode) => n.repo.name },
      nameWithOwner: { type: 'String!', resolve: (n: RepoNode) => `${viewerLogin()}/${n.repo.name}` },
      owner: { type: 'RepositoryOwner!', resolve: () => VIEWER },
      description: { type: 'String', resolve: (n: RepoNode) => n.repo.description },
      url: { type: 'URI!', resolve: (n: RepoNode) => webUrl(n.repo) },
      sshUrl: { type: 'String!', resolve: (n: RepoNode) => `git@github.com:${viewerLogin()}/${n.repo.name}.git` },
      isPrivate: { type: 'Boolean!', resolve: (n: RepoNode) => n.repo.private },
      visibility: { type: 'RepositoryVisibility!', resolve: (n: RepoNode) => (n.repo.private ? 'PRIVATE' : 'PUBLIC') },
      isFork: { type: 'Boolean!', resolve: () => false },
      isArchived: { type: 'Boolean!', resolve: () => false },
      isEmpty: { type: 'Boolean!', resolve: (n: RepoNode) => n.repo.refs.size === 0 },
      parent: { type: 'Repository', resolve: () => null },
      viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
      viewerCanAdminister: { type: 'Boolean!', resolve: () => true },
      hasIssuesEnabled: { type: 'Boolean!', resolve: () => true },
      hasWikiEnabled: { type: 'Boolean!', resolve: () => false },
      mergeCommitAllowed: { type: 'Boolean!', resolve: () => true },
      squashMergeAllowed: { type: 'Boolean!', resolve: () => true },
      rebaseMergeAllowed: { type: 'Boolean!', resolve: () => true },
      createdAt: { type: 'DateTime!', resolve: (n: RepoNode) => n.repo.createdAt },
      updatedAt: { type: 'DateTime!', resolve: (n: RepoNode) => n.repo.updatedAt },
      pushedAt: { type: 'DateTime', resolve: (n: RepoNode) => n.repo.pushedAt },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (n: RepoNode): RefNode | null => {
          const oid = n.repo.refs.get(`refs/heads/${n.repo.defaultBranch}`);
          return oid === undefined ? null : { kind: 'Ref', repo: n.repo, name: n.repo.defaultBranch, prefix: 'refs/heads/', oid };
        },
      },
      ref: {
        type: 'Ref',
        args: { qualifiedName: 'String!' },
        resolve: (n: RepoNode, args): RefNode | null => {
          const asked = String(args.qualifiedName);
          for (const full of [asked, `refs/heads/${asked}`, `refs/tags/${asked}`]) {
            const oid = n.repo.refs.get(full);
            if (oid === undefined) continue;
            const prefix = full.startsWith('refs/tags/') ? 'refs/tags/' : 'refs/heads/';
            return { kind: 'Ref', repo: n.repo, name: full.slice(prefix.length), prefix, oid };
          }
          return null;
        },
      },
      refs: {
        type: 'RefConnection',
        args: { ...PAGE_ARGS, refPrefix: 'String!', query: 'String' },
        resolve: (n: RepoNode, args) => {
          const prefix = String(args.refPrefix);
          const refs: RefNode[] = [];
          for (const [full, oid] of n.repo.refs) if (full.startsWith(prefix)) refs.push({ kind: 'Ref', repo: n.repo, name: full.slice(prefix.length), prefix, oid });
          refs.sort((a, b) => (a.name < b.name ? -1 : 1));
          return connection(refs, args);
        },
      },
      issue: {
        type: 'Issue',
        args: { number: 'Int!' },
        resolve: (n: RepoNode, args) => {
          const issue = n.repo.issues.get(Number(args.number));
          if (issue === undefined) throw new FieldError(`Could not resolve to an Issue with the number of ${String(args.number)}.`, 'NOT_FOUND');
          return issueNode(n.repo, issue);
        },
      },
      issues: {
        type: 'IssueConnection!',
        args: { ...PAGE_ARGS, states: '[IssueState!]', labels: '[String!]', orderBy: 'IssueOrder', filterBy: 'IssueFilters' },
        resolve: (n: RepoNode, args) => {
          const states: string[] | null = Array.isArray(args.states) ? args.states : Array.isArray(args.filterBy?.states) ? args.filterBy.states : null;
          const labels: string[] | null = Array.isArray(args.labels) ? args.labels : Array.isArray(args.filterBy?.labels) ? args.filterBy.labels : null;
          const list = [...n.repo.issues.values()].filter(
            (issue) =>
              (states === null || states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED')) &&
              (labels === null || labels.every((name) => issue.labels.some((label) => label.name.toLowerCase() === String(name).toLowerCase()))),
          );
          return connection(sortIssues(list, args.orderBy).map((issue) => issueNode(n.repo, issue)), args);
        },
      },
      pullRequest: {
        type: 'PullRequest',
        args: { number: 'Int!' },
        resolve: (n: RepoNode, args) => {
          const pull = n.repo.pulls.get(Number(args.number));
          if (pull === undefined) throw new FieldError(`Could not resolve to a PullRequest with the number of ${String(args.number)}.`, 'NOT_FOUND');
          return pullNode(n.repo, pull);
        },
      },
      pullRequests: {
        type: 'PullRequestConnection!',
        args: { ...PAGE_ARGS, states: '[PullRequestState!]', headRefName: 'String', baseRefName: 'String', orderBy: 'IssueOrder' },
        resolve: (n: RepoNode, args) => {
          const states: string[] | null = Array.isArray(args.states) ? args.states : null;
          const list = [...n.repo.pulls.values()].filter(
            (pull) =>
              (states === null || states.includes(pullState(pull))) &&
              (typeof args.headRefName !== 'string' || pull.head === args.headRefName) &&
              (typeof args.baseRefName !== 'string' || pull.base === args.baseRefName),
          );
          return connection(sortIssues(list, args.orderBy).map((pull) => pullNode(n.repo, pull)), args);
        },
      },
      issueOrPullRequest: {
        type: 'IssueOrPullRequest',
        args: { number: 'Int!' },
        resolve: (n: RepoNode, args) => {
          const issue = n.repo.issues.get(Number(args.number));
          if (issue !== undefined) return issueNode(n.repo, issue);
          const pull = n.repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullNode(n.repo, pull);
        },
      },
      labels: { type: 'LabelConnection', args: { ...PAGE_ARGS, query: 'String' }, resolve: (n: RepoNode, args) => connection([...n.repo.labels.values()], args) },
      label: { type: 'Label', args: { name: 'String!' }, resolve: (n: RepoNode, args) => n.repo.labels.get(String(args.name).toLowerCase()) ?? null },
    },
  },
  ...connectionTypes('Repository', 'Repository'),
  { kind: 'OBJECT', name: 'RateLimit', fields: { limit: { type: 'Int!' }, cost: { type: 'Int!' }, remaining: { type: 'Int!' }, used: { type: 'Int!' }, resetAt: { type: 'DateTime!' }, nodeCount: { type: 'Int!' } } },
  {
    kind: 'OBJECT',
    name: 'Query',
    fields: {
      viewer: { type: 'User!', resolve: () => VIEWER },
      repository: {
        type: 'Repository',
        args: { owner: 'String!', name: 'String!', followRenames: 'Boolean' },
        resolve: (_root, args) => {
          const repo = findRepo(String(args.owner), String(args.name));
          return repo === null ? null : repoNode(repo);
        },
      },
      repositoryOwner: { type: 'RepositoryOwner', args: { login: 'String!' }, resolve: (_root, args) => (String(args.login).toLowerCase() === viewerLogin().toLowerCase() ? VIEWER : null) },
      user: { type: 'User', args: { login: 'String!' }, resolve: (_root, args) => (String(args.login).toLowerCase() === viewerLogin().toLowerCase() ? VIEWER : null) },
      node: { type: 'Node', args: { id: 'ID!' }, resolve: (_root, args) => findNode(args.id) },
      nodes: { type: '[Node]!', args: { ids: '[ID!]!' }, resolve: (_root, args) => (Array.isArray(args.ids) ? args.ids.map(findNode) : []) },
      rateLimit: { type: 'RateLimit', args: { dryRun: 'Boolean' }, resolve: () => ({ limit: 5000, cost: 1, remaining: 5000, used: 0, resetAt: '2100-01-01T00:00:00Z', nodeCount: 0 }) },
    },
  },
  { kind: 'OBJECT', name: 'CreateRepositoryPayload', fields: { repository: { type: 'Repository' }, clientMutationId: { type: 'String' } } },
  { kind: 'OBJECT', name: 'CreateIssuePayload', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  { kind: 'OBJECT', name: 'UpdateIssuePayload', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  { kind: 'OBJECT', name: 'CloseIssuePayload', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  { kind: 'OBJECT', name: 'ReopenIssuePayload', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  { kind: 'OBJECT', name: 'CreatePullRequestPayload', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  { kind: 'OBJECT', name: 'UpdatePullRequestPayload', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  { kind: 'OBJECT', name: 'ClosePullRequestPayload', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  { kind: 'OBJECT', name: 'ReopenPullRequestPayload', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  { kind: 'OBJECT', name: 'MergePullRequestPayload', fields: { pullRequest: { type: 'PullRequest' }, actor: { type: 'Actor' }, clientMutationId: { type: 'String' } } },
  { kind: 'OBJECT', name: 'AddCommentPayload', fields: { commentEdge: { type: 'IssueCommentEdge' }, subject: { type: 'Node' }, clientMutationId: { type: 'String' } } },
  {
    kind: 'OBJECT',
    name: 'Mutation',
    fields: {
      createRepository: {
        type: 'CreateRepositoryPayload',
        args: { input: 'CreateRepositoryInput!' },
        resolve: (_root, { input }) => guarded(() => ({ repository: repoNode(makeRepo({ name: input.name, description: input.description, private: input.visibility !== 'PUBLIC' })), clientMutationId: input.clientMutationId ?? null })),
      },
      createIssue: {
        type: 'CreateIssuePayload',
        args: { input: 'CreateIssueInput!' },
        resolve: (_root, { input }) =>
          guarded(() => {
            const target = nodeOfKind<RepoNode>(input.repositoryId, 'Repository', 'Repository');
            return { issue: issueNode(target.repo, makeIssue(target.repo, { title: input.title, body: input.body })), clientMutationId: input.clientMutationId ?? null };
          }),
      },
      updateIssue: {
        type: 'UpdateIssuePayload',
        args: { input: 'UpdateIssueInput!' },
        resolve: (_root, { input }) =>
          guarded(() => {
            const target = nodeOfKind<IssueNode>(input.id, 'Issue', 'Issue');
            const state = input.state === 'OPEN' ? 'open' : input.state === 'CLOSED' ? 'closed' : undefined;
            return { issue: issueNode(target.repo, editIssue(target.repo, target.issue, { title: input.title ?? undefined, body: input.body ?? undefined, state })), clientMutationId: input.clientMutationId ?? null };
          }),
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        args: { input: 'CloseIssueInput!' },
        resolve: (_root, { input }) =>
          guarded(() => {
            const target = nodeOfKind<IssueNode>(input.issueId, 'Issue', 'Issue');
            return { issue: issueNode(target.repo, editIssue(target.repo, target.issue, { state: 'closed' })), clientMutationId: input.clientMutationId ?? null };
          }),
      },
      reopenIssue: {
        type: 'ReopenIssuePayload',
        args: { input: 'ReopenIssueInput!' },
        resolve: (_root, { input }) =>
          guarded(() => {
            const target = nodeOfKind<IssueNode>(input.issueId, 'Issue', 'Issue');
            return { issue: issueNode(target.repo, editIssue(target.repo, target.issue, { state: 'open' })), clientMutationId: input.clientMutationId ?? null };
          }),
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        args: { input: 'CreatePullRequestInput!' },
        resolve: (_root, { input }) =>
          guarded(() => {
            const target = nodeOfKind<RepoNode>(input.repositoryId, 'Repository', 'Repository');
            if (branchTip(target.repo, String(input.headRefName).replace(/^.*:/, '')) === null) throw new FieldError(`Head ref '${String(input.headRefName)}' could not be found`, 'UNPROCESSABLE');
            return { pullRequest: pullNode(target.repo, makePull(target.repo, { title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName })), clientMutationId: input.clientMutationId ?? null };
          }),
      },
      updatePullRequest: {
        type: 'UpdatePullRequestPayload',
        args: { input: 'UpdatePullRequestInput!' },
        resolve: (_root, { input }) =>
          guarded(() => {
            const target = nodeOfKind<PullNode>(input.pullRequestId, 'PullRequest', 'PullRequest');
            const state = input.state === 'OPEN' ? 'open' : input.state === 'CLOSED' ? 'closed' : undefined;
            return { pullRequest: pullNode(target.repo, editPull(target.repo, target.pull, { title: input.title ?? undefined, body: input.body ?? undefined, base: input.baseRefName ?? undefined, state })), clientMutationId: input.clientMutationId ?? null };
          }),
      },
      closePullRequest: {
        type: 'ClosePullRequestPayload',
        args: { input: 'ClosePullRequestInput!' },
        resolve: (_root, { input }) =>
          guarded(() => {
            const target = nodeOfKind<PullNode>(input.pullRequestId, 'PullRequest', 'PullRequest');
            return { pullRequest: pullNode(target.repo, editPull(target.repo, target.pull, { state: 'closed' })), clientMutationId: input.clientMutationId ?? null };
          }),
      },
      reopenPullRequest: {
        type: 'ReopenPullRequestPayload',
        args: { input: 'ReopenPullRequestInput!' },
        resolve: (_root, { input }) =>
          guarded(() => {
            const target = nodeOfKind<PullNode>(input.pullRequestId, 'PullRequest', 'PullRequest');
            return { pullRequest: pullNode(target.repo, editPull(target.repo, target.pull, { state: 'open' })), clientMutationId: input.clientMutationId ?? null };
          }),
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        args: { input: 'MergePullRequestInput!' },
        resolve: (_root, { input }) =>
          guarded(() => {
            const target = nodeOfKind<PullNode>(input.pullRequestId, 'PullRequest', 'PullRequest');
            const method = input.mergeMethod === 'SQUASH' ? 'squash' : input.mergeMethod === 'REBASE' ? 'rebase' : 'merge';
            mergePull(target.repo, target.pull, { merge_method: method, commit_title: input.commitHeadline ?? undefined, commit_message: input.commitBody ?? undefined, sha: input.expectedHeadOid ?? undefined });
            return { pullRequest: pullNode(target.repo, target.pull), actor: VIEWER, clientMutationId: input.clientMutationId ?? null };
          }),
      },
      addComment: {
        type: 'AddCommentPayload',
        args: { input: 'AddCommentInput!' },
        resolve: (_root, { input }) =>
          guarded(() => {
            const subject = findNode(input.subjectId) as IssueNode | PullNode | null;
            if (subject === null || (subject.kind !== 'Issue' && subject.kind !== 'PullRequest')) {
              throw new FieldError(`Could not resolve to a node with the global id of '${String(input.subjectId)}'`, 'NOT_FOUND');
            }
            const on = subject.kind === 'Issue' ? subject.issue : subject.pull;
            const comment = makeComment(on, input.body);
            const node: CommentNode = { kind: 'IssueComment', repo: subject.repo, number: on.number, comment };
            return { commentEdge: { node, cursor: cursorOf(on.comments.length - 1) }, subject, clientMutationId: input.clientMutationId ?? null };
          }),
      },
    },
  },
];

export const schema: Schema = makeSchema(TYPES, 'Query', 'Mutation');
