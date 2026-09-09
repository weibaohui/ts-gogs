# Gogs Web 运行时契约（web-runtime contract）

> 源码基线：gogs-reference（macaron.v1 v1.5.1 + go-macaron/i18n v0.6.0 + go-macaron/session v1.0.4 + unknwon/paginater）。
> 关键文件：`internal/template/template.go`、`internal/context/{context,repo,org,auth,notice,user}.go`、`cmd/gogs/internal/web/web.go`、`cmd/gogs/internal/web/webapi_user.go`、`templates/base/{head,footer,alert}.tmpl`、`internal/markup/*`、`internal/tool/tool.go`、`internal/database/repo.go(ComposeMetas)`。
> 注意：本版本已将登录/注册/404 等迁到 React SPA（`/api/web/*`），旧版 Gogs 中的 CSRF 中间件、`.T`、`TangoStyle`、`Route2URL`、`Str2html`、`ShortSha`、`Avatar`（圆角函数）均已不存在。

## 1. 模板引擎机制

### 1.1 渲染器装配（macaron.Renderer）
- 模板目录：`{WorkDir}/templates`，自定义覆盖目录 `custom/templates`（AppendDirectories，优先生效）；`LoadAssetsFromDisk=false` 时用嵌入文件系统。
- 模板名 = 相对路径去扩展名，如 `templates/repo/home.tmpl` → `repo/home`；`c.Success("repo/home")` 渲染它。
- 函数表：`Funcs: template.FuncMap()`（见 1.2）。
- macaron 渲染中间件自动注入 `Data["TmplLoadTimes"]`：`func() string` 返回 `"Xms"`（自请求开始毫秒），footer 里 `{{call .TmplLoadTimes}}`。
- 静态资源优先级：`custom/public` > `public/`（嵌入）> 头像目录（带 Prefix）。GZIP 由 `ENABLE_GZIP` 控制。

### 1.2 注册的模板函数（FuncMap，共 39 个）
配置读取类（无参）：`BuildCommit`（编译期 commit，css/js 缓存破坏参数）、`Year`、`UseHTTPS`（conf.Server.URL.Scheme === "https"）、`AppName`（conf.App.BrandName 默认 "Gogs"）、`AppSubURL`（conf.Server.Subpath 如 "/gogs"）、`AppURL`（conf.Server.ExternalURL）、`AppVer`、`AppDomain`（conf.Server.Domain）、`DisableGravatar`、`ShowFooterTemplateLoadTime`、`ThemeColorMetaTag`（head 的 `<meta name="theme-color">`）。

工具类：
| 函数 | 签名 | 语义 |
|---|---|---|
| `LoadTimes` | `(start: Date) => string` | `${Date.now()-start.getTime()}ms` |
| `AvatarLink` | `(email) => string` | federated avatar 可选；否则 `gravatarSource + md5(email.trim().toLowerCase()) + "?d=identicon"`；否则 `subpath + "/img/avatar_default.png"` |
| `AppendAvatarSize` | `(url, size)` | `url.includes("?") ? url+"&s="+size : url+"?s="+size` |
| `Safe` | `(raw) => HTML` | 原样标记为安全 HTML，**不过滤**（跳过转义） |
| `Sanitize` | `(raw) => string` | bluemonday UGC 白名单过滤 |
| `Str2HTML` | `(raw) => HTML` | `sanitize(raw)` 后标记安全 |
| `NewLine2br` | `(raw)` | `raw.replaceAll("\n","<br>")`（不转义！） |
| `TimeSince` | `(t, lang) => HTML` | `<span class="time-since" title="${t.format(conf.Time.FormatLayout)}">${timeSince(t,lang)}</span>` |
| `RawTimeSince` | `(t, lang)` | 同上不含 span 包装 |
| `FileSize` | `(bytes)` | 1024 进制 B/KB/…/EB；<10 显示整数否则 1 位小数 |
| `Subtract` | `(a, b)` | 整数减法（Go 版右操作数 float 怪癖按减法实现即可） |
| `Add` | `(a, b)` | `a+b` |
| `SubStr` | `(s, start, len)` | 字节切片；`len===-1` 到末尾；越界返回原串 |
| `Join` | `(arr, sep)` | `arr.join(sep)` |
| `EllipsisString` | `(s, n)` | 字节长度 > n 时 `s.slice(0,n)+"..."`，否则原样（n<0 原样） |
| `Sha1` | `(s)` | `sha1(s)` 十六进制 |
| `ShortSHA1` | `(sha)` | `sha.length>10 ? sha.slice(0,10) : sha` |
| `EscapePound` | `(s)` | 依次替换 `%`→`%25`、`#`→`%23`、空格→`%20`、`?`→`%3F` |
| `DateFmtLong` | `(t)` | RFC1123Z 格式（`Mon, 02 Jan 2006 15:04:05 -0700`） |
| `DateFmtShort` | `(t)` | `"Jan 02, 2006"` |
| `FilenameIsImage` | `(name)` | `mime.TypeByExtension(ext).startsWith("image/")` |
| `TabSizeClass` | `(ec, name)` | editorconfig 命中且 tabWidth>0 → `tab-size-${w}`，否则 `"tab-size-8"` |
| `InferSubmoduleURL` | `(baseURL, mod)` | `../` 相对 → `baseURL+raw+"/commit/"+mod.commit`；`git@host:path` SCP → `http://host/path`；ssh:// → `http://...`；其余原样 |
| `DiffFileTypeToStr` | `(t)` | add→`add`，change→`modify`，delete→`del`，rename→`rename` |
| `DiffLineTypeToStr` | `(t)` | add→`add`，delete→`del`，section→`tag`，其余→`same` |

