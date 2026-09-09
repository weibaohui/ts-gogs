# Gogs API v1 契约文档（供 TypeScript 平替实现）

> 来源：`internal/route/api/v1/api.go RegisterRoutes`，路由挂载于 `/api/v1`。常量：`database.ItemsPerPage = 40`，`conf.API.MaxResponseItems = 50`，`conf.UI.IssuePagingNum = 10`。

## 0. 通用约定

### 0.1 认证（internal/context/auth.go）
- **Token 认证**：请求头 `Authorization: token <sha1>`（仅对 `/api/v1` 路径生效）。成功后 `IsTokenAuth=true`。
- **Basic 认证**：`Authorization: Basic base64(user:pass)`，验证用户名密码，`IsBasicAuth=true`。
- **会话认证**：cookie session 中的 uid 也可登录（`IsLogged=true` 但两个标志均为 false）。
- 中间件守卫失败时的响应（**空 body**，仅状态码）：
  - `reqToken()`：非 token 认证 → 401 空 body
  - `reqBasicAuth()`：非 basic 认证 → 401 空 body
  - `reqAdmin()`：未登录或非管理员 → 403 空 body
  - `reqRepoWriter()/reqRepoAdmin()/reqRepoOwner()`：权限不足 → 403 空 body
  - `repoAssignment()`：无读权限或仓库不存在 → 404 空 body；token 认证且是 site admin 时按 owner 权限处理

### 0.2 响应辅助函数（internal/context/api.go）
| 方法 | 状态码 | Body |
|---|---|---|
| `c.JSONSuccess(data)` | 200 | `data` 的 JSON |
| `c.JSON(status, data)` | 指定 | JSON |
| `c.NoContent()` | 204 | 空 |
| `c.NotFound()` | 404 | 空 |
| `c.ErrorStatus(status, err)` | 指定 | `{"message": "<err.Error()>", "url": "https://github.com/gogs/docs-api"}` |
| `c.Error(err, msg)` / `c.Errorf` | 500 | `{"message": "Something went wrong, please check the server logs for more information.", "url": "https://github.com/gogs/docs-api"}` |
| `c.NotFoundOrError(err,msg)` | NotFound 错误→404 空；否则同 Error→500 | |
| `c.PlainText(200, sha)` | 200 | 纯文本 |
| `c.SetLinkHeader(total, pageSize)` | — | 设置 `Link` 响应头，格式 `<url?page=N>; rel="next"` / `rel="last"` / `rel="first"` / `rel="prev"`（paginater 计算，page 参数取查询串 `page`）|

特例：`searchUsers`/`searchRepos` 内部错误返回 `500 {"ok": false, "error": "<err>"}`（非标准形状）。

### 0.3 请求体校验错误（go-macaron/binding v1.2.0）
`binding.Bind` 校验失败时：反序列化失败→400、Content-Type 错误→415、普通校验失败→422，body 为错误对象数组：
```json
[{"fieldNames":["name"],"classification":"RequiredError","message":"Required"}]
```
classification 取值：`RequiredError`、`AlphaDashError`、`AlphaDashDotError`、`SizeError`、`MinSizeError`、`MaxSizeError`、`RangeError`、`EmailError`、`UrlError`、`IncludeError`、`ContentTypeError`、`DeserializationError` 等。

### 0.4 认证要求标记说明
`reqToken` / `reqBasicAuth` / `reqAdmin` / `repoAssignment` / `reqRepoWriter` / `reqRepoAdmin` / `reqRepoOwner` / `orgAssignment` / 无。整个 `/repos/:username/:reponame` 子树（除 search、getRepo、releases 所在组）外层还有全局 `reqToken`。

---

## 1. 杂项 Miscellaneous

### POST /api/v1/markdown
- 认证：无。请求体 `markdownRequest`（**无 json tag**，字段按 Go 字段名，JSON 反序列化大小写不敏感）：Text string 否（空则返回空串）、Context string 否。
- 成功：200，**非 JSON**，直接写出渲染后的 HTML 字节（`markup.Markdown`）。

### POST /api/v1/markdown/raw
- 认证：无。请求体：原始文本 body。成功：200，返回 sanitize 后的 HTML 字节。

### OPTIONS /api/v1/*
- 200 空响应（CORS 预检占位）。

---

## 2. 用户 Users

