// Activity stream (action table) + webhook triggering, mirroring gogs
// internal/database/actions.go semantics.
import * as db from './db.js';
import { nowUnix, Row } from './db.js';
import { conf } from '../conf.js';
import { deliverWebhook } from '../webhook.js';

export const ActionType = {
  CREATE_REPO: 1,
  RENAME_REPO: 2,
  STAR_REPO: 3,
  WATCH_REPO: 4,
  COMMIT_REPO: 5,
  CREATE_ISSUE: 6,
  CREATE_PULL_REQUEST: 7,
  TRANSFER_REPO: 8,
  PUSH_TAG: 9,
  COMMENT_ISSUE: 10,
  MERGE_PULL_REQUEST: 11,
  CLOSE_ISSUE: 12,
  REOPEN_ISSUE: 13,
  CLOSE_PULL_REQUEST: 14,
  REOPEN_PULL_REQUEST: 15,
  CREATE_BRANCH: 16,
  DELETE_BRANCH: 17,
  DELETE_TAG: 18,
  FORK_REPO: 19,
  MIRROR_SYNC_PUSH: 20,
  MIRROR_SYNC_CREATE: 21,
  MIRROR_SYNC_DELETE: 22,
} as const;

export interface PushCommit {
  /** gogs serializes push commits with `Sha1` */
  Sha1: string;
  ID?: string;
  Message: string;
  AuthorEmail?: string;
}

export interface PushCommits {
  TotalCommits: number;
  Len?: number;
  Commits: PushCommit[];
  Compares?: any[];
  CompareURL?: string;
}

