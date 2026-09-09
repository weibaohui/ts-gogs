// Organization routes.
import type { Context } from '../context.js';
import { conf } from '../conf.js';
import * as db from '../db/db.js';
import { newPaginater } from './home.js';
import { nowUnix } from '../db/db.js';

export async function Create(c: Context): Promise<void> {
  if (!c.User!.CanCreateOrganization()) {
    c.NotFound();
    return;
  }
  c.Title('org.create');
  c.Data['PageIsOrgCreate'] = true;
  c.Success('org/create');
}

export async function CreatePost(c: Context): Promise<void> {
  if (!c.User!.CanCreateOrganization()) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const name = String(form.org_name ?? '').trim();
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name.length > 35) {
    c.RenderWithErr(c.Tr('org.form.name_not_allowed'), 'org/create');
    return;
  }
  try {
    await import('../db/db.js');
    const org = db.createOrganization(c.User!, name, {
      fullName: String(form.full_name ?? ''),
      description: String(form.description ?? ''),
      website: String(form.website ?? ''),
      location: String(form.location ?? ''),
    });
    c.flash.Success(c.Tr('org.form.create_success', org.name));
    c.Redirect(conf.subpath + '/org/' + org.name + '/dashboard');
  } catch (e: any) {
    if (e instanceof db.AlreadyExistError) {
      c.RenderWithErr(c.Tr('form.orgname_been_taken'), 'org/create');
    } else {
      c.RenderWithErr(c.Tr('org.form.name_not_allowed'), 'org/create');
    }
  }
}

export async function Members(c: Context): Promise<void> {
  const orgName = c.Params(':org');
  const org = db.getUserByUsername(orgName);
  if (!org || org.type !== 1) {
    c.NotFound();
    return;
  }
  c.Data['Org'] = org;
  c.Data['Title'] = org.DisplayName();
  c.Data['PageIsOrganizationMembers'] = true;
  const all = c.IsLogged && (c.User!.is_admin === 1 || db.isOrgMember(c.UserID(), org.id));
  c.Data['Members'] = db.listOrgMembers(org.id, all);
  c.Success('org/member/members');
}

export async function Teams(c: Context): Promise<void> {
  const orgName = c.Params(':org');
  const org = db.getUserByUsername(orgName);
  if (!org || org.type !== 1) {
    c.NotFound();
    return;
  }
  c.Data['Org'] = org;
  c.Data['Title'] = org.DisplayName();
  c.Data['PageIsOrganizationTeams'] = true;
  c.Data['Teams'] = db.listTeamsByOrg(org.id).map((t: any) => ({ ...t, Organization: org }));
  c.Success('org/team/teams');
}

export async function TeamMembers(c: Context): Promise<void> {
  const orgName = c.Params(':org');
  const org = db.getUserByUsername(orgName);
  const team = org ? db.getTeamByName(org.id, c.Params(':team')) : null;
  if (!org || !team) {
    c.NotFound();
    return;
  }
  c.Data['Org'] = org;
  c.Data['Team'] = team;
  c.Data['Title'] = (team as any).name;
  c.Data['Members'] = db.listTeamMembers((team as any).id);
  c.Data['IsTeamMember'] = c.IsLogged && !!db.db().prepare('SELECT 1 FROM team_user WHERE team_id = ? AND uid = ?').get((team as any).id, c.UserID());
  c.Data['IsTeamAdmin'] = c.Data['IsTeamMember'] && (team as any).authorize >= 3;
  c.Success('org/team/team');
}

export async function TeamRepositories(c: Context): Promise<void> {
  const orgName = c.Params(':org');
  const org = db.getUserByUsername(orgName);
  const team = org ? db.getTeamByName(org.id, c.Params(':team')) : null;
  if (!org || !team) {
    c.NotFound();
    return;
  }
  c.Data['Org'] = org;
  c.Data['Team'] = team;
  c.Data['Title'] = (team as any).name;
  c.Data['Repos'] = db.listTeamRepos((team as any).id);
  c.Success('org/team/repositories');
}

export async function NewTeam(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  if (!org || org.type !== 1) {
    c.NotFound();
    return;
  }
  c.Data['Org'] = org;
  c.Data['Title'] = c.Tr('org.create_new_team');
  c.Data['PageIsOrgTeamsNew'] = true;
  c.Success('org/team/new');
}