### GET /api/v1/users/search
- 认证：无。查询参数：`q`（关键字）、`limit`（默认 10）。
- 成功：200 `{"ok": true, "data": [User]}`；未登录时每个 User 的 `email` 置空。
- 错误：500 `{"ok": false, "error": "..."}`。

### GET /api/v1/users/:username
- 认证：无（可选登录）。成功：200 `User`；未登录时 `email` 为空串。用户不存在 → 404 空。

### GET /api/v1/users/:username/tokens
- 认证：`reqBasicAuth`。成功：200 `[UserAccessToken]`。错误：500 `{message,url}`。

### POST /api/v1/users/:username/tokens
- 认证：`reqBasicAuth`。请求体：`name` string 是（`binding:"Required"` json tag）。
- 成功：201 `UserAccessToken`（`sha1` 即完整 token 值）。
- 错误：同名 token 已存在 → 422 `{message,url}`；其他 500。

### GET /api/v1/users/:username/keys（reqToken）
- 成功：200 `[UserPublicKey]`；`url` = `{ExternalURL}api/v1/user/keys/{id}`。

### GET /api/v1/users/:username/followers（reqToken）
- 查询参数：`page`；每页固定 `database.ItemsPerPage = 40`；**无 Link 头**。成功：200 `[User]`。

### GET /api/v1/users/:username/following（reqToken）
- 同上，200 `[User]`。

### GET /api/v1/users/:username/following/:target（reqToken）
- 是关注关系 → 204 空；否 → 404 空；目标用户不存在 → 404/500。

---

## 3. 当前用户 /user（整组 reqToken）

### GET /api/v1/user
- 200 `User`（当前认证用户，含 email）。

### GET /api/v1/user/emails
- 200 `[UserEmail]`。

### POST /api/v1/user/emails
- 请求体：`{ "emails": ["a@b.c", ...] }`（`json:"emails"`，非必填）。
- 空数组 → 422 空 body。邮箱已被占用 → 422 `{"message":"email address has been used: <email>","url":...}`。其他 500。
- 成功：201 `[UserEmail]`（仅含本次添加的，`verified` = `!conf.Auth.RequireEmailConfirmation`）。

### DELETE /api/v1/user/emails
- 请求体同上。删除主邮箱 → 400 `{"message":"cannot delete primary email \"<email>\"","url":...}`。成功：204。

### GET /api/v1/user/followers → 200 `[User]`（page，40/页）
### GET /api/v1/user/following → 200 `[User]`
### GET /api/v1/user/following/:username → 204（已关注）/ 404
### PUT /api/v1/user/following/:username → 204（关注）
### DELETE /api/v1/user/following/:username → 204（取关）

### GET /api/v1/user/keys
- 200 `[UserPublicKey]`。

### POST /api/v1/user/keys
- 请求体：`title` string 是（Required）、`key` string 是（Required）。
- 成功：201 `UserPublicKey`。
- 错误（均 `{message,url}`）：422 "Unable to verify key content"/"Invalid key content: %v"；422 "Key content has been used as non-deploy key"/"Key title has been used"；其他 500。

### GET /api/v1/user/keys/:id
- 200 `UserPublicKey`；不存在 → 404。

### DELETE /api/v1/user/keys/:id
- 成功 204；无权访问 → 403 `{"message":"You do not have access to this key.","url":...}`。

### GET /api/v1/user/issues 与 GET /api/v1/issues（两路由同一 handler `listUserIssues`）
- 查询参数：`page`、`state`（`"closed"` → 只查已关闭，其余值均视为 open）。
- 特殊：固定查询 `AssigneeID = 当前用户`；分页大小 `conf.UI.IssuePagingNum = 10`；设置 `Link` 响应头（按 count）。
- 成功：200 `[Issue]`。

---

## 4. 仓库 Repositories

### GET /api/v1/users/:username/repos、GET /api/v1/orgs/:org/repos、GET /api/v1/user/repos（均 reqToken）
- 同一 handler `listReposOfUser`。行为：
  - 目标是组织：返回成员可见仓库（`GetUserRepositories(viewerID, 1, NumRepos)`）。
  - 查询自己：自有仓库（permissions 全 true）+ 协作仓库（按实际 access mode 计算 permissions）。
  - 查询他人：仅公开仓库，permissions 固定 `{admin:true,push:true,pull:true}`。
- 成功：200 `[Repository]`（带 `permissions`）。