function newAction(opts: {
  opType: number;
  doer: db.User;
  repo: db.Repository;
  refName?: string;
  content?: string;
}): void {
  db.db()
    .prepare(
      `INSERT INTO action (user_id, op_type, act_user_id, act_user_name, repo_id, repo_user_name, repo_name, ref_name, is_private, content, created_unix)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      opts.repo.owner_id, // feed receiver = repo owner (simplified; gogs also inserts for watchers)
      opts.opType,
      opts.doer.id,
      opts.doer.name,
      opts.repo.id,
      opts.repo.OwnerName(),
      opts.repo.name,
      opts.refName ?? '',
      opts.repo.is_private ?? 0,
      opts.content ?? '',
      nowUnix()
    );
}

export function createRepoAction(doer: db.User, repo: db.Repository): void {
  newAction({ opType: ActionType.CREATE_REPO, doer, repo });
}

export function forkRepoAction(doer: db.User, repo: db.Repository): void {
  newAction({ opType: ActionType.FORK_REPO, doer, repo });
}

export async function commitRepoAction(doer: db.User, repo: db.Repository, refName: string, commits: PushCommits): Promise<void> {
  const shortRef = refName.replace('refs/heads/', '');
  newAction({
    opType: ActionType.COMMIT_REPO,
    doer,
    repo,
    refName: shortRef,
    content: JSON.stringify(commits),
  });
  deliverHooks(repo, 'push', pushPayload(doer, repo, refName, commits));
}

export async function pushTagAction(doer: db.User, repo: db.Repository, tagName: string): Promise<void> {
  newAction({ opType: ActionType.PUSH_TAG, doer, repo, refName: tagName });
  deliverHooks(repo, 'create', {
    ref: tagName,
    ref_type: 'tag',
    master_branch: repo.default_branch,
    repository: repoJSON(repo),
    pusher: userJSON(doer),
    sender: userJSON(doer),
  });
}

export function deleteBranchAction(doer: db.User, repo: db.Repository, branch: string): void {
  newAction({ opType: ActionType.DELETE_BRANCH, doer, repo, refName: branch });
  deliverHooks(repo, 'delete', {
    ref: branch,
    ref_type: 'branch',
    pusher_type: 'user',
    repository: repoJSON(repo),
    sender: userJSON(doer),
  });
}

export function createBranchAction(doer: db.User, repo: db.Repository, branch: string): void {
  newAction({ opType: ActionType.CREATE_BRANCH, doer, repo, refName: branch });
  deliverHooks(repo, 'create', {
    ref: branch,
    ref_type: 'branch',
    master_branch: repo.default_branch,
    repository: repoJSON(repo),
    pusher: userJSON(doer),
    sender: userJSON(doer),
  });
}

export async function issueAction(opType: number, doer: db.User, repo: db.Repository, issue: Row, content?: string): Promise<void> {
  newAction({ opType, doer, repo, refName: '', content: content ?? String(issue.index) });
  const eventType =
    opType === ActionType.CREATE_ISSUE
      ? 'issues'
      : opType === ActionType.CREATE_PULL_REQUEST
        ? 'pull_request'
        : opType === ActionType.COMMENT_ISSUE
          ? 'issue_comment'
          : 'issues';
  const payload = issuePayload(opType, doer, repo, issue);
  deliverHooks(repo, eventType, payload);
}

function issueActionLabel(opType: number): string {
  switch (opType) {
    case ActionType.CLOSE_ISSUE:
      return 'closed';
    case ActionType.REOPEN_ISSUE:
      return 'reopened';
    default:
      return '';
  }
}

function issuePayload(opType: number, doer: db.User, repo: db.Repository, issue: Row): any {
  const action = issueActionLabel(opType);
  return {
    action: action || undefined,
    number: issue.index,
    issue: {
      id: issue.id,
      number: issue.index,
      title: issue.name,
      body: issue.content ?? '',
      user: userJSON(doer),
      state: issue.is_closed ? 'closed' : 'open',
      comments: issue.num_comments ?? 0,
      html_url: conf.externalURL + repo.FullName() + '/issues/' + issue.index,
    },
    repository: repoJSON(repo),
    sender: userJSON(doer),
  };
}

function pushPayload(doer: db.User, repo: db.Repository, refName: string, commits: PushCommits): any {
  return {
    ref: refName,
    before: '',
    after: '',
    compare_url: '',
    commits: commits.Commits.map((c) => ({
      id: c.ID,
      message: c.Message,
      url: 'Not implemented',
      author: { name: c.AuthorEmail ?? '', email: c.AuthorEmail ?? '', username: '' },
      committer: { name: '', email: '', username: '' },
      added: null,
      removed: null,
      modified: null,
      timestamp: new Date().toISOString(),
    })),
    total_commits: commits.TotalCommits,
    head_commit: null,
    repository: repoJSON(repo),
    pusher: userJSON(doer),
    sender: userJSON(doer),
  };
}

export function userJSON(u: db.User): any {
  return {
    id: u.id,
    username: u.name,
    login: u.name,
    full_name: u.full_name,
    email: u.email,
    avatar_url: u.AvatarURL(),
  };
}

export function repoJSON(repo: db.Repository): any {
  return {
    id: repo.id,
    owner: userJSON(repo.owner!),
    name: repo.name,
    full_name: repo.FullName(),
    description: repo.description ?? '',
    private: !!repo.is_private,
    fork: !!repo.is_fork,
    html_url: repo.HTMLURL(),
    ssh_url: repo.CloneURL(),
    clone_url: repo.CloneURL(),
    website: repo.website ?? '',
    stars_count: repo.num_stars,
    forks_count: repo.num_forks,
    watchers_count: repo.num_watches,
    open_issues_count: repo.num_issues - repo.num_closed_issues,
    default_branch: repo.default_branch,
    created_at: new Date((repo.created_unix ?? 0) * 1000).toISOString(),
    updated_at: new Date((repo.updated_unix ?? 0) * 1000).toISOString(),
  };
}

/** Queue webhook deliveries for all active hooks of the repo. */
function deliverHooks(repo: db.Repository, eventType: string, payload: any): void {
  const hooks = db.db().prepare('SELECT * FROM webhook WHERE repo_id = ? AND is_active = 1').all(repo.id) as Row[];
  for (const hook of hooks) {
    deliverWebhook(hook, eventType, payload, repo);
  }
}