export async function NewTeamPost(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  if (!org || org.type !== 1) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const name = String(form.team_name ?? '').trim();
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    c.RenderWithErr(c.Tr('org.form.team_name_not_allowed'), 'org/team/new');
    return;
  }
  if (db.getTeamByName(org.id, name)) {
    c.RenderWithErr(c.Tr('org.team.name_been_taken'), 'org/team/new');
    return;
  }
  const permission = String(form.permission ?? 'read');
  const authorize = permission === 'admin' ? 3 : permission === 'write' ? 2 : 1;
  const info = db.db()
    .prepare('INSERT INTO team (org_id, lower_name, name, description, authorize, num_repos, num_members) VALUES (?,?,?,?,?,0,1)')
    .run(org.id, name.toLowerCase(), name, String(form.description ?? ''), authorize);
  const teamID = Number(info.lastInsertRowid);
  db.db().prepare('INSERT INTO team_user (org_id, team_id, uid) VALUES (?,?,?)').run(org.id, teamID, c.UserID());
  db.db().prepare('UPDATE user SET num_teams = num_teams + 1 WHERE id = ?').run(org.id);
  c.Redirect(conf.subpath + `/org/${org.name}/teams/${name}`);
}

export async function EditTeam(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  const team = org ? db.getTeamByName(org.id, c.Params(':team')) : null;
  if (!org || !team) {
    c.NotFound();
    return;
  }
  c.Data['Org'] = org;
  c.Data['Team'] = team;
  c.Data['PageIsOrgTeamsEdit'] = true;
  c.Success('org/team/new');
}

export async function EditTeamPost(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  const team = org ? db.getTeamByName(org.id, c.Params(':team')) : null;
  if (!org || !team) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const permission = String(form.permission ?? 'read');
  const authorize = permission === 'admin' ? 3 : permission === 'write' ? 2 : 1;
  db.db().prepare('UPDATE team SET description = ?, authorize = ? WHERE id = ?').run(String(form.description ?? ''), authorize, (team as any).id);
  c.Redirect(conf.subpath + `/org/${org.name}/teams/${(team as any).lower_name}`);
}

export async function DeleteTeam(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  const team = org ? db.getTeamByName(org.id, c.Params(':team')) : null;
  if (!org || !team) {
    c.NotFound();
    return;
  }
  if ((team as any).lower_name === 'owners') {
    c.flash.Error(c.Tr('org.team.owners_cannot_delete'));
    c.Redirect(conf.subpath + `/org/${org.name}/teams`);
    return;
  }
  db.db().prepare('DELETE FROM team WHERE id = ?').run((team as any).id);
  db.db().prepare('DELETE FROM team_user WHERE team_id = ?').run((team as any).id);
  db.db().prepare('DELETE FROM team_repo WHERE team_id = ?').run((team as any).id);
  db.db().prepare('UPDATE user SET num_teams = num_teams - 1 WHERE id = ?').run(org.id);
  c.flash.Success(c.Tr('org.team.delete_success'));
  c.Redirect(conf.subpath + `/org/${org.name}/teams`);
}

export async function MembersAction(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  if (!org) {
    c.NotFound();
    return;
  }
  const action = c.Params(':action');
  const uname = String(c.Query('uname') ?? '');
  const user = db.getUserByUsername(uname);
  if (!user) {
    c.NotFound();
    return;
  }
  if (action === 'remove') {
    db.db().prepare('DELETE FROM org_user WHERE uid = ? AND org_id = ?').run(user.id, org.id);
    db.db().prepare('DELETE FROM team_user WHERE uid = ? AND org_id = ?').run(user.id, org.id);
  } else if (action === 'publicize') {
    db.db().prepare('UPDATE org_user SET is_public = 1 WHERE uid = ? AND org_id = ?').run(user.id, org.id);
  } else if (action === 'privateize') {
    db.db().prepare('UPDATE org_user SET is_public = 0 WHERE uid = ? AND org_id = ?').run(user.id, org.id);
  }
  c.Redirect(conf.subpath + `/org/${org.name}/members`);
}