行为类：
- `ActionIcon(opType)`：`1,8→repo`；`5→git-commit`；`6→issue-opened`；`7→git-pull-request`；`9→tag`；`10→comment-discussion`；`11→git-merge`；`12,14→issue-closed`；`13,15→issue-reopened`；`16→git-branch`；`17,18→alert`；`19→repo-forked`；`20,21,22→repo-clone`；默认 `"invalid type"`。
- `ActionContent2Commits(act)` — `JSON.parse(act.GetContent())`，失败记日志并返回空结构。
- `RenderCommitMessage(full, msg, urlPrefix, metas)` — 见 §9.5。

### 1.3 Context helper（internal/context/context.go）
- `RawTitle(s)` → `Data["Title"]=s`；`Title(localeKey)` → `Data["Title"]=c.Tr(localeKey)`。
- `PageIs(name)` → `Data["PageIs"+name]=true`（如 `c.PageIs("SettingsHooks")` → `.PageIsSettingsHooks`）。
- `Require(name)` → `Data["Require"+name]=true`；便捷方法 `RequireHighlightJS/RequireSimpleMDE/RequireAutosize/RequireDropzone`。
- `FormErr(names...)` → 逐个 `Data["Err_"+name]=true`（模板表单字段错误高亮）。
- `HasError()` → 读 `Data["HasError"]`；为真时把 `Data["ErrorMsg"]` 写进 `c.Flash.ErrorMsg` 并回填 `Data["Flash"]`。
- `Redirect(loc)` 会先 `EscapePound`；`RedirectSubpath(loc)` 前缀 `conf.Server.Subpath`。
- `RenderWithErr(msg, status, tpl, form)`：`form.Assign` 回填表单值 + `Flash.ErrorMsg=msg` + `Data["Flash"]=c.Flash` 后渲染。

## 2. Data 键清单（按设置方分组）

### 2.1 macaron 中间件注入（每个模板都可见）
| 键 | 类型/值 | 设置方 |
|---|---|---|
| `TmplLoadTimes` | `func() string`（"Xms"） | macaron Renderer |
| `i18n` | Locale：`Tr(msg, args...)` / `TrIndex` / `Language()` | go-macaron/i18n |
| `Tr` | 全局 `i18n.Tr` 函数 | go-macaron/i18n |
| `Lang` / `LangName` | 当前语言代码 / 语言显示名 | go-macaron/i18n |
| `AllLangs` / `RestLangs` | `[{Lang,Name}]` 全量 / 除当前外 | go-macaron/i18n |
| `Flash` | `*session.Flash`（ErrorMsg/WarningMsg/InfoMsg/SuccessMsg） | go-macaron/session |

