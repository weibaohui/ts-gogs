// /api/web/* JSON endpoints consumed by the React SPA (sign-in/up, MFA,
// activate, reset password, repo header/watch/star/commit).
import * as db from './db/db.js';
import { conf } from './conf.js';
import { Context, completeSignIn } from './context.js';
import { getCommit } from './gitx/git.js';
import { sanitizeHTML } from './markup.js';

interface WebAPIResult {
  status: number;
  body?: any;
}

function errBody(error?: string, fields?: Record<string, string | null>): any {
  const out: any = {};
  if (error) out.error = error;
  if (fields) out.fields = fields;
  return out;
}

function isAlphaDashDot(s: string): boolean {
  return !/[^\d\w\-_.]/.test(s);
}

export async function handleWebAPI(c: Context, subPath: string): Promise<boolean> {
  // subPath begins after /api/web
  const method = c.Method();

  if (subPath === '/user/info' && method === 'GET') {
    if (!c.User) {
      c.Status(204);
      c.res.end();
      c.rendered = true;
      return true;
    }
    c.JSONSuccess({
      username: c.User.name,
      avatarURL: c.User.AvatarURL(),
      isAdmin: c.User.is_admin === 1,
      canCreateOrganization: c.User.CanCreateOrganization(),
    });
    return true;
  }

  if (subPath === '/user/sign-up') {
    if (method === 'GET') {
      c.JSONSuccess({
        registrationDisabled: conf.disableRegistration,
        captchaEnabled: conf.enableRegistrationCaptcha,
      });
      return true;
    }
    if (method === 'POST') {
      const req = await c.form();
      const userName = String(req.userName ?? '');
      const email = String(req.email ?? '');
      const password = String(req.password ?? '');
      if (conf.disableRegistration) {
        c.JSON(403, errBody(c.Tr('auth.disable_register_prompt')));
        return true;
      }
      if (conf.enableRegistrationCaptcha) {
        const { validateCaptcha } = await import('./toolx.js');
        const captchaID = c.GetCookie('gogs_captcha');
        if (!validateCaptcha(captchaID, String(req.captcha ?? ''))) {
          const msg = c.Tr('form.captcha_incorrect');
          c.JSON(401, errBody(undefined, { captcha: msg }));
          return true;
        }
      }
      if (!userName || !isAlphaDashDot(userName) || userName.length > 35) {
        c.JSON(400, errBody(undefined, { userName: c.Tr('form.username') + c.Tr('form.alpha_dash_dot_error') }));
        return true;
      }
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
        c.JSON(400, errBody(undefined, { email: c.Tr('form.email') + c.Tr('form.email_error') }));
        return true;
      }
      if (!password || password.length > 255) {
        c.JSON(400, errBody(undefined, { password: c.Tr('form.password') + c.Tr('form.require_error') }));
        return true;
      }
      let user: db.User;
      try {
        user = db.createUser(userName, email, { password, activated: !conf.requireEmailConfirmation });
      } catch (e: any) {
        if (e instanceof db.AlreadyExistError) {
          if (String(e.message).includes('email')) {
            c.JSON(422, errBody(undefined, { email: c.Tr('form.email_been_used') }));
          } else {
            c.JSON(422, errBody(undefined, { userName: c.Tr('form.username_been_taken') }));
          }
          return true;
        }
        if (e instanceof db.NameNotAllowedError) {
          c.JSON(400, errBody(undefined, { userName: c.Tr('user.form.name_not_allowed', userName) }));
          return true;
        }
        throw e;
      }
      // first user becomes admin & activated
      const count = (db.db().prepare('SELECT COUNT(*) AS c FROM user WHERE type = 0').get() as any).c;
      if (count === 1) {
        db.updateUserColumns(user.id, { is_active: 1, is_admin: 1 });
      }
      c.JSONSuccess({});
      return true;
    }
  }

  if (subPath === '/user/sign-in') {
    if (method === 'GET') {
      // local auth only in this port; no external login sources yet
      c.JSONSuccess({ loginSources: [] });
      return true;
    }
    if (method === 'POST') {
      const req = await c.form();
      const username = String(req.username ?? '');
      const password = String(req.password ?? '');
      const user = db.getUserByUsername(username) ?? db.getUserByEmail(username);
      const { verifyPassword } = await import('./authx/password.js');
      let authed = !!(user && user.type === 0 && verifyPassword(password, user.salt, user.passwd));
      // dsh 桥：本库不中时对 user-management 用户库验证，UM 凭据映射到管理员账号
      if (!authed) {
        const um = await import('./authx/um.js');
        if (um.umAuthEnabled()) {
          const check = um.umCheck(username, password);
          if (check.ok) {
            const mapped = um.ensureMappedUser(username);
            if (mapped && mapped.type === 0) {
              completeSignIn(c, mapped);
              c.JSONSuccess({});
              return true;
            }
          }
        }
      }
      if (!authed) {
        c.JSON(401, errBody(c.Tr('form.username_password_incorrect'), { username: null, password: null }));
        return true;
      }
      const twofactor = await import('./twofactor.js');
      if (twofactor.isTwoFactorEnabled(user!.id)) {
        c.session.Set('mfaUserID', user!.id);
        c.session.Release();
        c.JSONSuccess({ mfa: true });
        return true;
      }
      completeSignIn(c, user!);
      c.JSONSuccess({});
      return true;
    }
  }

  if (subPath === '/user/dsh-impersonate') {
    if (method !== 'POST') {
      c.JSON(405, { error: 'method not allowed' });
      return true;
    }
    const um = await import('./authx/um.js');
    const secret = process.env.DSH_IMPERSONATE_SECRET || '';
    const reqSecret = String((await c.form()).secret ?? c.req.headers['x-dsh-secret'] ?? '');
    if (!um.umAuthEnabled() || !secret || reqSecret !== secret) {
      c.JSON(404, { error: 'not found' });
      return true;
    }
    const req2 = await c.form();
    const uname = String(req2.username ?? '').trim();
    const rec = um.umUserRecord(uname);
    if (!rec || rec.disabled) {
      c.JSON(404, { error: 'user not found' });
      return true;
    }
    const mapped = um.ensureMappedUser(uname);
    if (!mapped || mapped.type !== 0) {
      c.JSON(500, { error: 'provision failed' });
      return true;
    }
    completeSignIn(c, mapped);
    c.JSONSuccess({});
    return true;
  }

  if (subPath === '/user/mfa') {
    if (method === 'GET') {
      const uid = c.session.Get('mfaUserID');
      if (!uid) {
        c.Status(404);
        c.res.end();
        c.rendered = true;
        return true;
      }
      c.Status(204);
      c.res.end();
      c.rendered = true;
      return true;
    }
    if (method === 'POST') {
      const uid = c.session.Get('mfaUserID');
      if (!uid) {
        c.JSON(401, errBody(c.Tr('auth.mfa_session_expired')));
        return true;
      }
      const req = await c.form();
      const passcode = String(req.passcode ?? '');
      const twofactor = await import('./twofactor.js');
      if (!/^[0-9]{6}$/.test(passcode)) {
        const msg = c.Tr('auth.mfa_invalid_passcode');
        c.JSON(401, errBody(undefined, { passcode: msg }));
        return true;
      }
      if (!twofactor.validateTOTP(uid, passcode)) {
        const msg = c.Tr('auth.mfa_invalid_passcode');
        c.JSON(401, errBody(undefined, { passcode: msg }));
        return true;
      }
      if (twofactor.passcodeRecentlyUsed(uid, passcode)) {
        const msg = c.Tr('auth.mfa_reused_passcode');
        c.JSON(401, errBody(undefined, { passcode: msg }));
        return true;
      }
      twofactor.markPasscodeUsed(uid, passcode);
      const u = db.getUserByID(uid);
      if (!u) {
        c.Status(500);
        c.res.end();
        c.rendered = true;
        return true;
      }
      completeSignIn(c, u);
      c.JSONSuccess({});
      return true;
    }
  }

  if (subPath === '/user/mfa/recovery' && method === 'POST') {
    const uid = c.session.Get('mfaUserID');
    if (!uid) {
      c.JSON(401, errBody(c.Tr('auth.mfa_session_expired')));
      return true;
    }
    const req = await c.form();
    const twofactor = await import('./twofactor.js');
    if (!twofactor.useRecoveryCode(uid, String(req.recoveryCode ?? ''))) {
      const msg = c.Tr('auth.mfa_invalid_recovery_code');
      c.JSON(401, errBody(undefined, { recoveryCode: msg }));
      return true;
    }
    const u = db.getUserByID(uid);
    if (!u) {
      c.Status(500);
      c.res.end();
      c.rendered = true;
      return true;
    }
    completeSignIn(c, u);
    c.JSONSuccess({});
    return true;
  }

  if (subPath === '/user/sign-out' && method === 'POST') {
    c.session.Clear();
    c.session.Release();
    c.SetCookie(conf.cookieUserName, '', 0);
    c.NoContent();
    return true;
  }

  if (subPath === '/user/reset-password') {
    if (method === 'GET') {
      const code = c.Query('code');
      let valid = false;
      if (code) {
        const { verifyUserFromCode } = await import('./toolx.js');
        const parsed = verifyUserFromCode(code, (u: string) => db.getUserByUsername(u));
        valid = !!parsed?.valid;
      }
      c.JSONSuccess({ emailEnabled: conf.emailEnabled, valid });
      return true;
    }
    if (method === 'POST') {
      if (!conf.emailEnabled) {
        c.JSON(403, errBody(c.Tr('auth.disable_register_mail')));
        return true;
      }
      const req = await c.form();
      const email = String(req.email ?? '').toLowerCase().trim();
      const user = db.getUserByEmail(email);
      if (!user) {
        c.JSONSuccess({ hours: Math.floor(conf.activateCodeLives / 60) });
        return true;
      }
      if (user.type !== 0) {
        const msg = c.Tr('auth.non_local_account');
        c.JSON(403, errBody(undefined, { email: msg }));
        return true;
      }
      try {
        const { createActivateCode } = await import('./toolx.js');
        const { sendResetPasswordMail } = await import('./mailer.js');
        const code = createActivateCode(user, conf.resetPwdCodeLives) + Buffer.from(user.name).toString('hex');
        await sendResetPasswordMail(user, code);
        c.JSONSuccess({ hours: Math.floor(conf.resetPwdCodeLives / 60) });
      } catch (e: any) {
        console.error('[mailer] reset mail:', e?.message ?? e);
        c.JSONSuccess({ hours: Math.floor(conf.resetPwdCodeLives / 60) });
      }
      return true;
    }
  }

  if (subPath === '/user/reset-password/complete' && method === 'POST') {
    const req = await c.form();
    const code = String(req.code ?? '');
    const { verifyUserFromCode } = await import('./toolx.js');
    const parsed = verifyUserFromCode(code, (u: string) => db.getUserByUsername(u));
    if (!parsed || !parsed.valid) {
      c.JSON(400, errBody(c.Tr('auth.invalid_code')));
      return true;
    }
    const password = String(req.password ?? '');
    if (password.length < 6) {
      const msg = c.Tr('auth.password_too_short');
      c.JSON(400, errBody(undefined, { password: msg }));
      return true;
    }
    const { encodePassword, randomSalt } = await import('./authx/password.js');
    const salt = randomSalt();
    db.updateUserColumns(parsed.user.id, { passwd: encodePassword(password, salt), salt });
    c.Status(204);
    c.res.end();
    c.rendered = true;
    return true;
  }

  if (subPath === '/user/activate') {
    if (!c.User) {
      c.Status(401);
      c.res.end();
      c.rendered = true;
      return true;
    }
    if (method === 'POST') {
      if (!conf.requireEmailConfirmation) {
        c.JSON(403, errBody(c.Tr('auth.disable_register_mail')));
        return true;
      }
      if (!conf.emailEnabled) {
        c.JSON(403, errBody(c.Tr('auth.disable_register_mail')));
        return true;
      }
      try {
        const { createActivateCode } = await import('./toolx.js');
        const { sendActivateMail } = await import('./mailer.js');
        const code = createActivateCode(c.User, conf.activateCodeLives) + Buffer.from(c.User.name).toString('hex');
        await sendActivateMail(c.User, code);
        c.JSONSuccess({ codeLifetimeHours: Math.floor(conf.activateCodeLives / 60) });
      } catch (e: any) {
        console.error('[mailer] activate mail:', e?.message ?? e);
        c.JSON(500, errBody(String(e?.message ?? e)));
      }
      return true;
    }
    c.JSONSuccess({ email: c.User.email, codeLifetimeHours: Math.floor(conf.activateCodeLives / 60) });
    return true;
  }

  if (subPath === '/user/activate/complete' && method === 'POST') {
    const req = await c.form();
    const code = String(req.code ?? '');
    const { verifyUserFromCode } = await import('./toolx.js');
    const parsed = verifyUserFromCode(code, (u: string) => db.getUserByUsername(u));
    if (!parsed || !parsed.valid) {
      c.JSON(400, errBody(c.Tr('auth.invalid_code')));
      return true;
    }
    const { randomSalt } = await import('./authx/password.js');
    const salt = randomSalt();
    db.updateUserColumns(parsed.user.id, { is_active: 1, rands: salt });
    completeSignIn(c, parsed.user);
    c.Status(204);
    c.res.end();
    c.rendered = true;
    return true;
  }

  // repo endpoints
  const repoMatch = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(subPath);
  if (repoMatch) {
    const [, ownerName, repoName, rest] = repoMatch;
    const owner = db.getUserByUsername(ownerName);
    const repo = owner ? db.getRepoByOwnerAndName(owner, repoName) : null;
    if (owner && repo) {
      const viewerID = c.UserID();
      const mode = db.accessMode(viewerID, repo);
      const canRead = mode >= db.AccessMode.READ || (!repo.is_private && !conf.requireSigninView);
      if (rest === '/header' && method === 'GET') {
        if (!canRead) {
          c.Status(404);
          c.res.end();
          c.rendered = true;
          return true;
        }
        c.JSONSuccess({
          id: repo.id,
          owner: owner.name,
          name: repo.name,
          avatarURL: owner.AvatarURL(),
          visibility: repo.is_private ? 'private' : 'public',
          watchCount: repo.num_watches,
          starCount: repo.num_stars,
          forkCount: repo.num_forks,
          issuesEnabled: repo.enable_issues === 1,
          openIssueCount: repo.num_issues - repo.num_closed_issues,
          pullRequestsEnabled: repo.enable_pulls === 1,
          openPullRequestCount: repo.num_pulls - repo.num_closed_pulls,
          wikiEnabled: repo.enable_wiki === 1,
          viewerCanAdminister: mode >= db.AccessMode.ADMIN,
          viewerIsWatching: !!db.isWatching(viewerID, repo.id),
          viewerIsStarring: !!db.isStaring(viewerID, repo.id),
        });
        return true;
      }
      if (rest === '/watch') {
        if (method === 'POST') {
          db.watchRepo(viewerID, repo.id, true);
          c.NoContent();
          return true;
        }
        if (method === 'DELETE') {
          db.watchRepo(viewerID, repo.id, false);
          c.NoContent();
          return true;
        }
      }
      if (rest === '/star') {
        if (method === 'POST') {
          db.starRepo(viewerID, repo.id, true);
          c.NoContent();
          return true;
        }
        if (method === 'DELETE') {
          db.starRepo(viewerID, repo.id, false);
          c.NoContent();
          return true;
        }
      }
      const commitMatch = /^\/commit\/([0-9a-f]{7,40})$/.exec(rest ?? '');
      if (commitMatch && method === 'GET') {
        if (!canRead) {
          c.Status(404);
          c.res.end();
          c.rendered = true;
          return true;
        }
        const commit = await getCommit(repo.RepoPath(), commitMatch[1]);
        if (!commit) {
          c.Status(404);
          c.res.end();
          c.rendered = true;
          return true;
        }
        const authorUser = db.getUserByEmail(commit.author.email);
        c.JSONSuccess({
          sha: commit.id,
          subject: commit.Summary(),
          body: commit.message.slice(commit.Summary().length).replace(/^\n/, ''),
          author: {
            name: commit.author.name,
            email: commit.author.email,
            when: commit.author.when.toISOString(),
            avatarURL: avatarURLForEmail(commit.author.email),
            ...(authorUser ? { profileURL: authorUser.HomeURLPath() } : {}),
          },
          parents: commit.parents,
        });
        return true;
      }
    }
  }

  return false;
}

function avatarURLForEmail(email: string): string {
  return conf.subpath + '/user/avatar/' + require_md5(email);
}

// small helper to avoid import cycle overhead
import { md5 } from './authx/password.js';
function require_md5(s: string): string {
  return md5(s.trim().toLowerCase());
}