export async function TeamsAction(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  const team = org ? db.getTeamByName(org.id, c.Params(':team')) : null;
  if (!org || !team) {
    c.NotFound();
    return;
  }
  const action = c.Params(':action');
  const user = db.getUserByUsername(String(c.Query('uname') ?? ''));
  if (!user) {
    c.NotFound();
    return;
  }
  if (action === 'add') {
    if (!db.db().prepare('SELECT 1 FROM team_user WHERE team_id = ? AND uid = ?').get((team as any).id, user.id)) {
      db.db().prepare('INSERT INTO team_user (org_id, team_id, uid) VALUES (?,?,?)').run(org.id, (team as any).id, user.id);
      db.db().prepare('UPDATE team SET num_members = num_members + 1 WHERE id = ?').run((team as any).id);
      if (!db.isOrgMember(user.id, org.id)) {
        db.db().prepare('INSERT INTO org_user (uid, org_id, is_public, is_owner, num_teams) VALUES (?,?,0,0,1)').run(user.id, org.id);
      }
    }
  } else if (action === 'remove') {
    db.db().prepare('DELETE FROM team_user WHERE team_id = ? AND uid = ?').run((team as any).id, user.id);
    db.db().prepare('UPDATE team SET num_members = MAX(num_members - 1, 0) WHERE id = ?').run((team as any).id);
  }
  c.Redirect(conf.subpath + `/org/${org.name}/teams/${(team as any).lower_name}`);
}

export async function TeamsRepoAction(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  const team = org ? db.getTeamByName(org.id, c.Params(':team')) : null;
  if (!org || !team) {
    c.NotFound();
    return;
  }
  const action = c.Params(':action');
  const repoName = String(c.Query('reponame') ?? '');
  const owner = org; // team repos live under the org
  const repo = db.getRepoByOwnerAndName(owner, repoName);
  if (!repo) {
    c.NotFound();
    return;
  }
  if (action === 'add') {
    if (!db.db().prepare('SELECT 1 FROM team_repo WHERE team_id = ? AND repo_id = ?').get((team as any).id, repo.id)) {
      db.db().prepare('INSERT INTO team_repo (org_id, team_id, repo_id) VALUES (?,?,?)').run(org.id, (team as any).id, repo.id);
      db.db().prepare('UPDATE team SET num_repos = num_repos + 1 WHERE id = ?').run((team as any).id);
    }
  } else if (action === 'remove') {
    db.db().prepare('DELETE FROM team_repo WHERE team_id = ? AND repo_id = ?').run((team as any).id, repo.id);
    db.db().prepare('UPDATE team SET num_repos = MAX(num_repos - 1, 0) WHERE id = ?').run((team as any).id);
  }
  c.Redirect(conf.subpath + `/org/${org.name}/teams/${(team as any).lower_name}/repositories`);
}

export async function Settings(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  if (!org || org.type !== 1) {
    c.NotFound();
    return;
  }
  c.Data['Org'] = org;
  c.Data['Title'] = org.DisplayName();
  c.Data['PageIsOrgSettings'] = true;
  c.Data['PageIsSettingsOptions'] = true;
  c.Success('org/settings/options');
}

export async function SettingsPost(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  if (!org || org.type !== 1) {
    c.NotFound();
    return;
  }
  if (!db.isOrgOwner(c.UserID(), org.id)) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  db.updateUserColumns(org.id, {
    name: String(form.name ?? org.name),
    lower_name: String(form.name ?? org.name).toLowerCase(),
    full_name: String(form.full_name ?? ''),
    description: String(form.description ?? ''),
    website: String(form.website ?? ''),
    location: String(form.location ?? ''),
  });
  c.flash.Success(c.Tr('org.settings.update_setting_success'));
  c.Redirect(conf.subpath + `/org/${String(form.name ?? org.name)}/settings`);
}

export async function SettingsDelete(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  if (!org || org.type !== 1) {
    c.NotFound();
    return;
  }
  c.Data['Org'] = org;
  c.Data['PageIsOrgSettingsDelete'] = true;
  c.Success('org/settings/delete');
}

export async function SettingsDeletePost(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  if (!org || org.type !== 1) {
    c.NotFound();
    return;
  }
  if (!db.isOrgOwner(c.UserID(), org.id)) {
    c.NotFound();
    return;
  }
  const owns = db.countUserRepos(org.id);
  if (owns > 0) {
    c.flash.Error(c.Tr('form.org_still_own_repo'));
    c.Redirect(conf.subpath + `/org/${org.name}/settings/delete`);
    return;
  }
  for (const sql of [
    'DELETE FROM user WHERE id = ?',
    'DELETE FROM org_user WHERE org_id = ?',
    'DELETE FROM team WHERE org_id = ?',
    'DELETE FROM team_user WHERE org_id = ?',
    'DELETE FROM team_repo WHERE org_id = ?',
  ]) {
    db.db().prepare(sql).run(org.id);
  }
  c.Redirect(conf.subpath + '/');
}