### 2.2 Contexter（每个页面请求）
`Link`（= `Subpath + TrimSuffix(URL.Path,"/")`，且 `Data["Link"]` 为 EscapePound 后的值）、`PageStartTime`；登录后：`IsLogged`、`LoggedUser`、`LoggedUserID`、`LoggedUserName`、`IsAdmin`；匿名：`LoggedUserID=0`、`LoggedUserName=""`；`ShowRegistrationButton = !conf.Auth.DisableRegistration`；`ServerNotice`（存在 `custom/notice/banner.md` 且 ≤1KB 时，RawMarkdown 渲染）。响应头固定加 `X-Content-Type-Options: nosniff`、`X-Frame-Options: deny`。
`Toggle`（reqSignIn 等）：`Title=c.Tr("auth.prohibit_login")`（禁登录页）；`AdminRequired` 通过后 `PageIs("Admin")`；未登录访问受限页 → 写 `redirect_to` cookie 并跳 `/user/sign-in`。

### 2.3 RepoAssignment()（internal/context/repo.go）
`Username`、`RepoName`、`IsBareRepo`、`RepoLink`、`RepoRelPath`（owner/name）、`Title`（"owner/name"）、`Repository`、`Owner`、`IsRepositoryOwner`、`IsRepositoryAdmin`、`IsRepositoryWriter`、`DisableSSH`、`DisableHTTP`、`CloneLink`（{HTTPS,SSH,Git}）、`WikiCloneLink`、`Tags`、登录时 `IsWatchingRepo`、`IsStaringRepo`；非 bare 追加：`TagName`、`Branches`、`BranchCount`、`BranchName`（默认分支回退）、`CommitID`、`IsGuest = !HasAccess()`；镜像仓加 `Mirror`、`MirrorInterval`、`MirrorEnablePrune`。

### 2.4 RepoRef()
`BranchName`、`CommitID`、`TreePath`、`IsViewBranch`、`IsViewTag`、`IsViewCommit`；PR 允许时 `BaseRepo`、`PullRequestCtx`（{BaseRepo,Allowed,SameRepo,HeadInfo}）。

### 2.5 OrgAssignment(args...)
`Org`（组织对象）、`OrgLink`（`Subpath+/org/+name`）、`IsOrganizationOwner`、`IsOrganizationMember`；团队路由追加 `Team`、`IsTeamMember`、`IsTeamAdmin`；匿名时写假 `SignedUser = {}`。

### 2.6 路由闭包（cmd/gogs/internal/web/web.go）
`/user/settings` 组 → `PageIsUserSettings`；repo `/settings` 组 → `PageIsSettings`；releases/branches/editor 组 → `PageIsViewFiles`。

### 2.7 各 handler 通用模式
- `Title`（多数 handler 本地化标题）、`PageIs*`（约 70 个取值：Dashboard/News/Issues/Pulls/Explore/ExploreRepositories/ExploreUsers/ExploreOrganizations/UserProfile/Followers/Following/Home/SignIn/SignUp/Admin/AdminDashboard/AdminConfig/AdminUsers/AdminAuthentications/AdminOrganizations/AdminRepositories/AdminNotices/AdminMonitor/Settings(Options|Profile|Password|SSHKeys|Emails|Avatar|Applications|Security|Repositories|Organizations|Branches|Collaboration|Hooks|HooksNew|HooksEdit|GitHooks|Delete)/RepositoryContext/OrganizationContext/RepoHome/Commits/BranchesOverview/BranchesAll/Labels/Milestones/IssueList/Issues/EditMilestone/ComparePull/PullList/PullConversation/PullCommits/PullFiles/Wiki/WikiEdit/Upload/Edit/Delete 等）。
- `Require*`：`RequireHighlightJS`（view_home/diff/wiki/webhook/issue/editor/pull）、`RequireSimpleMDE`（issue 新建、editor、wiki 编辑、repo settings）、`RequireDropzone`（issue、release、editor 上传）、`RequireAutosize`（repo create、settings）、`RequireMinicolors`（label 颜色）、`RequireDatetimepicker`（milestone 截止日）。
- 页面级数据键：`IsMarkdown`、`IsIPythonNotebook`、`CommitsCount`、`CommitCount`、`Page`（分页器）、`Total`、`Keyword`、`ErrorMsg`、`HasError`、`Err_*`、`ContextUser`、`Feeds`、`Orgs`、`Repos`、`IssueStats`、`ViewType`、`SortType`、`IsShowClosed` 等。