### POST /api/v1/user/repos（reqToken）
请求体 `createRepoRequest`：
| JSON 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| name | string | 是 | `Required;AlphaDashDot;MaxSize(100)` |
| description | string | 否 | MaxSize(255) |
| private | bool | 否 | |
| auto_init | bool | 否 | |
| gitignores | string | 否 | |
| license | string | 否 | |
| readme | string | 否 | |

- 成功：201 `Repository`（permissions 全 true）。
- 错误：仓库重名/名称不允许 → 422 `{message,url}`；调用者是组织 → 422 `"Not allowed to create repository for organization."`；其他 500。

### POST /api/v1/org/:org/repos（reqToken）
- 同上请求体。组织不存在 → 404；当前用户非组织 owner → 403 `"Given user is not owner of organization."`；成功 201 `Repository`。

### GET /api/v1/repos/search（无 reqToken）
- 查询参数：`q`（取 `path.Base`）、`uid`（owner 过滤）、`limit`（`toAllowedPageSize`：<=0 → 10，> 50 → 50）、`page`。
- 可见性：已登录且 uid>0 时，查自己或自己拥有的组织 → 包含私有。
- 成功：200 `{"ok": true, "data": [Repository]}`（`permissions` 为 null——`toRepository(repo, nil)`，因 omitempty **字段不出现**）+ `Link` 头。
- 错误：500 `{"ok": false, "error": "..."}`。

### GET /api/v1/repos/:username/:reponame（repoAssignment，无 reqToken）
- 成功：200 `Repository`，`permissions = {admin: c.Repo.IsAdmin(), push: c.Repo.IsWriter(), pull: true}`。
- 注意：handler 内部 `parseOwnerAndRepo`：用户不存在 → 422 `{message,url}`；仓库不存在 → 404。

### GET /api/v1/repos/:username/:reponame/releases（repoAssignment，无 reqToken）
- 成功：200 `[RepositoryRelease]`（无排序保证）。

### POST /api/v1/repos/migrate（reqToken）
请求体 `form.MigrateRepo`（json tag）：
| JSON 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| clone_addr | string | 是 | Required |
| auth_username | string | 否 | |
| auth_password | string | 否 | |
| uid | int64 | 是 | Required（目标 owner ID；≠自己时须为组织或 admin） |
| repo_name | string | 是 | `Required;AlphaDashDot;MaxSize(100)` |
| mirror | bool | 否 | |
| private | bool | 否 |（受 `Repository.ForcePrivate` 强制） |
| unlisted | bool | 否 |（handler 未使用） |
| description | string | 否 | MaxSize(512) |

- 成功：201 `Repository`。
- 错误：uid 不存在 → 422；非组织且非 admin → 403 `"Given user is not an organization."`；非组织 owner → 403；clone 地址非法 → 422；仓库数超限 → 422；迁移失败 → 500。

### DELETE /api/v1/repos/:username/:reponame（reqToken + repoAssignment + reqRepoOwner）
- 组织仓库且非 owner → 403 `"Given user is not owner of organization."`。成功：204。

---

## 5. Webhooks /api/v1/repos/:username/:reponame/hooks（reqToken + repoAssignment + reqRepoAdmin）

### GET `` → 200 `[RepositoryHook]`（`config` 恒含 `url`、`content_type`；slack 类型另含 `channel/username/icon_url/color`）

### POST ``
请求体 `createHookRequest`：
| JSON 字段 | 类型 | 必填 |
|---|---|---|
| type | string | 是（`gogs`/`slack`/`discord`/`dingtalk`） |
| config | map[string]string | 是（必须含 `url`、`content_type`，后者取 `json`/`form`；可含 `secret`；slack 还须 `channel`） |
| events | []string | 否（空 → `["push"]`；合法值：`create`、`delete`、`fork`、`push`、`issues`、`issue_comment`、`pull_request`、`release`） |
| active | bool | 否 |

- 错误（均 422 `{message,url}`）："Invalid hook type."、"Missing config option: url/content_type/channel"、"Invalid content type."；其他 500。
- 成功：201 `RepositoryHook`。

### PATCH /:id
请求体 `editHookRequest`：`config`（map，可选更新 `url`/`content_type`/slack 项）、`events`（[]string，空→`["push"]` 全量重设）、`active`（*bool）。
- 成功：200 `RepositoryHook`；webhook 不存在 → 404。

### DELETE /:id → 204

---

## 6. 协作者 /collaborators（reqToken + repoAssignment + reqRepoAdmin）

