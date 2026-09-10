// User profile, dashboard, follow/star actions, settings, attachments.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '../context.js';
import { conf } from '../conf.js';
import * as db from '../db/db.js';
import { newPaginater } from './home.js';
import { feedAction } from './home.js';

export function InjectParamsUser(): (c: Context) => void {
  return (c: Context) => {
    const u = db.getUserByUsername(c.Params(':username'));
    if (!u) {
      c.NotFound();
      return;
    }
    c.Data['ContextUser'] = u;
    (c as any).ContextUser = u;
  };
}

function contextUser(c: Context): db.User {
  return (c as any).ContextUser ?? c.Data['ContextUser'] ?? c.User!;
}

export async function Profile(c: Context): Promise<void> {
  const u = contextUser(c);
  c.Data['Title'] = u.DisplayName();
  c.Data['PageIsUserProfile'] = true;
  c.Data['Owner'] = u;
  c.Data['Orgs'] = db.listUserOrgs(u.id, true);

  const tab = c.Query('tab');
  c.Data['TabName'] = tab;

  if (tab === 'activity') {
    // activity feed: actions by this user, private repos hidden from guests
    const rows = db
      .db()
      .prepare(
        `SELECT a.* FROM action a JOIN repository r ON r.id = a.repo_id
         WHERE a.act_user_id = ? AND (r.is_private = 0 OR r.owner_id = ?)
         ORDER BY a.id DESC LIMIT 20`
      )
      .all(u.id, c.UserID()) as any[];
    c.Data['Feeds'] = rows.map(feedAction);
    for (const f of c.Data['Feeds'] as any[]) db.goAlias(f);
    c.Success('user/profile');
    return;
  }

  // repositories tab
  const showPrivate = c.IsLogged && (c.UserID() === u.id || c.User!.is_admin === 1);
  const repos = db.listReposByOwner(u.id).filter((r) => showPrivate || !r.is_private);
  c.Data['Repos'] = repos;
  c.Data['Total'] = repos.length;
  const page = Math.max(1, c.QueryInt('page'));
  c.Data['Page'] = newPaginater(repos.length, 15, page, 5);

  if (c.IsLogged) {
    c.Data['IsFollowing'] = db.isFollowing(c.UserID(), u.id);
  }
  c.Success('user/profile');
}

export async function Followers(c: Context): Promise<void> {
  const u = contextUser(c);
  c.Data['Title'] = c.Tr('user.followers');
  c.Data['Owner'] = u;
  c.Data['PageIsFollowers'] = true;
  c.Data['CardsTitle'] = c.Tr('user.followers');
  c.Data['Cards'] = db.listFollowers(u.id, 1, 100);
  const total = (db.db().prepare('SELECT COUNT(*) AS c FROM follow WHERE follow_id = ?').get(u.id) as any).c;
  c.Data['Total'] = total;
  c.Success('user/meta/followers');
}

export async function Following(c: Context): Promise<void> {
  const u = contextUser(c);
  c.Data['Title'] = c.Tr('user.following');
  c.Data['Owner'] = u;
  c.Data['PageIsFollowing'] = true;
  c.Data['CardsTitle'] = c.Tr('user.following');
  c.Data['Cards'] = db.listFollowing(u.id, 1, 100);
  const total = (db.db().prepare('SELECT COUNT(*) AS c FROM follow WHERE user_id = ?').get(u.id) as any).c;
  c.Data['Total'] = total;
  c.Success('user/meta/followers');
}

export async function Stars(c: Context): Promise<void> {
  const u = contextUser(c);
  c.Data['Title'] = c.Tr('user.starred');
  c.Data['Owner'] = u;
  c.Data['PageIsStars'] = true;
  c.Data['Repos'] = db.listStarredRepos(u.id);
  c.Success('user/meta/stars');
}