### 2.8 模板常用顶层变量速查
`Title, Link, PageStartTime, TmplLoadTimes, i18n, Tr, Lang, LangName, AllLangs, RestLangs, Flash, IsLogged, LoggedUser, LoggedUserID, LoggedUserName, IsAdmin, ShowRegistrationButton, ServerNotice, Repository, Owner, Username, RepoName, IsBareRepo, RepoLink, RepoRelPath, CloneLink, WikiCloneLink, DisableSSH, DisableHTTP, Tags, Branches, BranchCount, BranchName, TagName, CommitID, TreePath, IsViewBranch, IsViewTag, IsViewCommit, IsRepositoryOwner, IsRepositoryAdmin, IsRepositoryWriter, IsWatchingRepo, IsStaringRepo, IsGuest, BaseRepo, PullRequestCtx, Org, OrgLink, Team, IsOrganizationOwner, IsOrganizationMember, IsTeamMember, IsTeamAdmin, Page, Total, Keyword, ErrorMsg, HasError, Err_*, Require*, PageIs*, ContextUser`。

## 3. i18n

- 文件：`conf/locale/locale_*.ini`，共 33 个；`[i18n] LANGS/NAMES` 定义顺序与显示名；默认语言 `en-US`。
- 键格式：INI `section.key`（如 `repo.issues.previous`、`admin.users.new_success`）；顶层键无 section。模板使用 `{{.i18n.Tr "section.key"}}`。
- `Tr(msg, args...)`：取翻译后用 `fmt.Sprintf` 风格插值（`%s`、`%[1]s`）。
- 语言解析顺序（go-macaron/i18n v0.6.0）：① URL `?lang=xx`（若 `Redirect=true`：SetCookie 后 303 重定向到去掉 lang 参数的 URL）→ ② cookie `lang`（Path=`/`+SubURL）→ ③ `Accept-Language`（matcher 在 LANGS 中匹配）→ ④ DefaultLang `en-US`。
- cookie 名固定为 **`lang`**；另有 `[i18n.datelang]` 把 Gogs 语言映射到 jQuery DateTimePicker 语言。

## 4. Flash 消息机制

- 实现：go-macaron/session 的 Flash，**存储在 cookie `macaron_flash`**（不是 session）。
- 写：`c.Flash.Success(msg)` / `Error` / `Warning` / `Info` → 把键值放入 `url.Values`（键分别为 `success/error/warning/info`）；响应钩子在返回时 `SetCookie("macaron_flash", url.Values.Encode(), 0, CookiePath=Subpath)`（会话 cookie）。
- 读：下一请求读 `macaron_flash` cookie → `url.ParseQuery` → 填充四个 *Msg 字段 → **立即删除该 cookie**，并 `ctx.Data["Flash"]=f` 注入模板。
- 模板读取（`templates/base/alert.tmpl`）：四种消息分别渲染为 `ui negative/warning/positive/info message`，内容 `{{.Flash.XxxMsg | Str2HTML}}`。
- 典型用法：`c.Flash.Success(c.Tr("...")); c.Redirect(...)`（PRG 模式）。

## 5. Session

- 中间件：`session.Sessioner(...)`，配置 `[session]`：
  - `PROVIDER = memory`（可选 `file`：`PROVIDER_CONFIG=data/sessions`；`redis`）；
  - **cookie 名 = `i_like_gogs`**（`COOKIE_NAME`），Path=`conf.Server.Subpath`，Secure=`COOKIE_SECURE`；
  - `CookieLifeTime = 86400 * [security] LOGIN_REMEMBER_DAYS`（默认 7 天）；`GC_INTERVAL=3600`；`MAX_LIFE_TIME=604800`。
  - Session ID：32 位小写 hex（随机 16 字节）。
- 存储内容（TS 需要兼容的键）：
  - `uid: int64`（登录用户 ID；0/缺失=匿名）；
  - `uname: string`（登录名）；
  - `mfaUserID: int64`（MFA 两步流程中间态）；
  - `twoFactorSecret` / `twoFactorURL`（2FA 启用流程临时态）。
  - 注意：macaron Flash 不走 session（走 cookie）；`redirect_to` 也是独立 cookie。
