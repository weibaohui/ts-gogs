// Home & explore routes.
import type { Context } from '../context.js';
import { conf } from '../conf.js';
import * as db from '../db/db.js';

export async function Home(c: Context): Promise<void> {
  if (c.IsLogged) {
    userDashboard(c);
    return;
  }
  // anonymous landing page is the React SPA in current gogs
  c.ServeWeb();
}

function userDashboard(c: Context): void {
  const user0 = c.User!;
  c.Data['Title'] = user0.DisplayName();
  c.Data['PageIsDashboard'] = true;
  c.Data['PageIsNews'] = true;
  c.Data['ContextUser'] = user0;

  // mirrored feeds: actions of self + followed users
  const rows = db
    .db()
    .prepare(
      `SELECT * FROM action WHERE user_id = ? ORDER BY id DESC LIMIT 20`
    )
    .all(user0.id) as any[];
  c.Data['Feeds'] = rows.map(feedAction);
  for (const f of c.Data['Feeds'] as any[]) db.goAlias(f);

  // collaborations (repos of others user has access to)
  const collab = db
    .db()
    .prepare(
      `SELECT r.* FROM repository r JOIN collaboration col ON col.repo_id = r.id
       WHERE col.user_id = ? ORDER BY r.updated_unix DESC`
    )
    .all(user0.id) as any[];
  c.Data['CollaborateCount'] = collab.length;
  c.Data['Collaborators'] = collab.map((r) => {
    const repo = new db.Repository(r);
    repo.owner = db.getUserByID(repo.owner_id) ?? undefined;
    return repo;
  });

  const myRepos = db.listReposByOwner(user0.id);
  c.Data['MyRepos'] = myRepos;
  c.Data['RepoCount'] = myRepos.length;
  c.Data['MyOrgs'] = db.listUserOrgs(user0.id, true);
  c.Data['OrgCount'] = c.Data['MyOrgs'].length;
  c.Data['MyMirrors'] = myRepos.filter((r) => r.is_mirror);
  c.Data['MirrorCount'] = c.Data['MyMirrors'].length;
  c.Success('user/dashboard/dashboard');
}

export function feedAction(row: any): any {
  // lightweight Action wrapper with the methods templates use
  const a: any = { ...row };
  a.GetOpType = () => a.op_type;
  a.GetActUserName = () => a.act_user_name;
  a.GetRepoUserName = () => a.repo_user_name;
  a.GetRepoName = () => a.repo_name;
  a.GetRepoPath = () => `${a.repo_user_name}/${a.repo_name}`;
  a.GetRepoLink = () => conf.subpath + '/' + a.GetRepoPath();
  a.GetBranch = () => a.ref_name;
  a.GetContent = () => a.content ?? '';
  a.GetCreate = () => new Date((a.created_unix ?? 0) * 1000);
  a.GetIssueInfos = () => {
    const parts = String(a.content ?? '').split('|');
    return parts.length ? parts : [''];
  };
  a.ShortRepoPath = () => {
    const p = a.GetRepoPath();
    return p.length > 40 ? p.slice(0, 34) + '…' : p;
  };
  a.ActAvatar = () => {
    const u = db.getUserByUsername(a.act_user_name);
    return u ? u.AvatarURLPath() : conf.subpath + '/img/avatar_default.png';
  };
  return a;
}

export async function ExploreRepos(c: Context): Promise<void> {
  c.Data['Title'] = c.Tr('explore');
  c.Data['PageIsExplore'] = true;
  c.Data['PageIsExploreRepositories'] = true;
  const keyword = c.Query('q');
  const page = Math.max(1, c.QueryInt('page'));
  c.Data['Keyword'] = keyword;
  const { total, repos } = db.listVisibleRepos(c.UserID(), keyword, page, conf.explorePagingNum);
  c.Data['Repos'] = repos;
  c.Data['Total'] = total;
  c.Data['Page'] = newPaginater(total, conf.explorePagingNum, page, 5);
  c.Data['PageIsHome'] = false;
  c.Success('explore/repos');
}

