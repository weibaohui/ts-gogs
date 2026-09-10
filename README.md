# ts-gogs

A faithful TypeScript port of [Gogs](https://github.com/gogs/gogs) (v0.13+ master), aiming for
**1:1 API and web-UI compatibility**: same routes, same JSON shapes, same disk layout, same
rendered HTML (the original `templates/`, `public/` assets, locale files and even the built
React SPA are reused verbatim).

## Run

```bash
npm install
npm run dev          # tsx src/index.ts, listens on :3000
```

First run: open `http://localhost:3000/install`, fill the form, done. Configuration is written
to `custom/conf/app.ini` using the exact same keys as Gogs (`INSTALL_LOCK`, `ROOT`,
`EXTERNAL_URL`, ...). You can also copy an existing Gogs `app.ini` there — paths and formats
are compatible.

Production build:

```bash
npm run build        # tsc -> dist/
node dist/index.js
```

## What is 1:1

- **HTTP API `/api/v1`** — the full endpoint surface from `internal/route/api/v1/api.go`:
  token/basic auth (`Authorization: token <sha1>`), users, tokens, emails, follows, keys,
  repos, contents (GET/PUT), raw, archive, git trees/blobs, branches, tags, commits,
  hooks, collaborators, deploy keys, issues, comments, labels, milestones, orgs, teams,
  admin. Error shapes (`{message,url}`, `{"ok":true,data}`, 422 binding arrays) included.
- **Git smart HTTP** — `/owner/repo.git/info/refs`, `git-upload-pack`,
  `git-receive-pack` with gogs' auth rules (public pull, basic/token auth, mirror read-only),
  pkt-line advertisement, gzip bodies, and push post-processing via delegate hooks
  (`pre-receive`/`update`/`post-receive` CLI subcommand) using `GOGS_*` env context.
- **Disk layout** — `{ROOT}/{owner}/{repo}.git` and `{repo}.wiki.git`, bare repos,
  delegate hooks, dumb-protocol static objects, archive caches.
- **Web UI** — server-rendered pages run the ORIGINAL `templates/` through a
  Go-template-compatible engine (macaron semantics: pipelines, `call`, range/with/else-if,
  niladic method invocation, html/template escaping + SafeHTML). The React SPA (`public/dist`)
  and its `/api/web/*` JSON endpoints (sign-in/up, MFA, repo header/watch/star) are served
  exactly like the current Gogs master.
- **Sessions** — cookie `i_like_gogs`, flash cookie `macaron_flash`, language cookie `lang`.
- **Database** — SQLite schema mirroring the xorm/GORM tables (same table/column names and
  constraints), PBKDF2-SHA256×10000 password hashing, access-token sha1+sha256.

## Compatibility notes

- `internal/route/api/v1` oddities are preserved: `PATCH issue` returns 201, issue-label
  `url` is always empty, branch/tag `commit.url` is `"Not implemented"`, deploy keys are
  always `read_only: true`.
- Only SQLite is supported by this port (gogs defaults are accepted in app.ini but other
  drivers fail fast).
- SSH: two modes — builtin server (`START_SSH_SERVER = true`, port from `SSH_PORT`) or
  the classic `authorized_keys` mode (default): each user key gets a `command="... serv
  key-<id>"` restriction in the RUN_USER's `~/.ssh/authorized_keys` (marker-scoped,
  foreign entries preserved).
- LFS over SSH: `git-lfs-authenticate` mints an HMAC `RemoteAuth` token consumed by the
  HTTP LFS endpoints, and `git-lfs-transfer` implements the pure SSH transfer protocol
  (lfs-transfer-1) — both available on either SSH mode.
- LDAP/PAM login sources can be managed under `/admin/auths` but authenticating against
  them is not implemented in this build (local/Plain accounts always work).

## Layout

```
src/
  index.ts        CLI entry (serve + hook subcommand)
  server.ts       HTTP pipeline (session/contexter/router/static/SPA)
  context.ts      WebContext, Toggle/RepoAssignment/RepoRef middleware
  conf.ts         app.ini loading (vendored defaults + custom overlay)
  i18n.ts         locale ini loading, go-macaron i18n semantics
  router.ts       macaron-compatible pattern router
  gotemplate/     Go text/template+html/template engine, gogs FuncMap
  markup.ts       markdown pipeline (post-process + bluemonday-style sanitizer)
  db/             SQLite schema + DAOs + activity actions
  gitx/           git CLI wrapper, paths, smart HTTP, repo service
  routes/         web handlers (install/home/user/repo/org/admin)
  api/v1.ts       /api/v1 endpoints
  webapi.ts       /api/web/* SPA endpoints
  webhook.ts      hook_task persistence + delivery
templates/ public/ vendored-conf/   verbatim from gogs (+ public/dist SPA build)
docs/contract/    extracted contracts (api-v1, db-schema, git-layer, web-runtime)
```