- 登录写入点：React webapi `POST /api/web/user/sign-in` 成功后 `sess.Set("uid", u.ID); sess.Set("uname", u.Name)`，可选 `login_status` cookie（`ENABLE_LOGIN_STATUS_COOKIE`）。登出 `POST /api/web/user/sign-out` 清 session。

## 6. CSRF

- **本代码库没有 CSRF 中间件**：go.mod 无 csrf 依赖；模板与 Go/TS 源码中无 `_csrf`、`CsrfTokenHtml`、`X-Csrf-Token`。写操作全部是 JSON body 的 `/api/web/*` + session cookie（同源由 SPA 保证）。

## 7. 静态资源与前端库加载

### 7.1 页面引用入口（templates/base/head.tmpl + footer.tmpl）
head（无条件）：`/js/jquery-3.7.1.min.js`、`/js/libs/jquery.are-you-sure.js`、`assets/font-awesome-4.6.3/css/font-awesome.min.css`、`assets/octicons-4.3.0/octicons.min.css`、`css/semantic-2.4.2.min.css`、`css/gogs.min.css?v={{BuildCommit}}`、`/js/semantic-2.4.2.min.js`、`/js/gogs.js?v={{BuildCommit}}`；favicon `{{AppSubURL}}/img/favicon.png`；`<html data-suburl>`、`<meta name="_suburl">`。
footer（无条件末尾）：`/js/libs/emojify-1.1.0.min.js`、`/js/libs/clipboard-2.0.4.min.js`。

### 7.2 条件加载（Data 键 → 资源）
| 条件键 | 资源 |
|---|---|
| `IsIPythonNotebook` | dompurify-3.4.8 + marked-4.3.0 + notebookjs-0.8.3（head） |
| `RequireSimpleMDE` | simplemde-1.10.1 css/js + codemirror-5.17.0 loadmode/meta（`CodeMirror.modeURL = suburl/plugins/codemirror-5.17.0/mode/%N/%N.js`） |
| `RequireHighlightJS` | highlight-9.18.0 `github.css` + `highlight.pack.js` + `hljs.initHighlightingOnLoad()`（footer） |
| `RequireMinicolors` | jquery.minicolors-2.2.3 |
| `RequireDatetimepicker` | jquery.datetimepicker-2.4.5 |
| `RequireDropzone` | dropzone-5.5.0 + `Dropzone.autoDiscover=false` |
| `RequireAutosize` | autosize-4.0.2 |
| `IsMarkdown` | mermaid-11.12.1 + 初始化脚本 |

### 7.3 highlight.js 调用方式
- 页面加载：`hljs.initHighlightingOnLoad()`；动态内容：gogs.js 中 `hljs.highlightBlock(el)`；`.nohighlight` 类跳过。
- 服务端只给 `<code>` 加 class（sanitize 白名单 `class="language-\w+"`）；文件名 → class 推断在 `internal/template/highlight`：小写文件名匹配（`cmakelists.txt→cmake`、`dockerfile`、`makefile`），扩展名直映射（约 36 个），`[highlight.mapping]` 覆盖（默认 `.txt→nohighlight`），`license/copying` 忽略。

### 7.4 emojify
纯前端：`emojify.setConfig({ img_dir: suburl+"/img/emoji", ignore_emoticons: true })`，对 `.has-emoji` 元素和预览面板 `emojify.run(el)`。后端不做 emoji 替换。

## 8. 通用页面流

