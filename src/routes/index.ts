// Web route registration mirroring cmd/gogs/internal/web/web.go.
import type { Router } from '../router.js';
import { ignSignIn, reqSignIn, reqAdmin, Context } from '../context.js';
import { conf } from '../conf.js';
import * as db from '../db/db.js';

import * as install from './install.js';
import * as home from './home.js';
import * as user from './user.js';
import * as repo from './repo.js';
import * as org from './org.js';
import * as admin from './admin.js';
import * as adminAuths from './auths.js';

export function registerWebRoutes(m: Router): void {
  m.get('/install', install.Install);
  m.post('/install', install.InstallPost);
  m.get('/', ignSignIn, home.Home);
  m.get('/explore', (c: Context) => c.Redirect(conf.subpath + '/explore/repos'));
  m.get('/explore/repos', ignSignIn, home.ExploreRepos);
  m.get('/explore/users', ignSignIn, home.ExploreUsers);
  m.get('/explore/organizations', ignSignIn, home.ExploreOrganizations);
  m.add('GET', '/^:type(issues|pulls)$', reqSignIn, user.Issues);

  // ----- User settings -----
  const settingsGuard = (c: Context) => {
    c.Data['PageIsUserSettings'] = true;
  };
  m.get('/user/settings', reqSignIn, settingsGuard, user.Settings);
  m.post('/user/settings', reqSignIn, settingsGuard, user.SettingsPost);
  m.get('/user/settings/avatar', reqSignIn, settingsGuard, user.SettingsAvatar);
  m.post('/user/settings/avatar', reqSignIn, settingsGuard, user.SettingsAvatarPost);
  m.post('/user/settings/avatar/delete', reqSignIn, settingsGuard, user.SettingsDeleteAvatar);
  m.get('/user/settings/email', reqSignIn, settingsGuard, user.SettingsEmails);
  m.post('/user/settings/email', reqSignIn, settingsGuard, user.SettingsEmailPost);
  m.post('/user/settings/email/delete', reqSignIn, settingsGuard, user.DeleteEmail);
  m.get('/user/settings/password', reqSignIn, settingsGuard, user.SettingsPassword);
  m.post('/user/settings/password', reqSignIn, settingsGuard, user.SettingsPasswordPost);
  m.get('/user/settings/ssh', reqSignIn, settingsGuard, user.SettingsSSHKeys);
  m.post('/user/settings/ssh', reqSignIn, settingsGuard, user.SettingsSSHKeysPost);
  m.post('/user/settings/ssh/delete', reqSignIn, settingsGuard, user.DeleteSSHKey);
  m.get('/user/settings/security', reqSignIn, settingsGuard, user.SettingsSecurity);
  m.get('/user/settings/security/two_factor_enable', reqSignIn, settingsGuard, user.SettingsTwoFactorEnable);
  m.post('/user/settings/security/two_factor_enable', reqSignIn, settingsGuard, user.SettingsTwoFactorEnablePost);
  m.get('/user/settings/security/two_factor_recovery_codes', reqSignIn, settingsGuard, user.SettingsTwoFactorRecoveryCodes);
  m.post('/user/settings/security/two_factor_recovery_codes', reqSignIn, settingsGuard, user.SettingsTwoFactorRecoveryCodesPost);
  m.post('/user/settings/security/two_factor_disable', reqSignIn, settingsGuard, user.SettingsTwoFactorDisable);
  m.get('/user/settings/repositories', reqSignIn, settingsGuard, user.SettingsRepos);
  m.post('/user/settings/repositories/leave', reqSignIn, settingsGuard, user.SettingsLeaveRepo);
  m.get('/user/settings/organizations', reqSignIn, settingsGuard, user.SettingsOrganizations);
  m.post('/user/settings/organizations/leave', reqSignIn, settingsGuard, user.SettingsLeaveOrganization);
  m.get('/user/settings/applications', reqSignIn, settingsGuard, user.SettingsApplications);
  m.post('/user/settings/applications', reqSignIn, settingsGuard, user.SettingsApplicationsPost);
  m.post('/user/settings/applications/delete', reqSignIn, settingsGuard, user.SettingsDeleteApplication);
  m.get('/user/settings/delete', reqSignIn, settingsGuard, user.SettingsDelete);
  m.post('/user/settings/delete', reqSignIn, settingsGuard, user.SettingsDeletePost);

  // SPA-covered paths: serve the SPA shell with 200 (gogs catch-all ServeWeb)
  for (const spa of ['/user/sign-in', '/user/sign-up', '/user/mfa', '/user/reset-password', '/user/activate']) {
    m.get(spa, (c: Context) => { c.ServeWeb(); });
  }
  m.any('/user/activate_email', user.ActivateEmail);
  m.get('/user/email2user', user.Email2User);
  m.get('/user/avatar/:hash', (c: Context) => c.Redirect(conf.subpath + '/img/avatar_default.png'));

  // ----- Admin -----
  m.get('/admin', reqAdmin, admin.Dashboard);
  m.post('/admin', reqAdmin, admin.Operation);
  m.get('/admin/config', reqAdmin, admin.Config);
  m.post('/admin/config/test_mail', reqAdmin, admin.SendTestMail);
  m.get('/admin/monitor', reqAdmin, admin.Monitor);
  m.get('/admin/users', reqAdmin, admin.Users);
  m.get('/admin/users/new', reqAdmin, admin.NewUser);
  m.post('/admin/users/new', reqAdmin, admin.NewUserPost);
  m.get('/admin/users/:userid', reqAdmin, admin.EditUser);
  m.post('/admin/users/:userid', reqAdmin, admin.EditUserPost);
  m.post('/admin/users/:userid/delete', reqAdmin, admin.DeleteUser);
  m.get('/admin/orgs', reqAdmin, admin.Organizations);
  m.get('/admin/repos', reqAdmin, admin.Repos);
  m.post('/admin/repos/delete', reqAdmin, admin.DeleteRepo);
  m.get('/admin/auths', reqAdmin, adminAuths.Authentications);
  m.get('/admin/auths/new', reqAdmin, adminAuths.NewAuthSource);
  m.post('/admin/auths/new', reqAdmin, adminAuths.NewAuthSourcePost);
  m.get('/admin/auths/:authid', reqAdmin, adminAuths.EditAuthSource);
  m.post('/admin/auths/:authid', reqAdmin, adminAuths.EditAuthSourcePost);
  m.post('/admin/auths/:authid/delete', reqAdmin, adminAuths.DeleteAuthSource);
  m.get('/admin/notices', reqAdmin, admin.Notices);
  m.post('/admin/notices/delete', reqAdmin, admin.DeleteNotices);
  m.get('/admin/notices/empty', reqAdmin, admin.EmptyNotices);

  // ----- profiles & attachments -----
  m.get('/:username', ignSignIn, user.InjectParamsUser(), user.Profile);
  m.get('/:username/followers', ignSignIn, user.InjectParamsUser(), user.Followers);
  m.get('/:username/following', ignSignIn, user.InjectParamsUser(), user.Following);
  m.get('/:username/stars', ignSignIn, user.InjectParamsUser(), user.Stars);
  m.get('/attachments/:uuid', ignSignIn, user.Attachment);

  m.post('/issues/attachments', reqSignIn, repo.UploadIssueAttachment);
  m.post('/releases/attachments', reqSignIn, repo.UploadReleaseAttachment);
  m.post('/:username/action/:action', reqSignIn, user.Action);

  // ----- Organization -----
  m.get('/org/create', reqSignIn, org.Create);
  m.post('/org/create', reqSignIn, org.CreatePost);
  m.get('/org/:org/dashboard', reqSignIn, user.Dashboard);
  m.get('/org/:org/members', ignSignIn, org.Members);
  m.post('/org/:org/members/action/:action', reqSignIn, org.MembersAction);
  m.get('/org/:org/teams', ignSignIn, org.Teams);
  m.get('/org/:org/teams/new', reqSignIn, org.NewTeam);
  m.post('/org/:org/teams/new', reqSignIn, org.NewTeamPost);
  m.get('/org/:org/teams/:team', ignSignIn, org.TeamMembers);
  m.get('/org/:org/teams/:team/repositories', ignSignIn, org.TeamRepositories);
  m.post('/org/:org/teams/:team/action/:action', reqSignIn, org.TeamsAction);
  m.post('/org/:org/teams/:team/action/repo/:action', reqSignIn, org.TeamsRepoAction);
  m.get('/org/:org/teams/:team/edit', reqSignIn, org.EditTeam);
  m.post('/org/:org/teams/:team/edit', reqSignIn, org.EditTeamPost);
  m.post('/org/:org/teams/:team/delete', reqSignIn, org.DeleteTeam);
  m.get('/org/:org/settings', reqSignIn, org.Settings);
  m.post('/org/:org/settings', reqSignIn, org.SettingsPost);
  m.get('/org/:org/settings/hooks', reqSignIn, org.OrgWebhooksList);
  m.post('/org/:org/settings/hooks/delete', reqSignIn, org.OrgDeleteWebhook);
  m.get('/org/:org/settings/hooks/:type/new', reqSignIn, org.OrgWebhooksNew);
  m.post('/org/:org/settings/hooks/gogs/new', reqSignIn, org.OrgWebhooksNewPost);
  m.post('/org/:org/settings/hooks/slack/new', reqSignIn, org.OrgWebhooksSlackNewPost);
  m.post('/org/:org/settings/hooks/discord/new', reqSignIn, org.OrgWebhooksDiscordNewPost);
  m.post('/org/:org/settings/hooks/dingtalk/new', reqSignIn, org.OrgWebhooksDingtalkNewPost);
  m.get('/org/:org/settings/hooks/:id', reqSignIn, org.OrgWebhooksEdit);
  m.post('/org/:org/settings/hooks/gogs/:id', reqSignIn, org.OrgWebhooksEditPost);
  m.post('/org/:org/settings/hooks/slack/:id', reqSignIn, org.OrgWebhooksEditPost);
  m.post('/org/:org/settings/hooks/discord/:id', reqSignIn, org.OrgWebhooksEditPost);
  m.post('/org/:org/settings/hooks/dingtalk/:id', reqSignIn, org.OrgWebhooksEditPost);
  m.get('/org/:org/settings/delete', reqSignIn, org.SettingsDelete);
  m.post('/org/:org/settings/delete', reqSignIn, org.SettingsDeletePost);
  m.get('/org/:org/invitations/new', reqSignIn, org.Invitation);
  m.post('/org/:org/invitations/new', reqSignIn, org.InvitationPost);

  // ----- Repository create/migrate/fork -----
  m.get('/repo/create', reqSignIn, repo.Create);
  m.post('/repo/create', reqSignIn, repo.CreatePost);
  m.get('/repo/migrate', reqSignIn, repo.Migrate);
  m.post('/repo/migrate', reqSignIn, repo.MigratePost);
  m.get('/repo/fork/:repoid', reqSignIn, repo.Fork);
  m.post('/repo/fork/:repoid', reqSignIn, repo.ForkPost);

  // ----- Repo settings -----
  m.get('/:username/:reponame/settings', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.Settings);
  m.post('/:username/:reponame/settings', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsPost);
  m.get('/:username/:reponame/settings/avatar', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsAvatar);
  m.post('/:username/:reponame/settings/avatar', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsAvatarPost);
  m.post('/:username/:reponame/settings/avatar/delete', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsDeleteAvatar);
  m.get('/:username/:reponame/settings/collaboration', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsCollaboration);
  m.post('/:username/:reponame/settings/collaboration', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsCollaborationPost);
  m.post('/:username/:reponame/settings/collaboration/access_mode', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.ChangeCollaborationAccessMode);
  m.post('/:username/:reponame/settings/collaboration/delete', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.DeleteCollaboration);
  m.get('/:username/:reponame/settings/branches', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsBranches);
  m.post('/:username/:reponame/settings/branches/default_branch', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.UpdateDefaultBranch);
  m.get('/:username/:reponame/settings/branches/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsProtectedBranch);
  m.post('/:username/:reponame/settings/branches/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsProtectedBranchPost);
  m.get('/:username/:reponame/settings/hooks', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.Webhooks);
  m.post('/:username/:reponame/settings/hooks/delete', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.DeleteWebhook);
  m.get('/:username/:reponame/settings/hooks/:type/new', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.WebhooksNew);
  m.post('/:username/:reponame/settings/hooks/gogs/new', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.WebhooksNewPost);
  m.post('/:username/:reponame/settings/hooks/slack/new', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.WebhooksSlackNewPost);
  m.post('/:username/:reponame/settings/hooks/discord/new', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.WebhooksDiscordNewPost);
  m.post('/:username/:reponame/settings/hooks/dingtalk/new', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.WebhooksDingtalkNewPost);
  m.get('/:username/:reponame/settings/hooks/git', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsGitHooks);
  m.get('/:username/:reponame/settings/hooks/git/:name', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsGitHooksEdit);
  m.post('/:username/:reponame/settings/hooks/git/:name', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsGitHooksEditPost);
  m.get('/:username/:reponame/settings/hooks/:id', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.WebhooksEdit);
  m.post('/:username/:reponame/settings/hooks/gogs/:id', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.WebhooksEditPost);
  m.post('/:username/:reponame/settings/hooks/slack/:id', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.WebhooksSlackEditPost);
  m.post('/:username/:reponame/settings/hooks/discord/:id', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.WebhooksDiscordEditPost);
  m.post('/:username/:reponame/settings/hooks/dingtalk/:id', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.WebhooksDingtalkEditPost);
  m.post('/:username/:reponame/settings/hooks/:id/test', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.TestWebhook);
  m.post('/:username/:reponame/settings/hooks/:id/redelivery', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.RedeliveryWebhook);
  m.get('/:username/:reponame/settings/keys', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsDeployKeys);
  m.post('/:username/:reponame/settings/keys', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.SettingsDeployKeysPost);
  m.post('/:username/:reponame/settings/keys/delete', reqSignIn, repo.RepoAssignment(), repo.RequireRepoAdmin(), repo.DeleteDeployKey);

  // ----- Repo actions -----
  m.post('/:username/:reponame/action/:action', reqSignIn, repo.RepoAssignment(), repo.Action);

  // ----- Issues (public view) -----
  m.get('/:username/:reponame/issues', ignSignIn, repo.RepoAssignment(), repo.RetrieveLabels, repo.Issues);
  m.get('/:username/:reponame/issues/:index', ignSignIn, repo.RepoAssignment(), repo.ViewIssue);
  m.get('/:username/:reponame/labels', ignSignIn, repo.RepoAssignment(), repo.RetrieveLabels, repo.Labels);
  m.get('/:username/:reponame/milestones', ignSignIn, repo.RepoAssignment(), repo.Milestones);

  // ----- Issues (authored mutations) -----
  m.get('/:username/:reponame/issues/new', reqSignIn, repo.RepoAssignment(), repo.MustEnableIssues, repo.NewIssue);
  m.post('/:username/:reponame/issues/new', reqSignIn, repo.RepoAssignment(), repo.MustEnableIssues, repo.NewIssuePost);
  m.post('/:username/:reponame/issues/:index/title', reqSignIn, repo.RepoAssignment(), repo.UpdateIssueTitle);
  m.post('/:username/:reponame/issues/:index/content', reqSignIn, repo.RepoAssignment(), repo.UpdateIssueContent);
  m.post('/:username/:reponame/issues/:index/comments', reqSignIn, repo.RepoAssignment(), repo.NewComment);
  m.post('/:username/:reponame/comments/:id', reqSignIn, repo.RepoAssignment(), repo.UpdateCommentContent);
  m.post('/:username/:reponame/comments/:id/delete', reqSignIn, repo.RepoAssignment(), repo.DeleteComment);
  m.post('/:username/:reponame/issues/:index/label', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.UpdateIssueLabel);
  m.post('/:username/:reponame/issues/:index/milestone', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.UpdateIssueMilestone);
  m.post('/:username/:reponame/issues/:index/assignee', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.UpdateIssueAssignee);

  // ----- Wiki -----
  // specific wiki actions MUST be registered before /wiki/:page
  m.get('/:username/:reponame/wiki/_pages', ignSignIn, repo.RepoAssignment(), repo.MustEnableWiki, repo.WikiPages);
  m.get('/:username/:reponame/wiki/_new', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.NewWiki);
  m.post('/:username/:reponame/wiki/_new', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.NewWikiPost);
  m.get('/:username/:reponame/wiki/:page/_edit', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.EditWiki);
  m.post('/:username/:reponame/wiki/:page/_edit', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.EditWikiPost);
  m.post('/:username/:reponame/wiki/:page/delete', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.DeleteWikiPagePost);
  m.get('/:username/:reponame/wiki', ignSignIn, repo.RepoAssignment(), repo.MustEnableWiki, repo.Wiki);
  m.get('/:username/:reponame/wiki/:page', ignSignIn, repo.RepoAssignment(), repo.MustEnableWiki, repo.Wiki);

  // ----- Labels / milestones (writer) -----
  m.post('/:username/:reponame/labels/new', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.NewLabel);
  m.post('/:username/:reponame/labels/edit', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.UpdateLabel);
  m.post('/:username/:reponame/labels/delete', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.DeleteLabel);
  m.post('/:username/:reponame/labels/initialize', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.InitializeLabels);
  m.get('/:username/:reponame/milestones/new', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.NewMilestone);
  m.post('/:username/:reponame/milestones/new', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.NewMilestonePost);
  m.get('/:username/:reponame/milestones/:id/edit', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.EditMilestone);
  m.post('/:username/:reponame/milestones/:id/edit', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.EditMilestonePost);
  m.get('/:username/:reponame/milestones/:id/:action(open|close)', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.ChangeMilestonStatus);
  m.post('/:username/:reponame/milestones/delete', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.DeleteMilestone);

  // ----- Releases -----
  m.get('/:username/:reponame/releases/new', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.NewRelease);
  m.post('/:username/:reponame/releases/new', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.NewReleasePost);
  m.post('/:username/:reponame/releases/delete', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.DeleteRelease);
  m.get('/:username/:reponame/releases/edit/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.EditRelease);
  m.post('/:username/:reponame/releases/edit/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.EditReleasePost);

  // ----- Compare & pulls -----
  m.get('/:username/:reponame/compare/*', reqSignIn, repo.RepoAssignment(), repo.CompareAndPullRequest);
  m.post('/:username/:reponame/compare/*', reqSignIn, repo.RepoAssignment(), repo.CompareAndPullRequestPost);
  m.get('/:username/:reponame/pulls', ignSignIn, repo.RepoAssignment(), repo.RetrieveLabels, repo.Pulls);
  m.get('/:username/:reponame/pulls/:index', ignSignIn, repo.RepoAssignment(), repo.ViewPull);
  m.get('/:username/:reponame/pulls/:index/commits', ignSignIn, repo.RepoAssignment(), repo.ViewPullCommits);
  m.get('/:username/:reponame/pulls/:index/files', ignSignIn, repo.RepoAssignment(), repo.ViewPullFiles);
  m.post('/:username/:reponame/pulls/:index/merge', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.MergePullRequest);

  // ----- Web editor -----
  m.get('/:username/:reponame/_edit/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.EditFile);
  m.post('/:username/:reponame/_edit/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.EditFilePost);
  m.get('/:username/:reponame/_new/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.NewFile);
  m.post('/:username/:reponame/_new/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.NewFilePost);
  m.post('/:username/:reponame/_preview/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.DiffPreviewPost);
  m.get('/:username/:reponame/_delete/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.DeleteFile);
  m.post('/:username/:reponame/_delete/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.DeleteFilePost);
  m.get('/:username/:reponame/_upload/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.UploadFile);
  m.post('/:username/:reponame/_upload/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.UploadFilePost);
  m.post('/:username/:reponame/upload-file', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.UploadFileToServer);
  m.post('/:username/:reponame/upload-remove', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.RemoveUploadFileFromServer);

  // ----- Branches / releases / archive / src / commits / forks -----
  m.get('/:username/:reponame/releases', ignSignIn, repo.RepoAssignment(), repo.Releases);
  m.get('/:username/:reponame/branches', ignSignIn, repo.RepoAssignment(), repo.Branches);
  m.get('/:username/:reponame/branches/all', ignSignIn, repo.RepoAssignment(), repo.AllBranches);
  m.post('/:username/:reponame/branches/delete/*', reqSignIn, repo.RepoAssignment(), repo.RequireRepoWriter(), repo.DeleteBranchPost);
  m.get('/:username/:reponame/archive/*', ignSignIn, repo.RepoAssignment(), repo.Download);
  m.get('/:username/:reponame/src/*', ignSignIn, repo.RepoAssignment(), repo.RepoRef(), repo.Home);
  m.get('/:username/:reponame/commits/*', ignSignIn, repo.RepoAssignment(), repo.RefCommits);
  m.get('/:username/:reponame/forks', ignSignIn, repo.RepoAssignment(), repo.Forks);
  m.get('/:username/:reponame/raw/*', ignSignIn, repo.Raw);
  m.get('/:username/:reponame/commit/:sha([a-f0-9]{7,40}).:ext(patch|diff)', ignSignIn, repo.CommitRaw);
  // gogs master serves /commit/<sha> via the React SPA (c.ServeWeb)
  m.get('/:username/:reponame/commit/:sha([a-f0-9]{7,40})', ignSignIn, (c: Context) => { c.ServeWeb(); });
  m.get('/:username/:reponame/commits', ignSignIn, repo.RepoAssignment(), repo.RepoRef(), repo.Commits);

  m.get('/:username/:reponame/tasks/trigger', repo.TriggerTask);

  // ----- Repo home (catch) -----
  m.get('/:username/:reponame', ignSignIn, repo.RepoAssignment(), repo.RepoRef(), repo.Home);
  m.get('/:username/:reponame/stars', ignSignIn, repo.RepoAssignment(), repo.RepoRef(), repo.Stars);
  m.get('/:username/:reponame/watchers', ignSignIn, repo.RepoAssignment(), repo.RepoRef(), repo.Watchers);
}