### GET `` → 200 `[RepositoryCollaborator]`
### GET /:collaborator
- 用户不存在 → **422 空 body**；是协作者 → 204；否则 404。
### PUT /:collaborator
- 请求体：`{ "permission": "read"|"write"|"admin" }`（*string，可选；其他值→read）。成功 204；用户不存在 422 空。
### DELETE /:collaborator → 204

---

## 7. 文件与 Git 数据（reqToken + repoAssignment）

### GET /api/v1/repos/:u/:r/raw/*（另有 `context.RepoRef()`）
- 成功：原始文件字节流（octet-stream）。bare 仓库或无权限 → 404 空。

### GET /api/v1/repos/:u/:r/contents 与 GET /contents/*
- 查询参数：`ref`（缺省 → `default_branch`）。
- 目标是文件/symlink/submodule → 200 `repoContent` 单对象；是目录 → 200 `[repoContent]`；空目录 → 200 `[]`。
- ref 不存在 / 路径不存在 → 404。

### PUT /api/v1/repos/:u/:r/contents/*（reqToken + repoAssignment + reqRepoWriter）
请求体 `putContentsRequest`：
| JSON 字段 | 类型 | 必填 |
|---|---|---|
| message | string | 是 |
| content | string | 是（base64 编码的文件内容） |
| branch | string | 否（缺省 → default_branch） |

- 成功：201 `{"content": repoContent, "commit": Commit}`。
- content 非 base64 → 500 `{message,url}`；其他错误 500。

### GET /archive/* → 仓库归档下载（二进制流，路径形如 `/archive/REF.zip|.tar.gz`）

### GET /git/trees/:sha
- 成功：200
```json
{ "sha": "<请求的sha>", "url": "<base>/api/v1/repos/<u>/<r>/git/trees/<sha>", "tree": [ {"path":"...","mode":"100644","type":"blob","size":123,"sha":"...","url":"...git/trees/<entrysha>"} ] }
```
  mode 映射：commit→`160000`，tree→`040000`，blob→`120000`，tag→`100644`；`type` 为 git 对象类型字符串。空树时 `tree` 输出为 `null`。

### GET /git/blobs/:sha
- 成功：200 `{"content": "<base64>", "encoding": "base64", "url": "<base>/api/v1/repos/<u>/<r>/git/blobs/<sha>", "sha": "<sha>", "size": 123}`；不存在 → 404。

### GET /forks → 200 `[Repository]`（每个 fork 带 viewer 实际 permissions）
### GET /tags → 200 `[{"name":"v1.0","commit":{WebhookPayloadCommit}}]`
### GET /branches → 200 `[RepositoryBranch]`；GET /branches/*（分支名）→ 200 `RepositoryBranch`；分支不存在 → 404。

### GET /commits
- 查询参数：`pageSize`（默认 30，无上限）。从 HEAD 取 `git log`。成功：200 `[Commit]`。

### GET /commits/:sha
- 若 `Accept` 头含 `application/vnd.gogs.sha` → 转发到 getReferenceSHA（返回纯文本 sha）。
- 成功：200 `Commit`；sha 不存在 → 404。

### GET /commits/*（引用名，可含 `refs/heads/`、`refs/tags/` 前缀）
- 成功：200 **纯文本** SHA（非 JSON）；未知引用 → 404。

### GET /editorconfig/:filename（RepoRef）→ 200 为该文件匹配的 editorconfig 定义 JSON；无定义/无 .editorconfig → 404。

---

## 8. Deploy Keys /keys（reqToken + repoAssignment + reqRepoAdmin）

- GET `` → 200 `[RepositoryDeployKey]`（`url` = `{ExternalURL}api/v1/repos/<owner>/<repo>/keys/<id>`）
- POST ``：请求体 `{ "title": 必填, "key": 必填 }` → 201 `RepositoryDeployKey`；错误同用户公钥
- GET /:id → 200 `RepositoryDeployKey`；key 属于其他仓库 → 404
- DELETE /:id → 204；无权 → 403 `"You do not have access to this key"`

---

## 9. Issues（组前缀 /repos/:u/:r/issues，reqToken + repoAssignment + mustEnableIssues；issues 或 external tracker 未启用 → 404 空）

### GET ``（列出仓库 issue）
- 查询参数：`page`、`state`（`"closed"`→已关闭）。分页 `IssuePagingNum=10`，`Link` 头。成功：200 `[Issue]`。