- `c.Success(tpl)` = `c.HTML(200, tpl)`。渲染失败的模板名会 500。
- `c.NotFound()`：**不渲染 Go 404 模板**，而是把请求交给 React webHandler（`serveWeb`），注入 `WebContext{Lang, SubURL, StatusCode:404}`；SPA 渲染自己的 404。`c.ServeWeb()` 同理（SPA 路由接管）。
- `c.Error(err, msg)` / `c.Errorf`：记录日志；`Title="status.internal_server_error"` 本地化；仅当非 prod 模式或登录管理员时 `Data["ErrorMsg"]=err`；渲染 `status/500`（prod 下隐藏错误详情）。`c.NotFoundOrError(err,msg)`：`errx.IsNotFound(err)` → NotFound，否则 Error。
- `Toggle`：未登录访问受限页 → 若是 web 白名单路径（`/user/sign-in`、`/user/mfa`、`/assets/*`、`/src/*`、`/img/*` 等）直接 `ServeWeb()`，否则 `SetCookie("redirect_to", ...)` + 跳 `/user/sign-in`；管理员不足 → 403。
- `m.SetAutoHead(true)`：**HEAD 请求自动复用 GET handler**，路由按 GET 匹配、执行后丢弃响应体。
- 页面骨架：`{{template "base/head" .}} … {{template "base/footer" .}}`；表单页配 `base/alert`（Flash）。

## 9. Markdown / 标记渲染管线（internal/markup/）

### 9.1 总管线
```
urlPrefix = trimRight(replaceAll(urlPrefix," ","%20"), "/")
rawHTML = RawMarkdown(bytes, urlPrefix)        // typ=markdown；orgmode 走 RawOrgMode；未知类型原样返回
rawHTML = postProcessHTML(rawHTML, urlPrefix, metas)
return   SanitizeBytes(rawHTML)                // bluemonday 白名单
```
入口：`markup.Markdown(input, urlPrefix, metas)`。模板函数 `Sanitize`/`Str2HTML` 也走同一 bluemonday 策略。

### 9.2 blackfriday 渲染（markdown.go）
- flags：`SKIP_STYLE`、`OMIT_CONTENTS`；Smartypants 可选。
- extensions：`NO_INTRA_EMPHASIS, TABLES, FENCED_CODE, AUTOLINK, STRIKETHROUGH, SPACE_HEADERS, NO_EMPTY_LINE_BEFORE_BLOCK`，`EnableHardLineBreak` 可选。
- 自定义渲染：
  - 相对链接补全：非 `scheme://`/`mailto:`/`#` 开头的链接 → `path.Join(urlPrefix, link)`（绝对化）。
  - AutoLink：链接以 `ExternalURL` 开头时，commit 链接 → `<code><a href="…">ShortSHA1</a></code>`；issues 链接 → 本仓 `#N`，跨仓 `owner/repo#N`。
  - 任务列表：列表项前缀 `[ ] `/`[x] ` → `<input type="checkbox" disabled(checked)/>`。

### 9.3 postProcessHTML（特殊链接只作用于纯文本节点）
HTML tokenizer 遍历：`TextToken` → `RenderSpecialLink`；`a/code/pre` 开标签后的内容**原样跳过**（栈计数配对）；`img` → `wrapImgWithLink`（相对 `src` 先把 urlPrefix 的 `/src/` 换成 `/raw/` 再拼接，`data:` 与绝对 URL 跳过；相对图 `src` 中空格转 `%20`）。
`RenderSpecialLink` 依次：
1. `@mention`：`(\s|^|\W)@[0-9a-zA-Z-_\.]+` → `<a href="{Subpath}/username">@username</a>`；
2. `RenderIssueIndexPattern`：默认 `#123`；`metas.style=="alphanumeric"` 时 `ABC-1234`；无 `metas.format` → `<a href="{urlPrefix}/issues/N">…</a>`（urlPrefix 先经 `cutoutVerbosePrefix` 截到第 3+SubpathDepth 个斜杠）；外部追踪器用 `metas.format` 模板 `{user}/{repo}/{index}` 展开；
3. 跨仓引用 `owner/repo#123` → `<a href="{ExternalURL}owner/repo/issues/123">`；
4. `RenderSha1CurrentPattern`：7-40 位 hex 且非纯数字 → `<a href="{metas["repoLink"]}/commit/SHA"><code>ShortSHA1</code></a>`。

### 9.4 Sanitize 策略（bluemonday，sanitizer.go）
基线 `UGCPolicy()`，叠加：`code[class^=language-\w+]`；`input[type=checkbox]` + `checked/disabled`；`data:` URI 仅允许 `image/png|jpeg|gif|webp|x-icon`；外加 `conf.Markdown.CUSTOM_URL_SCHEMES`。