export async function Invitation(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  if (!org) {
    c.NotFound();
    return;
  }
  c.Data['Org'] = org;
  c.Data['Title'] = c.Tr('org.invite_team_member');
  c.Success('org/invite');
}

export async function InvitationPost(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  if (!org) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const uname = String(form.uname ?? '').trim();
  const user = db.getUserByUsername(uname);
  if (user && !db.isOrgMember(user.id, org.id)) {
    db.db().prepare('INSERT INTO org_user (uid, org_id, is_public, is_owner, num_teams) VALUES (?,?,0,0,0)').run(user.id, org.id);
    c.flash.Success(c.Tr('org.members.invite_success'));
    c.Redirect(conf.subpath + `/org/${org.name}/members`);
    return;
  }
  c.flash.Error(c.Tr('form.user_not_exist'));
  c.Redirect(conf.subpath + `/org/${org.name}/invitations/new`);
}

export { Webhooks, WebhooksNew, WebhooksNewPost, WebhooksSlackNewPost, WebhooksDiscordNewPost, WebhooksDingtalkNewPost, WebhooksEditPost, WebhooksSlackEditPost, WebhooksDiscordEditPost, WebhooksDingtalkEditPost, DeleteWebhook } from './repo.js';

// org-level webhook handlers reuse repo handlers with org context
export async function WebhooksEdit(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  if (!org) {
    c.NotFound();
    return;
  }
  const hook = db.db().prepare('SELECT * FROM webhook WHERE id = ? AND org_id = ?').get(c.ParamsInt64(':id'), org.id) as any;
  if (!hook) {
    c.NotFound();
    return;
  }
  c.Data['PageIsSettingsHooks'] = true;
  c.Data['PageIsSettingsHooksEdit'] = true;
  c.Data['Hook'] = { ...hook, eventsObj: JSON.parse(hook.events ?? '{}') };
  c.Data['Org'] = org;
  c.Success('repo/settings/webhook/gogs');
}

// ---------------------------------------------------------------- org webhooks

function requireOrg(c: Context): db.User | null {
  const org = db.getUserByUsername(c.Params(':org'));
  if (!org || org.type !== 1) return null;
  if (!db.isOrgOwner(c.UserID(), org.id)) return null;
  return org;
}

export async function OrgWebhooksNew(c: Context): Promise<void> {
  const org = requireOrg(c);
  if (!org) {
    c.NotFound();
    return;
  }
  c.Data['PageIsSettingsHooks'] = true;
  c.Data['PageIsSettingsHooksNew'] = true;
  c.Data['HookType'] = c.Params(':type');
  c.Data['Org'] = org;
  c.Success('repo/settings/webhook/new');
}

function orgHookBase(c: Context, form: Record<string, any>, hookType: number, meta: string): void {
  const org = requireOrg(c);
  if (!org) {
    c.NotFound();
    return;
  }
  const eventsObj: any = { push_only: false, send_everything: false, choose_events: false, events: {} };
  if (String(form.push_only ?? '') === 'on') eventsObj.push_only = true;
  if (String(form.send_everything ?? '') === 'on') eventsObj.send_everything = true;
  if (String(form.choose_events ?? '') === 'on') {
    eventsObj.choose_events = true;
    for (const ev of ['create', 'delete', 'fork', 'push', 'issues', 'issue_comment', 'pull_request', 'release']) {
      eventsObj.events[ev] = String(form[`event_${ev}`] ?? '') === 'on';
    }
  }
  const now = nowUnix();
  db.db()
    .prepare(
      `INSERT INTO webhook (repo_id, org_id, url, content_type, secret, events, is_ssl, is_active, hook_task_type, meta, last_status, created_unix, updated_unix)
       VALUES (0,?,?,?,?,?,0,?,?,?,0,?,?)`
    )
    .run(
      org.id,
      String(form.payload_url ?? ''),
      String(form.content_type ?? 'json') === 'form' ? 2 : 1,
      String(form.secret ?? ''),
      JSON.stringify(eventsObj),
      String(form.active ?? '') === 'on' ? 1 : 0,
      hookType,
      meta,
      now,
      now
    );
  c.flash.Success(c.Tr('repo.settings.add_hook_success'));
  c.Redirect(conf.subpath + `/org/${org.name}/settings/hooks`);
}