### POST ``
请求体 `createIssueRequest`：
| JSON 字段 | 类型 | 必填 |
|---|---|---|
| title | string | 是 |
| body | string | 否 |
| assignee | string | 否（仅 writer 生效；不存在 → 422 `{"message":"assignee does not exist: [name: x]","url":...}`） |
| milestone | int64 | 否（仅 writer 生效） |
| labels | []int64 | 否（非 writer 时被清空） |
| closed | bool | 否（true → 创建后立即关闭） |

- 成功：201 `Issue`（从 DB 重新读取）。

### GET /:index → 200 `Issue`；404。
### PATCH /:index
请求体 `editIssueRequest`：
| JSON 字段 | 类型 |
|---|---|
| title | string（非空才更新） |
| body | *string |
| assignee | *string（仅 writer） |
| milestone | *int64（仅 writer） |
| state | *string（`"closed"`/`"open"`） |

- 权限：issue 作者或 repo writer；否则 403 空 body。
- 成功：**201**（注意不是 200）`Issue`。

### GET /issues/comments（仓库级全部评论）
- 查询参数：`since`（RFC3339，解析失败 → 422 `{message,url}`）。200 `[IssueComment]`。

### PATCH /issues/comments/:id
- 请求体 `editIssueCommentRequest`：`{ "body": 必填 }`。权限：评论作者或 repo admin；非评论类型 → 204。成功 200 `IssueComment`；评论不属于本仓库 → 404；无权 → 403 空。

### GET /issues/:index/comments?since → 200 `[IssueComment]`
### POST /issues/:index/comments
- 请求体：`{ "body": 必填 }` → 201 `IssueComment`。

### DELETE /issues/:index/comments/:id → 204（权限同 PATCH）

### GET /issues/:index/labels → 200 `[IssueLabel]`
### POST /issues/:index/labels（reqRepoWriter）
- 请求体 `issueLabelsRequest`：`{ "labels": [1,2] }` → 200 `[IssueLabel]`（**注意源码 bug**：响应用 `issue.Labels[i]` 填充但长度取新查询的 labels，越界风险，实现时应返回 issue 当前的标签）。
### PUT /issues/:index/labels（reqRepoWriter）→ 全量替换 → 200 `[IssueLabel]`（同上 bug）
### DELETE /issues/:index/labels（reqRepoWriter）→ 清空 → 204
### DELETE /issues/:index/labels/:id（reqRepoWriter）
- label 不属于本仓库/不存在 → 422 `{message,url}`；成功 204。

---

## 10. 仓库标签 /labels、里程碑 /milestones（reqToken + repoAssignment）

- GET /labels → 200 `[IssueLabel]`
- GET /labels/:id → 200 `IssueLabel`；`:id` 为数字且 >0 按 ID 查，否则**按名称查**；404。
- POST /labels（reqRepoWriter）：`{ "name": 必填, "color": 必填, Size(7) }` → 201 `IssueLabel`（color 建存时带 `#` 前缀，输出时 `TrimLeft("#")`）
- PATCH /labels/:id（reqRepoWriter）：`{ "name": *string, "color": *string }` → 200 `IssueLabel`
- DELETE /labels/:id（reqRepoWriter）→ 204
- GET /milestones → 200 `[IssueMilestone]`
- GET /milestones/:id → 200 `IssueMilestone`；404
- POST /milestones（reqRepoWriter）：`title` string 否（结构体无 Required！）、`description` string 否、`due_on` *time(RFC3339) 否（缺省 → 9999-12-31，且响应中不输出 due_on）→ 201 `IssueMilestone`
- PATCH /milestones/:id（reqRepoWriter）：`{ "title": string, "description": *string, "state": *string, "due_on": *time }`；`state` 提供时走 ChangeStatus，否则 UpdateMilestone → 200 `IssueMilestone`
- DELETE /milestones/:id（reqRepoWriter）→ 204

### PATCH /repos/:u/:r/issue-tracker（reqRepoAdmin）
- 请求体（均可选指针）：`enable_issues`、`enable_external_tracker`、`external_tracker_url`、`tracker_url_format`、`tracker_issue_style`。成功：204。

### PATCH /repos/:u/:r/wiki（reqRepoAdmin）
- 请求体：`enable_wiki`、`allow_public_wiki`、`enable_external_wiki`（*bool）、`external_wiki_url`（*string）→ 204。