export async function ExploreUsers(c: Context): Promise<void> {
  c.Data['Title'] = c.Tr('home.search_users');
  c.Data['PageIsExplore'] = true;
  c.Data['PageIsExploreUsers'] = true;
  const keyword = `%${c.Query('q').toLowerCase()}%`;
  const page = Math.max(1, c.QueryInt('page'));
  const size = conf.explorePagingNum;
  const total = (db.db().prepare('SELECT COUNT(*) AS c FROM user WHERE type = 0 AND (lower_name LIKE ? OR lower(full_name) LIKE ?)').get(keyword, keyword) as any).c;
  const rows = db
    .db()
    .prepare('SELECT * FROM user WHERE type = 0 AND (lower_name LIKE ? OR lower(full_name) LIKE ?) ORDER BY num_followers DESC LIMIT ? OFFSET ?')
    .all(keyword, keyword, size, (page - 1) * size) as any[];
  c.Data['Users'] = rows.map((r) => new db.User(r));
  c.Data['Keyword'] = c.Query('q');
  c.Data['Total'] = total;
  c.Data['Page'] = newPaginater(total, size, page, 5);
  c.Success('explore/users');
}

export async function ExploreOrganizations(c: Context): Promise<void> {
  c.Data['Title'] = c.Tr('explore.organizations');
  c.Data['PageIsExplore'] = true;
  c.Data['PageIsExploreOrganizations'] = true;
  const keyword = `%${c.Query('q').toLowerCase()}%`;
  const page = Math.max(1, c.QueryInt('page'));
  const size = conf.explorePagingNum;
  const total = (db.db().prepare('SELECT COUNT(*) AS c FROM user WHERE type = 1 AND (lower_name LIKE ? OR lower(full_name) LIKE ?)').get(keyword, keyword) as any).c;
  const rows = db
    .db()
    .prepare('SELECT * FROM user WHERE type = 1 AND (lower_name LIKE ? OR lower(full_name) LIKE ?) ORDER BY updated_unix DESC LIMIT ? OFFSET ?')
    .all(keyword, keyword, size, (page - 1) * size) as any[];
  c.Data['Users'] = rows.map((r) => new db.User(r));
  c.Data['Keyword'] = c.Query('q');
  c.Data['Total'] = total;
  c.Data['Page'] = newPaginater(total, size, page, 5);
  c.Success('explore/organizations');
}

/** unknwon/paginater compatible helper. */
export function newPaginater(total: number, pagingNum: number, current: number, numPages: number): any {
  pagingNum = pagingNum > 0 ? pagingNum : 1;
  current = current > 0 ? current : 1;
  const totalPages = total === 0 ? 1 : Math.ceil(total / pagingNum);
  if (current > totalPages) current = totalPages;

  const pagesWindow = (): any[] => {
    if (numPages >= totalPages) {
      return Array.from({ length: totalPages }, (_, i) => ({ Num: i + 1, IsCurrent: i + 1 === current }));
    }
    const startNum = Math.max(current - (numPages - 1) / 2, 1);
    let endNum = Math.min(current + (numPages - 1) / 2, totalPages);
    endNum = Math.min(endNum, startNum + numPages - 1);
    const pages: any[] = [];
    if (startNum > 2) pages.push({ Num: -1 });
    else if (startNum > 1) pages.unshift({ Num: 1 });
    for (let i = startNum; i <= endNum; i++) pages.push({ Num: i, IsCurrent: i === current });
    if (endNum < totalPages - 1) pages.push({ Num: -1 });
    else if (endNum < totalPages) pages.push({ Num: totalPages });
    return pages;
  };

  return {
    Total: total,
    PagingNum: pagingNum,
    Current: current,
    NumPages: numPages,
    TotalPages: () => totalPages,
    IsFirst: () => current === 1,
    IsLast: () => total === 0 || (total > (current - 1) * pagingNum && total <= current * pagingNum),
    HasPrevious: () => current > 1,
    Previous: () => (current > 1 ? current - 1 : current),
    HasNext: () => total > current * pagingNum,
    Next: () => (total > current * pagingNum ? current + 1 : current),
    HasPages: () => totalPages > 1,
    Pages: pagesWindow,
  };
}