export async function OrgWebhooksNewPost(c: Context): Promise<void> {
  const form = await c.form();
  orgHookBase(c, form, 1, '{}');
}

export async function OrgWebhooksSlackNewPost(c: Context): Promise<void> {
  const form = await c.form();
  orgHookBase(c, form, 2, JSON.stringify({
    channel: String(form.channel ?? ''), username: String(form.username ?? ''),
    icon_url: String(form.icon_url ?? ''), color: String(form.color ?? 'good'),
  }));
}

export async function OrgWebhooksDiscordNewPost(c: Context): Promise<void> {
  const form = await c.form();
  orgHookBase(c, form, 3, JSON.stringify({ username: String(form.username ?? '') }));
}

export async function OrgWebhooksDingtalkNewPost(c: Context): Promise<void> {
  const form = await c.form();
  orgHookBase(c, form, 4, '{}');
}

export async function OrgWebhooksList(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  if (!org || org.type !== 1) {
    c.NotFound();
    return;
  }
  c.Data['Org'] = org;
  c.Data['PageIsSettingsHooks'] = true;
  c.Data['Hooks'] = (db.db().prepare('SELECT * FROM webhook WHERE org_id = ? ORDER BY id DESC').all(org.id) as any[]).map((h) => db.goAlias({ ...h }));
  c.Success('repo/settings/webhook/list');
}

export async function OrgWebhooksEdit(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  const hook = org ? (db.db().prepare('SELECT * FROM webhook WHERE id = ? AND org_id = ?').get(c.ParamsInt64(':id'), org.id) as any) : null;
  if (!org || !hook) {
    c.NotFound();
    return;
  }
  c.Data['Org'] = org;
  c.Data['PageIsSettingsHooks'] = true;
  c.Data['PageIsSettingsHooksEdit'] = true;
  c.Data['Hook'] = { ...db.goAlias(hook), eventsObj: JSON.parse(hook.events ?? '{}') };
  c.Success('repo/settings/webhook/' + (hook.hook_task_type === 2 ? 'slack' : 'gogs'));
}

export async function OrgWebhooksEditPost(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  const hook = org ? (db.db().prepare('SELECT * FROM webhook WHERE id = ? AND org_id = ?').get(c.ParamsInt64(':id'), org.id) as any) : null;
  if (!org || !hook) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const eventsObj: any = { push_only: false, send_everything: false, choose_events: false, events: {} };
  if (String(form.push_only ?? '') === 'on') eventsObj.push_only = true;
  if (String(form.send_everything ?? '') === 'on') eventsObj.send_everything = true;
  if (String(form.choose_events ?? '') === 'on') {
    eventsObj.choose_events = true;
    for (const ev of ['create', 'delete', 'fork', 'push', 'issues', 'issue_comment', 'pull_request', 'release']) {
      eventsObj.events[ev] = String(form[`event_${ev}`] ?? '') === 'on';
    }
  }
  db.db()
    .prepare('UPDATE webhook SET url = ?, secret = ?, events = ?, is_active = ?, updated_unix = ? WHERE id = ?')
    .run(String(form.payload_url ?? ''), String(form.secret ?? ''), JSON.stringify(eventsObj), String(form.active ?? '') === 'on' ? 1 : 0, nowUnix(), hook.id);
  c.flash.Success(c.Tr('repo.settings.update_hook_success'));
  c.Redirect(conf.subpath + `/org/${org.name}/settings/hooks`);
}

export async function OrgDeleteWebhook(c: Context): Promise<void> {
  const org = db.getUserByUsername(c.Params(':org'));
  const hook = org ? (db.db().prepare('SELECT id FROM webhook WHERE id = ? AND org_id = ?').get(Number((await c.form()).id ?? 0), org.id) as any) : null;
  if (org && hook) {
    db.db().prepare('DELETE FROM webhook WHERE id = ?').run(hook.id);
    c.flash.Success(c.Tr('repo.settings.webhook_deletion_success'));
  }
  c.Redirect(conf.subpath + `/org/${org?.name ?? ''}/settings/hooks`);
}