### POST /repos/:u/:r/mirror-sync（reqRepoAdmin）
- 非镜像仓库 → 404 空；成功：**202** 空 body（异步入队）。

---

## 11. 组织 Organizations

### GET /api/v1/user/orgs（reqToken）→ 200 `[Organization]`（含私有成员组织，all=true）
### POST /api/v1/user/orgs（reqToken）
- 请求体 `createOrgRequest`：
| JSON 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| username | string | 是 | `Required;AlphaDashDot;MaxSize(35)` |
| full_name | string | 否 | |
| description | string | 否 | |
| website | string | 否 | |
| location | string | 否 | |
- 成功：201 `Organization`；重名/名称不允许 → 422 `{message,url}`。

### GET /api/v1/users/:username/orgs（**无认证要求**）→ 200 `[Organization]`（all=false，仅含公开成员的组织）

### GET /api/v1/orgs/:orgname（reqToken + orgAssignment）→ 200 `Organization`；组织不存在 → 404
### PATCH /api/v1/orgs/:orgname（reqToken + orgAssignment）
- 请求体 `editOrgRequest`：`full_name`、`description`、`website`、`location`（string，非指针，**总是覆盖**）。
- 非组织 owner → **403 空 body**。成功：200 `Organization`（重查后返回）。
### GET /api/v1/orgs/:orgname/teams（reqToken + orgAssignment）→ 200 `[OrganizationTeam]`

---

## 12. 管理员 Admin（整组 reqAdmin；未满足 → 403 空 body）

### POST /api/v1/admin/users
请求体 `adminCreateUserRequest`：
| JSON 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| source_id | int64 | 否 | 非法 → 422 |
| login_name | string | 否 | |
| username | string | 是 | `Required;AlphaDashDot;MaxSize(35)` |
| full_name | string | 否 | MaxSize(100) |
| email | string | 是 | `Required;Email;MaxSize(254)` |
| password | string | 否 | MaxSize(255) |
| send_notify | bool | 否 | 发送注册通知邮件 |

- 成功：201 `User`（Activated=true）；用户名/邮箱已存在、名称不允许 → 422 `{message,url}`。

### PATCH /api/v1/admin/users/:username
请求体 `adminEditUserRequest`：
| JSON 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| source_id | int64 | 否 | |
| login_name | string | 否 | |
| full_name | string | 否 | MaxSize(100) |
| email | string | 是 | `Required;Email;MaxSize(254)` |
| password | string | 否 | 非空才更新 |
| website | string | 否 | MaxSize(50) |
| location | string | 否 | MaxSize(50) |
| active | *bool | 否 | |
| admin | *bool | 否 | |
| allow_git_hook | *bool | 否 | |
| allow_import_local | *bool | 否 | |
| max_repo_creation | *int | 否 | |

- 成功：200 `User`；邮箱已占用 → 422；用户不存在 → 404。

### DELETE /api/v1/admin/users/:username
- 成功 204；用户拥有仓库/组织 → 422 `{message,url}`。

### POST /admin/users/:username/keys → 同 POST /user/keys，成功 201 `UserPublicKey`
### POST /admin/users/:username/orgs → 同 POST /user/orgs，成功 201 `Organization`
### POST /admin/users/:username/repos → 同 POST /user/repos，成功 201 `Repository`

### POST /admin/orgs/:orgname/teams（orgAssignment(true)）
- 请求体 `adminCreateTeamRequest`：
| JSON 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| name | string | 是 | `Required;AlphaDashDot;MaxSize(30)` |
| description | string | 否 | MaxSize(255) |
| permission | string | 否 | `read`(默认)/`write`/`admin`（ParseAccessMode） |
- 成功：201 `OrganizationTeam`；团队已存在 → 422。

### GET /admin/teams/:teamid/members（orgAssignment(false,true)）→ 200 `[User]`
### PUT /admin/teams/:teamid/members/:username → 204
### DELETE /admin/teams/:teamid/members/:username → 204
### PUT /admin/teams/:teamid/repos/:reponame → 204（团队加仓库；仓库不存在 → 404）
### DELETE /admin/teams/:teamid/repos/:reponame → 204

### 兜底：m.Any("/api/v1/*") → 404 空 body

---

## 13.【API JSON 类型总表】（字段名逐字对应，`internal/route/api/v1/types/`）