### 9.5 RenderCommitMessage（模板函数）
```ts
function renderCommitMessage(full: boolean, msg: string, urlPrefix: string, metas: Meta): string {
  const clean = htmlEscape(msg);
  let rendered = renderIssueIndexPattern(clean, urlPrefix, metas); // 仅 issue 引用，不做 mention/sha
  const lines = rendered.trim().split("\n");
  if (!lines.length) return "";
  if (!full) return lines[0];
  if (lines.length === 1 || lines[1] === "")
    return lines.length >= 2
      ? `<h3>${lines[0]}</h3>\n<pre>${lines.slice(2).join("\n")}</pre>`
      : `<h3>${lines[0]}</h3>`;
  return `<h4>${lines.join("<br>")}</h4>`;
}
```
metas 由 `Repository.ComposeMetas()` 提供：内置 `repoLink`；外部追踪器时附 `user/repo/format/style`。

### 9.6 相关判定
`IsMarkdownFile`：扩展名 ∈ `conf.Markdown.FileExtensions`；`IsReadmeFile`：小写名以 `readme` 开头；`IsIPythonNotebook`：`.ipynb`；`markup.Detect(filename)` → markdown/orgmode/ipynb/unrecognized。

## 10. 分页 helper（unknwon/paginater）

- Handler：`c.Data["Page"] = paginater.New(total, pagingNum, page, 5)`。各处每页数：explore=20、issue=10、admin user/repo/org=50、notice=25、ui.user repo=15、news feed=20、commits=30。
- 语义（TS 等价）：
```ts
function newPaginater(total: number, pagingNum: number, current: number, numPages: number) {
  pagingNum = pagingNum > 0 ? pagingNum : 1;
  current = current > 0 ? current : 1;
  const totalPages = total === 0 ? 1 : Math.ceil(total / pagingNum);
  if (current > totalPages) current = totalPages;
  return {
    Total: total, PagingNum: pagingNum, Current: current, NumPages: numPages,
    TotalPages: () => totalPages,
    IsFirst: () => current === 1,
    IsLast: () => total === 0 || (total > (current - 1) * pagingNum && total <= current * pagingNum),
    HasPrevious: () => current > 1,   Previous: () => (current > 1 ? current - 1 : current),
    HasNext: () => total > current * pagingNum, Next: () => (total > current * pagingNum ? current + 1 : current),
    Pages: () => pagesWindow(totalPages, current, numPages), // 未展示的页用 {Num:-1} 表示 "..."
  };
}
```
- 窗口算法要点：`totalPages <= numPages` 时列出全部页；否则以 current 为中心取 `numPages` 个页码，越界时窗口贴边；当前页之前/之后仍有未展示页时在两端各插入 `{Num:-1}`。
- 模板：`{{with .Page}}{{if gt .TotalPages 1}}` 才渲染；`{{range .Pages}}` 中 `.Num === -1` 渲染禁用省略号，否则渲染页码（当前页 active 且无链接）。

## 11. TS 平替要点清单（速记）

1. 模板函数 39 个逐一实现（注意命名差异：`Str2HTML`/`ShortSHA1`/`EscapePound`；`Safe`/`Str2HTML` 返回免转义 HTML）。
2. Data 注入分四层：macaron（TmplLoadTimes/Flash）、i18n（i18n/Tr/Lang/LangName/AllLangs/RestLangs + cookie `lang`）、Contexter（登录态/Link/ServerNotice 等）、Repo/Org/路由闭包/handler。
3. Flash 用 `macaron_flash` cookie（url.Values 编码，四键 error/warning/info/success），读完即删。
4. Session cookie `i_like_gogs`，内容 `uid/uname/mfaUserID/…`，默认 memory provider。
5. 无 CSRF。
6. 静态资源按 head/footer 条件表加载；highlight.js 双通道（initHighlightingOnLoad + highlightBlock）。
7. 404/500 行为：404 交给 React SPA；500 渲染 `status/500` 模板（prod 下隐藏错误详情）。
8. 分页组件契约：`Page` + `$.Link?page=N&q=keyword`，`Num==-1` 为省略号。
9. Markdown：blackfriday 管线 + 文本节点特殊链接 + bluemonday UGC 白名单 + `RenderCommitMessage` 的 h3/h4 结构。