/** POST /:username/action/:action — follow/unfollow, and repo watch/star via repo action. */
export async function Action(c: Context): Promise<void> {
  const u = contextUser(c);
  const action = c.Params(':action');
  switch (action) {
    case 'follow':
      db.followUser(c.UserID(), u.id);
      break;
    case 'unfollow':
      db.unfollowUser(c.UserID(), u.id);
      break;
    default: {
      // repo-level actions fall through to repo.Action; here only profile ones
      const repoName = c.Query('repo');
      if (repoName) {
        const repo = db.getRepoByName(u.name, repoName);
        if (repo) {
          const { repoUserAction } = await import('./repo.js');
          repoUserAction(c, repo, action);
          return;
        }
      }
      c.NotFound();
      return;
    }
  }
  const redirectTo = c.Query('redirect_to') || u.HomeURLPath();
  c.Redirect(decodeURIComponent(redirectTo));
}

export async function Dashboard(c: Context): Promise<void> {
  // org dashboard reuses user dashboard template
  const { feedAction } = await import('./home.js');
  const orgName = c.Params(':org');
  const org = orgName ? db.getUserByUsername(orgName) : null;
  c.Data['Title'] = org ? org.DisplayName() : c.User!.DisplayName();
  c.Data['PageIsDashboard'] = true;
  c.Data['PageIsNews'] = true;
  const rows = db.db().prepare('SELECT * FROM action WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(org ? org.id : c.UserID()) as any[];
  c.Data['Feeds'] = rows.map(feedAction);
  for (const f of c.Data['Feeds'] as any[]) db.goAlias(f);
  const myRepos = db.listReposByOwner(org ? org.id : c.UserID());
  c.Data['MyRepos'] = myRepos;
  c.Data['RepoCount'] = myRepos.length;
  c.Data['MyOrgs'] = db.listUserOrgs(c.UserID(), true);
  c.Data['OrgCount'] = c.Data['MyOrgs'].length;
  c.Data['MyMirrors'] = myRepos.filter((r) => r.is_mirror);
  c.Data['MirrorCount'] = c.Data['MyMirrors'].length;
  const collab = db.db().prepare('SELECT r.* FROM repository r JOIN collaboration col ON col.repo_id = r.id WHERE col.user_id = ?').all(c.UserID()) as any[];
  c.Data['Collaborators'] = collab.map((r) => {
    const repo = new db.Repository(r);
    repo.owner = db.getUserByID(repo.owner_id) ?? undefined;
    return repo;
  });
  c.Data['CollaborateCount'] = collab.length;
  if (org) c.Data['ContextUser'] = org;
  c.Success('user/dashboard/dashboard');
}

/** /user/issues and /:type(issues|pulls) — issues across repos. */
export async function Issues(c: Context): Promise<void> {
  const isPull = c.Params(':type') === 'pulls';
  c.Data['Title'] = c.Tr(isPull ? 'pullsyour' : 'issuesyour');
  c.Data['PageIsDashboard'] = true;
  c.Data['ViewType'] = isPull ? 'pulls' : 'issues';
  const page = Math.max(1, c.QueryInt('page'));
  const state = c.Query('state') === 'closed' ? 1 : 0;
  c.Data['IsShowClosed'] = state === 1;
  const size = conf.issuePagingNum;
  const where = `i.poster_id = ? AND i.is_pull = ? AND i.is_closed = ?`;
  const total = (db.db().prepare(`SELECT COUNT(*) AS c FROM issue i WHERE ${where}`).get(c.UserID(), isPull ? 1 : 0, state) as any).c;
  const rows = db
    .db()
    .prepare(`SELECT i.*, r.name AS repo_name, r.is_private FROM issue i JOIN repository r ON r.id = i.repo_id WHERE ${where} ORDER BY i.updated_unix DESC LIMIT ? OFFSET ?`)
    .all(c.UserID(), isPull ? 1 : 0, state, size, (page - 1) * size) as any[];
  const issues = rows.map((r) => {
    const repo = new db.Repository({ id: r.repo_id, name: r.repo_name });
    return { ...r, Repo: repo };
  });
  c.Data['Issues'] = issues;
  c.Data['Total'] = total;
  c.Data['Page'] = newPaginater(total, size, page, 5);
  c.Success('user/dashboard/issues');
}

export async function Attachment(c: Context): Promise<void> {
  const uuid = c.Params(':uuid');
  const row = db.db().prepare('SELECT * FROM attachment WHERE uuid = ?').get(uuid) as any;
  if (!row) {
    c.NotFound();
    return;
  }
  const localPath = path.join(conf.appDataPath, 'attachments', uuid.slice(0, 1), uuid.slice(1, 2), uuid);
  if (!fs.existsSync(localPath)) {
    c.NotFound();
    return;
  }
  c.SetHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  c.SetHeader('Cache-Control', 'private,max-age=86400');
  c.SetHeader('Content-Disposition', `inline; filename="${row.name}"`);
  c.res.end(fs.readFileSync(localPath));
}

// ---------------------------------------------------------------- settings

async function settingsBase(c: Context, title: string): Promise<void> {
  c.Title(title);
  c.Data['PageIsUserSettings'] = true;
}

export async function Settings(c: Context): Promise<void> {
  await settingsBase(c, 'settings.profile');
  c.Data['PageIsSettingsProfile'] = true;
  const u = c.User!;
  c.Data['origin_name'] = u.name;
  c.Data['name'] = u.name;
  c.Data['full_name'] = u.full_name;
  c.Data['email'] = u.email;
  c.Data['website'] = u.website;
  c.Data['location'] = u.location;
  c.Success('user/settings/profile');
}

export async function SettingsPost(c: Context): Promise<void> {
  await settingsBase(c, 'settings.profile');
  const form = await c.form();
  const name = String(form.name ?? '').trim();
  if (name && name !== c.User!.name) {
    if (!db.isUsernameAllowed(name)) {
      c.RenderWithErr(c.Tr('user.form.name_not_allowed'), 'user/settings/profile');
      return;
    }
    if (db.getUserByUsername(name)) {
      c.RenderWithErr(c.Tr('form.username_been_taken'), 'user/settings/profile');
      return;
    }
  }
  const { sanitizeHTML } = await import('../markup.js');
  db.updateUserColumns(c.User!.id, {
    name: name || c.User!.name,
    full_name: sanitizeHTML(String(form.full_name ?? '')),
    email: String(form.email ?? c.User!.email),
    location: String(form.location ?? ''),
    website: String(form.website ?? ''),
    description: String(form.description ?? ''),
    avatar_email: String(form.avatar_email ?? c.User!.email),
  });
  c.flash.Success(c.Tr('settings.update_profile_success'));
  c.Redirect(conf.subpath + '/user/settings');
}

export async function SettingsAvatar(c: Context): Promise<void> {
  await settingsBase(c, 'settings.avatar');
  c.Data['Owner'] = c.User;
  c.Success('user/settings/avatar');
}

export async function SettingsAvatarPost(c: Context): Promise<void> {
  await c.form();
  const files = c.Files();
  const avatar = files.find((f: any) => f.field === 'avatar');
  if (avatar) {
    fs.mkdirSync(conf.avatarUploadPath, { recursive: true });
    fs.writeFileSync(path.join(conf.avatarUploadPath, String(c.User!.id)), avatar.buffer);
    db.updateUserColumns(c.User!.id, { use_custom_avatar: 1 });
  }
  c.flash.Success(c.Tr('settings.update_avatar_success'));
  c.Redirect(conf.subpath + '/user/settings/avatar');
}

export async function SettingsDeleteAvatar(c: Context): Promise<void> {
  const p = path.join(conf.avatarUploadPath, String(c.User!.id));
  if (fs.existsSync(p)) fs.unlinkSync(p);
  db.updateUserColumns(c.User!.id, { use_custom_avatar: 0 });
  c.Redirect(conf.subpath + '/user/settings/avatar');
}

export async function SettingsEmails(c: Context): Promise<void> {
  await settingsBase(c, 'settings.emails');
  c.Data['Emails'] = db.listEmailAddresses(c.UserID()).map((e: any) => db.goAlias({ ...e }));
  c.Success('user/settings/email');
}

export async function SettingsEmailPost(c: Context): Promise<void> {
  await settingsBase(c, 'settings.emails');
  const form = await c.form();
  const email = String(form.email ?? '').toLowerCase().trim();
  if (!email) {
    c.RenderWithErr(c.Tr('form.email_error'), 'user/settings/email');
    return;
  }
  if (db.getUserByEmail(email) || db.getEmailAddress(email)) {
    c.RenderWithErr(c.Tr('form.email_been_used'), 'user/settings/email');
    return;
  }
  db.db().prepare('INSERT INTO email_address (uid, email, is_activated) VALUES (?,?,1)').run(c.UserID(), email);
  c.flash.Success(c.Tr('settings.add_email_success'));
  c.Redirect(conf.subpath + '/user/settings/email');
}

export async function DeleteEmail(c: Context): Promise<void> {
  const form = await c.form();
  const email = String(form.email ?? '').toLowerCase();
  const row = db.getEmailAddress(email);
  if (row && (row as any).uid === c.UserID() && email !== c.User!.email) {
    db.db().prepare('DELETE FROM email_address WHERE id = ?').run((row as any).id);
  }
  c.Redirect(conf.subpath + '/user/settings/email');
}

export async function SettingsPassword(c: Context): Promise<void> {
  await settingsBase(c, 'settings.password');
  c.Data['Owner'] = c.User;
  c.Success('user/settings/password');
}

export async function SettingsPasswordPost(c: Context): Promise<void> {
  await settingsBase(c, 'settings.password');
  const form = await c.form();
  const { verifyPassword, encodePassword, randomSalt } = await import('../authx/password.js');
  const oldPwd = String(form.old_password ?? '');
  const newPwd = String(form.password ?? '');
  const retype = String(form.retype ?? '');
  if (!verifyPassword(oldPwd, c.User!.salt, c.User!.passwd)) {
    c.RenderWithErr(c.Tr('settings.password_incorrect'), 'user/settings/password');
    return;
  }
  if (newPwd.length < 6) {
    c.RenderWithErr(c.Tr('auth.password_too_short'), 'user/settings/password');
    return;
  }
  if (newPwd !== retype) {
    c.RenderWithErr(c.Tr('form.password_not_match'), 'user/settings/password');
    return;
  }
  const salt = randomSalt();
  db.updateUserColumns(c.User!.id, { passwd: encodePassword(newPwd, salt), salt });
  c.flash.Success(c.Tr('settings.change_password_success'));
  c.Redirect(conf.subpath + '/user/settings/password');
}

export async function SettingsSSHKeys(c: Context): Promise<void> {
  await settingsBase(c, 'settings.ssh_keys');
  c.Data['Keys'] = db.listPublicKeys(c.UserID()).map((k: any) => db.goAlias({ ...k }));
  c.Success('user/settings/sshkeys');
}

export async function SettingsSSHKeysPost(c: Context): Promise<void> {
  await settingsBase(c, 'settings.ssh_keys');
  const form = await c.form();
  const name = String(form.title ?? '').trim();
  const content = String(form.content ?? '').trim();
  if (!name || !content) {
    c.RenderWithErr(c.Tr('form.form_name_not_empty') /* closest */, 'user/settings/sshkeys');
    return;
  }
  const { addPublicKey } = await import('./sshkey.js');
  try {
    await addPublicKey(c.UserID(), name, content);
  } catch (e: any) {
    c.RenderWithErr(String(e.message ?? e), 'user/settings/sshkeys');
    return;
  }
  c.flash.Success(c.Tr('settings.add_key_success', name));
  c.Redirect(conf.subpath + '/user/settings/ssh');
}

export async function DeleteSSHKey(c: Context): Promise<void> {
  const form = await c.form();
  const id = Number(form.id ?? 0);
  const key = db.getPublicKeyByID(id);
  if (key && (key as any).owner_id === c.UserID()) {
    db.db().prepare('DELETE FROM public_key WHERE id = ?').run(id);
    const { writeAuthorizedKeys } = await import('./sshkey.js');
    writeAuthorizedKeys();
  }
  c.Redirect(conf.subpath + '/user/settings/ssh');
}

export async function SettingsSecurity(c: Context): Promise<void> {
  await settingsBase(c, 'settings.security');
  c.Data['PageIsSettingsSecurity'] = true;
  const twofactor = await import('../twofactor.js');
  c.Data['TwoFactor'] = twofactor.getTwoFactorByUserID(c.UserID());
  c.Success('user/settings/security');
}

export async function SettingsRepos(c: Context): Promise<void> {
  await settingsBase(c, 'settings.repositories');
  c.Data['Repos'] = db.listReposByOwner(c.UserID());
  const collab = db.db().prepare('SELECT r.* FROM repository r JOIN collaboration col ON col.repo_id = r.id WHERE col.user_id = ?').all(c.UserID()) as any[];
  c.Data['CollaborativeRepos'] = collab.map((r) => {
    const repo = new db.Repository(r);
    repo.owner = db.getUserByID(repo.owner_id) ?? undefined;
    return repo;
  });
  c.Success('user/settings/repositories');
}

export async function SettingsLeaveRepo(c: Context): Promise<void> {
  const form = await c.form();
  const repoID = Number(form.id ?? 0);
  db.db().prepare('DELETE FROM collaboration WHERE user_id = ? AND repo_id = ?').run(c.UserID(), repoID);
  c.flash.Success(c.Tr('settings.repositories.leave_success'));
  c.Redirect(conf.subpath + '/user/settings/repositories');
}

export async function SettingsOrganizations(c: Context): Promise<void> {
  await settingsBase(c, 'settings.organizations');
  c.Data['Orgs'] = db.listUserOrgs(c.UserID(), true);
  c.Success('user/settings/organizations');
}

export async function SettingsLeaveOrganization(c: Context): Promise<void> {
  const form = await c.form();
  const orgID = Number(form.id ?? 0);
  if (db.isOrgOwner(c.UserID(), orgID)) {
    c.flash.Error(c.Tr('form.org_owner_error'));
  } else {
    db.db().prepare('DELETE FROM org_user WHERE uid = ? AND org_id = ?').run(c.UserID(), orgID);
    db.db().prepare('DELETE FROM team_user WHERE uid = ? AND org_id = ?').run(c.UserID(), orgID);
    c.flash.Success(c.Tr('settings.organizations.leave_success'));
  }
  c.Redirect(conf.subpath + '/user/settings/organizations');
}

export async function SettingsApplications(c: Context): Promise<void> {
  await settingsBase(c, 'settings.applications');
  c.Data['Tokens'] = db.listAccessTokens(c.UserID()).map((t: any) => db.goAlias({ ...t }));
  c.Success('user/settings/applications');
}

export async function SettingsApplicationsPost(c: Context): Promise<void> {
  await settingsBase(c, 'settings.applications');
  const form = await c.form();
  const name = String(form.name ?? '').trim();
  if (!name) {
    c.RenderWithErr(c.Tr('form.token_name_empty'), 'user/settings/applications');
    return;
  }
  const exists = (db.db().prepare('SELECT 1 FROM access_token WHERE uid = ? AND name = ?').get(c.UserID(), name) as any);
  if (exists) {
    c.RenderWithErr(c.Tr('form.token_name_exists'), 'user/settings/applications');
    return;
  }
  const { newTokenSHA1, sha256 } = await import('../authx/password.js');
  const sha1 = newTokenSHA1();
  db.db()
    .prepare('INSERT INTO access_token (uid, name, sha1, sha256, created_unix, updated_unix) VALUES (?,?,?,?,?,?)')
    .run(c.UserID(), name, sha1, sha256(sha1), Date.now() / 1000 | 0, Date.now() / 1000 | 0);
  c.flash.Success(c.Tr('settings.generate_token_succeed'));
  c.Data['NewAccessToken'] = sha1;
  c.Data['Tokens'] = db.listAccessTokens(c.UserID()).map((t: any) => db.goAlias({ ...t }));
  c.Success('user/settings/applications');
}

export async function SettingsDeleteApplication(c: Context): Promise<void> {
  const form = await c.form();
  const id = Number(form.id ?? 0);
  db.db().prepare('DELETE FROM access_token WHERE id = ? AND uid = ?').run(id, c.UserID());
  c.flash.Success(c.Tr('settings.delete_token_success'));
  c.Redirect(conf.subpath + '/user/settings/applications');
}

export async function SettingsDelete(c: Context): Promise<void> {
  await settingsBase(c, 'settings.delete');
  c.Data['Owner'] = c.User;
  c.Success('user/settings/delete');
}

export async function SettingsDeletePost(c: Context): Promise<void> {
  const form = await c.form();
  const { verifyPassword } = await import('../authx/password.js');
  if (!verifyPassword(String(form.password ?? ''), c.User!.salt, c.User!.passwd)) {
    c.RenderWithErr(c.Tr('settings.password_incorrect'), 'user/settings/delete');
    return;
  }
  const owns = db.countUserRepos(c.UserID());
  const orgs = db.db().prepare('SELECT COUNT(*) AS c FROM org_user WHERE uid = ? AND is_owner = 1').get(c.UserID()) as any;
  if (owns > 0) {
    c.flash.Error(c.Tr('form.user_still_own_repo'));
    c.Redirect(conf.subpath + '/user/settings/delete');
    return;
  }
  if (orgs.c > 0) {
    c.flash.Error(c.Tr('form.user_still_org_owner'));
    c.Redirect(conf.subpath + '/user/settings/delete');
    return;
  }
  // delete user rows
  const id = c.UserID();
  for (const sql of [
    'DELETE FROM user WHERE id = ?',
    'DELETE FROM email_address WHERE uid = ?',
    'DELETE FROM follow WHERE user_id = ? OR follow_id = ?',
    'DELETE FROM org_user WHERE uid = ?',
    'DELETE FROM team_user WHERE uid = ?',
    'DELETE FROM access_token WHERE uid = ?',
    'DELETE FROM public_key WHERE owner_id = ?',
    'DELETE FROM collaboration WHERE user_id = ?',
    'DELETE FROM watch WHERE user_id = ?',
    'DELETE FROM star WHERE uid = ?',
  ]) {
    const args = sql.includes('follow WHERE') ? [id, id] : [id];
    db.db().prepare(sql).run(...args);
  }
  c.session.Clear();
  c.session.Release();
  c.SetCookie(conf.cookieUserName, '', 0);
  c.Redirect(conf.subpath + '/');
}

/**
 * GET/POST /user/activate_email — verify an activation code and mark the
 * secondary email active (gogs ActivateEmail). Works without login.
 */
export async function ActivateEmail(c: Context): Promise<void> {
  const code = c.Query('code');
  const { verifyUserFromCode } = await import('../toolx.js');
  const parsed = verifyUserFromCode(code, (u: string) => db.getUserByUsername(u));
  if (!parsed || !parsed.valid) {
    c.flash.Error(c.Tr('auth.invalid_code'));
    c.RedirectSubpath('/');
    return;
  }
  // mark the matching email_address activated
  const row = db.getEmailAddress(parsed.user.email);
  if (row && !(row as any).is_activated) {
    db.db().prepare('UPDATE email_address SET is_activated = 1 WHERE id = ?').run((row as any).id);
  }
  c.flash.Success(c.Tr('settings.add_email_success'));
  c.RedirectSubpath('/user/settings/email');
}

/** GET /user/email2user — auto sign-in via verified email activation code. */
export async function Email2User(c: Context): Promise<void> {
  const code = c.Query('code');
  const { verifyUserFromCode } = await import('../toolx.js');
  const parsed = verifyUserFromCode(code, (u: string) => db.getUserByUsername(u));
  if (!parsed || !parsed.valid) {
    c.flash.Error(c.Tr('auth.invalid_or_used_code'));
    c.RedirectSubpath('/');
    return;
  }
  const { completeSignIn } = await import('../context.js');
  completeSignIn(c, parsed.user);
  c.RedirectSubpath('/');
}

// ---------------------------------------------------------------- two-factor security

export async function SettingsTwoFactorEnable(c: Context): Promise<void> {
  const twofactor = await import('../twofactor.js');
  if (twofactor.isTwoFactorEnabled(c.UserID())) {
    c.NotFound();
    return;
  }
  c.Data['Title'] = c.Tr('settings.two_factor_enable_title');
  c.Data['PageIsSettingsSecurity'] = true;

  let secret = c.session.Get('twoFactorSecret');
  let url = c.session.Get('twoFactorURL');
  if (!secret || !url) {
    const gen = twofactor.totpGenerate(conf.brandName, c.User!.email);
    secret = gen.secret;
    url = gen.url;
  }
  c.Data['TwoFactorSecret'] = secret;
  const QRCode = (await import('qrcode')).default;
  c.Data['QRCode'] = await QRCode.toDataURL(url, { width: 240 });
  c.session.Set('twoFactorSecret', secret);
  c.session.Set('twoFactorURL', url);
  c.session.Release();
  c.Success('user/settings/two_factor_enable');
}

export async function SettingsTwoFactorEnablePost(c: Context): Promise<void> {
  const twofactor = await import('../twofactor.js');
  const secret = c.session.Get('twoFactorSecret');
  if (!secret) {
    c.NotFound();
    return;
  }
  const passcode = c.Query('passcode') || String((await c.form()).passcode ?? '');
  if (!twofactor.totpValidate(passcode, String(secret))) {
    c.flash.Error(c.Tr('settings.two_factor_invalid_passcode'));
    c.RedirectSubpath('/user/settings/security/two_factor_enable');
    return;
  }
  twofactor.createTwoFactor(c.UserID(), String(secret));
  c.session.Delete('twoFactorSecret');
  c.session.Delete('twoFactorURL');
  c.session.Release();
  c.flash.Success(c.Tr('settings.two_factor_enable_success'));
  c.RedirectSubpath('/user/settings/security/two_factor_recovery_codes');
}

export async function SettingsTwoFactorRecoveryCodes(c: Context): Promise<void> {
  const twofactor = await import('../twofactor.js');
  if (!twofactor.isTwoFactorEnabled(c.UserID())) {
    c.NotFound();
    return;
  }
  c.Data['Title'] = c.Tr('settings.two_factor_recovery_codes_title');
  c.Data['PageIsSettingsSecurity'] = true;
  c.Data['RecoveryCodes'] = twofactor.listRecoveryCodes(c.UserID());
  c.Success('user/settings/two_factor_recovery_codes');
}

export async function SettingsTwoFactorRecoveryCodesPost(c: Context): Promise<void> {
  const twofactor = await import('../twofactor.js');
  if (!twofactor.isTwoFactorEnabled(c.UserID())) {
    c.NotFound();
    return;
  }
  twofactor.regenerateRecoveryCodes(c.UserID());
  c.flash.Success(c.Tr('settings.two_factor_regenerate_recovery_codes_success'));
  c.RedirectSubpath('/user/settings/security/two_factor_recovery_codes');
}

export async function SettingsTwoFactorDisable(c: Context): Promise<void> {
  const twofactor = await import('../twofactor.js');
  twofactor.deleteTwoFactor(c.UserID());
  c.flash.Success(c.Tr('settings.two_factor_disable_success'));
  c.RedirectSubpath('/user/settings/security');
}