**User**（`toUser`：`full_name` 经 HTML sanitize；`email` 在匿名访问 search/profile 时为 ""）
| 字段 | 类型 | 来源 |
|---|---|---|
| id | int64 | u.ID |
| username | string | u.Name |
| login | string | u.Name（与 username 相同） |
| full_name | string | sanitize(u.FullName) |
| email | string | u.Email |
| avatar_url | string | u.AvatarURL()（绝对 URL） |

**UserEmail**：`email` string；`verified` bool（IsActivated）；`primary` bool（IsPrimary）

**UserAccessToken**：`name` string；`sha1` string（即完整 token）

**UserPublicKey**：`id` int64；`key` string（公钥内容）；`url` string（`.../api/v1/user/keys/<id>`，omitempty）；`title` string（omitempty）；`created_at` time（RFC3339，omitempty）

**RepositoryPermission**：`admin` bool；`push` bool；`pull` bool

**Repository**（`toRepository`）
| 字段 | 类型 | 来源 |
|---|---|---|
| id | int64 | repo.ID |
| owner | User | repo.Owner |
| name | string | repo.Name |
| full_name | string | "owner/name" |
| description | string | |
| private | bool | IsPrivate |
| fork | bool | IsFork |
| parent | *Repository（fork 时为上游仓库，permissions={pull:true}） | BaseRepo |
| empty | bool | IsBare |
| mirror | bool | IsMirror |
| size | int64 | repo.Size |
| html_url | string | ExternalURL + full_name |
| ssh_url | string | `ssh://user@host:port/owner/repo.git` 或 `user@host:owner/repo.git`（port=22） |
| clone_url | string | ExternalURL + "owner/repo.git" |
| website | string | |
| stars_count | int | NumStars |
| forks_count | int | NumForks |
| watchers_count | int | NumWatches |
| open_issues_count | int | NumOpenIssues |
| default_branch | string | |
| created_at / updated_at | time | |
| permissions | *RepositoryPermission（omitempty，nil 时整个字段不出现） | |

**RepositoryCollaborator**：内嵌 User 全部字段（无嵌套包装）+ `permissions` RepositoryPermission（按 Collaboration.Mode 计算）

**RepositoryBranch**：`name` string；`commit` WebhookPayloadCommit
**tag**（局部类型，GET /tags 用）：`name` string；`commit` WebhookPayloadCommit

**WebhookPayloadCommit**（branch/tag 的 commit 对象）
| 字段 | 类型 | 来源 |
|---|---|---|
| id | string | commit SHA |
| message | string | 完整 message |
| url | string | **恒为 `"Not implemented"`** |
| author | {name, email, username} | username 按 email 反查用户，查不到为 "" |
| committer | {name, email, username} | 同上 |
| added / removed / modified | []string | 恒为 null（未填充） |
| timestamp | time | Author.When |

**RepositoryRelease**（`toRelease`）：`id` int64；`tag_name` string；`target_commitish` string（r.Target）；`name` string（r.Title）；`body` string（r.Note）；`draft` bool；`prerelease` bool；`author` User（Publisher）；`created_at` time

**RepositoryHook**（`toRepositoryHook`）：`id` int64；`type` string（`gogs`/`slack`/`discord`/`dingtalk`）；`config` map[string]string（恒含 `url`、`content_type`；slack 另含 `channel/username/icon_url/color`）；`events` []string；`active` bool；`updated_at` time；`created_at` time。（内部 repoLink 字段 `json:"-"` 不输出）

**RepositoryDeployKey**（`toDeployKey`）：`id` int64；`key` string；`url` string；`title` string；`created_at` time；`read_only` bool（**恒为 true**）

**Issue**（`toIssue`）
| 字段 | 类型 | 来源 |
|---|---|---|
| id | int64 | issue.ID |
| number | int64 | issue.Index（issue 编号） |
| user | User | Poster |
| title | string | |
| body | string | Content |
| labels | []IssueLabel | |
| milestone | *IssueMilestone（无则为 null） | |
| assignee | *User（无则 null） | |
| state | string `"open"` \| `"closed"` | |
| comments | int | NumComments |
| created_at / updated_at | time | |
| pull_request | *PullRequestMeta（是 PR 时才有） | `{ "merged": bool, "merged_at": time|null }` |

**IssueLabel**（`toIssueLabel`）：`id` int64；`name` string；`color` string（**去 `#` 前缀**，如 `00aabb`）；`url` string（**恒为空串**——源码未赋值）

**IssueMilestone**（`toIssueMilestone`）：`id` int64；`title` string；`description` string；`state` `"open"|"closed"`；`open_issues` int；`closed_issues` int；`closed_at` *time（未关闭为 null）；`due_on` *time（截止年 >=9999 时为 null）

**IssueComment**（`toIssueComment`）：`id` int64；`html_url` string（`{issue html_url}#issuecomment-<id>`）；`user` User；`body` string；`created_at`；`updated_at`

**Organization**（`toOrganization`）：`id` int64；`username` string；`full_name` string；`avatar_url` string；`description` string；`website` string；`location` string

**OrganizationTeam**（`toOrganizationTeam`）：`id` int64；`name` string；`description` string；`permission` string（`read`/`write`/`admin`/`owner`/`none`）

**CommitMeta**：`url` string；`sha` string
**CommitUser**：`name` string；`email` string；`date` string（RFC3339）
**RepoCommit**：`url` string；`author` *CommitUser；`committer` *CommitUser；`message` string（commit.Summary()，首行）；`tree` CommitMeta（sha = commit 自身 sha）
**Commit**（`gitCommitToAPICommit`）：内嵌 CommitMeta（`url` = ExternalURL+当前 API 路径；`sha`）；`html_url` string（`{repo html_url}/commits/{sha}`）；`commit` RepoCommit（其 `url` 同顶层 url）；`author` *User（按 email 反查，null 可出现）；`committer` *User；`parents` []CommitMeta

**PullRequest**（本版 API 路由未使用，仅 webhook）：`id`,`number`,`user`,`title`,`body`,`labels`,`milestone`,`assignee`,`state`,`comments`,`head_branch`,`head_repo`,`base_branch`,`base_repo`,`html_url`,`mergeable`(*bool),`merged`(bool),`merged_at`(*time),`merge_commit_sha`(*string),`merged_by`

**repoContent**（局部类型，GET/PUT contents 用）
| 字段 | 类型 | 说明 |
|---|---|---|
| type | string | `file`/`dir`/`symlink`/`submodule` |
| target | string（omitempty） | symlink 目标 |
| submodule_git_url | string（omitempty） | |
| encoding | string（omitempty） | `base64`（仅 file） |
| size | int64 | |
| name | string | 文件名 |
| path | string | 相对仓库根路径 |
| content | string（omitempty） | base64 内容（仅 file） |
| sha | string | entry blob/tree SHA |
| url | string | `{base}/api/v1/repos/<u>/<r>/contents/<path>` |
| git_url | string | `.../git/blobs/<sha>` 或 `.../git/trees/<sha>` |
| html_url | string | `{base}/<u>/<r>/src/<ref>/<name>` |
| download_url | string | `{base}/<u>/<r>/raw/<ref>/<name>` |
| _links | {`git`,`self`,`html`} string | |

**repoGitTree / repoGitTreeEntry**（GET /git/trees/:sha）：见第 7 节示例；字段 `sha`,`url`,`tree[]`；entry 字段 `path`,`mode`,`type`,`size`,`sha`,`url`
**repoGitBlob**（GET /git/blobs/:sha）：`content`,`encoding`,`url`,`sha`,`size`
**通用错误形状**：`{"message": "...", "url": "https://github.com/gogs/docs-api"}`；`{"ok": true/false, "data"|"error": ...}`（仅 user/repo search）；macaron binding 校验错误为 422 数组 `[{fieldNames, classification, message}]`；其余错误/204/404 均为空 body。

---

**覆盖统计**：`RegisterRoutes` 全部注册项 —— 约 **110 条路由（约 90 个唯一端点）**，含 3 个杂项、13 个 users、13 个 user（authenticated）、10 个仓库基础/搜索/迁移、7 个 hook、4 个 collaborator、8 个 contents/git 文件、4 个 deploy key、16 个 issue/评论/标签、8 个 label/milestone、3 个 repo 设置、6 个 org、12 个 admin。**类型总表覆盖 30 个 JSON 对象类型**。

**实现时需特别注意的坑**（均已在文档标注）：PATCH issue 成功返回 201 而非 200；`IssueLabel.url` 恒为空串；branch/tag 的 `commit.url` 恒为 `"Not implemented"`；deploy key `read_only` 恒为 true；`addIssueLabels` 响应存在源码级 bug；`repoAssignment` 组内 403（reqRepoWriter 等）为空 body 而非 JSON；searchUsers/searchRepos 错误形状特殊；token 认证格式为 `Authorization: token <sha1>`。
