# Gogs Git 层机制契约（TS 平替实现参考）

> 调查对象：gogs-reference 源码。TS 侧用 `child_process` 调 git 二进制复刻以下行为。文中命令参数均原文照抄。

## 1. 仓库磁盘布局

### 1.1 根路径
- `conf.Repository.Root`：`repository.ROOT` 配置项；默认 `filepath.Join(HomeDir(), "gogs-repositories")`，并 `ensureAbs`。
- 用户路径：`repox.UserPath(user) = filepath.Join(conf.Repository.Root, pathx.Clean(strings.ToLower(user)))`（先小写再做路径清洗防穿越）。
- 仓库路径：`RepoPath(userName, repoName) = filepath.Join(UserPath(userName), strings.ToLower(repoName)+".git")`。**即：`{Root}/{owner小写}/{repo小写}.git`，始终为裸仓库目录**。
- wiki 路径：`WikiPath(userName, repoName) = filepath.Join(UserPath(userName), strings.ToLower(repoName)+".wiki.git")`。**wiki 是独立裸仓库，后缀 `.wiki.git`**。Smart HTTP 路由中 `xxx.wiki.git` 会被剥掉 `.git`/`.wiki` 映射回主仓库鉴权。
- 工作副本（网页编辑/wiki 用）：`LocalCopyPath = {AppDataPath}/tmp/local-r/{repoID}`、`LocalWikiPath = {AppDataPath}/tmp/local-wiki/{repoID}`；PR 合并临时目录 `{AppDataPath}/tmp/repos/{unixnano}.git`。
- patch 文件：`PatchPath(index)`（PR 的 `.patch` 存于 base repo 数据目录）。

### 1.2 裸仓库初始化（CreateRepository / initRepository）
1. `git.Init(repoPath, git.InitOptions{Bare: true})` → `git init [--bare] --end-of-options`，在 `path` 目录内执行（无模板钩子参数）。
2. `createDelegateHooks(repoPath)`：覆写三个服务端钩子（pre-receive/update/post-receive），模板（`%s`=ScriptType(bash)，`%s`=gogs 可执行文件路径，`%s`=自定义 conf 路径）：
   - `pre-receive`: `#!/usr/bin/env bash\n"<gogs>" hook --config='<conf>' pre-receive\n`
   - `update`: `#!/usr/bin/env bash\n"<gogs>" hook --config='<conf>' update $1 $2 $3\n`
   - `post-receive`: `#!/usr/bin/env bash\n"<gogs>" hook --config='<conf>' post-receive\n`
3. 设置默认分支：`git symbolic-ref --end-of-options HEAD refs/heads/{conf.Repository.DefaultBranch}`（默认 `master`）。非 AutoInit 时 `repo.IsBare=true`。
4. AutoInit：clone 到临时目录，写入 README/.gitignore/LICENSE 后 `git add --all`、`git commit --author='<Name> <<Email>>' -m "Initial commit"`、`git push`。
5. 最后 `git update-server-info`。
6. TS 平替注意：钩子机制需要等价物（TS 版可直接在 receive-pack 完成后同步调用 push 后处理，或同样写 delegate hook 指向自己的二进制）。

### 1.3 fork
- **本地服务器端 clone，非引用共享**：`git clone --bare <baseRepoPath> <repoPath>`（10 分钟超时），随后 `git update-server-info` + `createDelegateHooks`。DB 记 `IsFork/ForkID`，base `num_forks+1`，并触发 `Fork` webhook。

### 1.4 mirror 同步（internal/database/mirror.go）
- 迁移：`git -c http.followRedirects=false clone --mirror --quiet --end-of-options <url> <path>`（wiki 同理，url 为 `<remote>.wiki.git` 规则推断）；env：`GIT_TERMINAL_PROMPT=0, GIT_ASKPASS=/bin/true, GCM_INTERACTIVE=Never`。地址存于裸仓库 `config` 的 `remote "origin"`；凭证从 URL 剥离显示。
- 周期同步（cron）：`git -c http.followRedirects=false remote update [--prune]`（wiki 仓库同样执行）。同步前用 `git -c http.followRedirects=false ls-remote --quiet --end-of-options <url> HEAD` 快速探活，并做内网地址黑名单复查。
- 从 `git remote update` 的 stderr 解析引用变化 `parseRemoteUpdateOutput`：`" * "` 前缀=新建（old=0000000），`" - "`=删除（new=0000000），`"   "`=更新（`oldsha..newsha`），refName 取 `"-> "` 之后。

## 2. Git Smart HTTP（internal/route/repo/http.go）

### 2.1 认证（HTTPContexter）
- 路径映射：`/:username/:reponame.git/...`，repoName 依次剥掉 `.git`、`.wiki`。
- `isPull`：action==`info/refs` 时看 `service != "git-receive-pack"`；否则 action != `git-receive-pack`。
- **公开仓库拉取免认证**：`isPull && !repo.IsPrivate && !conf.Auth.RequireSigninView`。
- 其余必须 Basic Auth（`WWW-Authenticate: Basic realm="."`）。认证顺序：
  1. `AuthenticateUser(username, password)`（用户名+密码/2FA 关闭时）；
  2. 失败则以 **username 作为 access token** 再试（`AuthenticateByToken(authUsername)`）；
  3. 再以 **password 作为 access token** 试。
  4. 密码认证成功但用户开了 2FA → 401 提示改用 token。
- 授权：`isPull→Read` / `push→Write`，`Permissions.Authorize`；**mirror 仓库 push 一律 403 "Mirror repository is read-only"**。

### 2.2 RPC 转发（直接 spawn git，非 git http-backend）
- 路由表（正则→handler）：`git-upload-pack$`(POST)、`git-receive-pack$`(POST)、`info/refs$`(GET)、`HEAD`、`objects/info/packs`、`objects/[0-9a-f]{2}/[0-9a-f]{38}`、`pack-[0-9a-f]{40}.pack/.idx` 等；请求路径先 `strings.ToLower` 再匹配；`pathx.Clean` 防目录穿越；`conf.Repository.DisableHTTPGit` 时 403。
- `info/refs`：
  - `service` 查询参数必须 `git-upload-pack`/`git-receive-pack`；否则执行 `git update-server-info` 后直接发静态文件（text/plain）。
  - 广播：`git <service> --stateless-rpc --advertise-refs .`（cwd=裸仓库目录），响应 `Content-Type: application/x-git-<service>-advertisement`，body = `pkt-line("# service=git-<service>\n")` + `"0000"` + 子进程输出。pkt-line：`hex(len+4)` 左补零至 4 位。
- RPC：校验请求 `Content-Type == application/x-git-<service>-request`，否则 401；响应 `Content-Type: application/x-git-<service>-result`；请求体支持 `Content-Encoding: gzip`（解压后喂 stdin）。执行：
  - `git upload-pack --stateless-rpc <dir>`
  - `git receive-pack --stateless-rpc <dir>`（**仅 receive-pack 注入 hook 环境变量**，stdout 直写响应）
- no-cache 头：`Expires: Fri, 01 Jan 1980 00:00:00 GMT` / `Pragma: no-cache` / `Cache-Control: no-cache, max-age=0, must-revalidate`；静态对象用 cache-forever 头。

### 2.3 receive-pack 环境变量（ComposeHookEnvs，repo_editor.go）
```
SSH_ORIGINAL_COMMAND=1
GOGS_AUTH_USER_ID=<id>       GOGS_AUTH_USER_NAME=<name>   GOGS_AUTH_USER_EMAIL=<email>
GOGS_REPO_OWNER_NAME=<owner> GOGS_REPO_OWNER_SALT_MD5=<md5(owner.salt)>
GOGS_REPO_ID=<repoID>        GOGS_REPO_NAME=<repoName>
GOGS_REPO_CUSTOM_HOOKS_PATH=<repoPath>/custom_hooks
```

### 2.4 push 后处理链（cmd/gogs/hook.go post-receive + internal/database/update.go）
- 钩子逐行读 stdin `old new ref`：跳过 wiki（路径含 `.wiki.git/`）；调 `database.PushUpdate(options)`；然后 GET `http://<LOCAL_ROOT_URL>/<owner>/<repo>/tasks/trigger?branch=<短ref>&secret=<md5(owner.salt)>&pusher=<userID>`（忽略 TLS 校验）。
- `PushUpdate`：`git update-server-info` → `repo.UpdateSize()`（`git count-objects -v`）→ tag push（`refs/tags/`）走 `Actions.PushTag`；否则取提交：新 ref 用 `CatFileCommit(new)` + `Ancestors(LogOptions{MaxCount: 9})`（共 10 条）；普通 push 用 `CommitsAfter(old)`（= `git rev-list <old>...<new>`）→ `Actions.CommitRepo`（更新 activity 流 + push/create/delete webhook + 提交中 `#123` 关联 issue）。`EmptyID = 40 个 0` 表示新建/删除。

## 3. 浏览页面数据（internal/route/repo/）

### 3.1 Home / 目录树（view.go）
- 空仓库 → `repo/bare`。`CommitsCount = commit.CommitsCount()`（= `git rev-list --count --end-of-options <sha> --`，仅根目录显示）。
- 目录：`Commit.Subtree(treePath)`（逐级 ls-tree）→ `Entries(git.LsTreeOptions{Verbatim: true})` → `git ls-tree -z --end-of-options <treeID>`（NUL 分隔解析 mode/SHA/name；mode 100644/100664=blob、100755=exec、120000=symlink、160000=submodule、040000=tree）→ `entries.Sort()`（目录在前、按名排序）。
- `CommitsInfo`（每项最新提交）：并发 `commit.CommitByPath(CommitByRevisionOptions{Path: <dir>/<name>})`，即 `git log --pretty=format:%H --max-count=1 --end-of-options <rev> -- <path>`，再 `git cat-file commit <sha>` 解析出 Author/Committer/Message；并发度 `conf.Repository.CommitsFetchConcurrency`，超时 5 分钟。
- README：第一个非目录的 `markup.IsReadmeFile` 命中项，Markdown/OrgMode 渲染，ipynb 走 raw 链接。
- `view_list.tmpl` 需要的字段：`Files[]`（`Entry.Name/IsTree/IsSymlink`、`Submodule(.Commit)`、`Commit.ID/Summary/Committer.When`）、`LatestCommit`（`ID`、`Summary`、`Author.Name/When`）、`LatestCommitUser`（`AvatarURLPath/Name`，按 email 匹配站点用户，否则头像 fallback）、`HasParentPath/ParentPath/BranchLink/TreeLink/RepoLink`。
- 单文件视图（renderFile）：`git cat-file` 读 blob（大文件上限 `conf.UI.MaxDisplayFileSize`），按扩展名高亮/markdown/org/ipynb，代码文件逐行生成 `<li class="L%d" rel="L%d">`。

### 3.2 提交历史（commit.go）
- `RefCommits`：treePath 空→Commits；`search`→SearchCommits（`git log --pretty=format:%H --max-count --skip --grep=<kw> --regexp-ignore-case`）；否则 FileHistory（`log -- <path>`）。
- `CommitsByPage(page, size)`：`git log --pretty=<LogFormatHashOnly> --max-count=N --skip=(page-1)*N --end-of-options <rev> -- [path]`，`LogFormatHashOnly = "format:%H"`；每条 SHA 再用 `git cat-file commit <sha>` 解析（author/committer 签名行 `Name <email> <unix> <tz>`，`\n\n` 后为 message；`Summary() = message 首行`）。
- 逐条 commit 关联站点用户：`matchUsersWithCommitEmails`（按 Author.Email 查 users 表）。

### 3.3 diff（gitx/diff.go + git-module）
- 生成：`gitx.RepoDiff(repo, rev, MaxDiffFiles, MaxDiffLines, MaxDiffLineChars, git.DiffOptions{Base: base})`。git-module `Diff` 命令（注意参数顺序）：
  - 有 Base：`git diff --full-index -M <base> --end-of-options <rev>`（超时 `conf.Git.Timeout.Diff` 秒）
  - 无 Base 且有父提交：`git diff --full-index -M <parent0> --end-of-options <rev>`
  - 无 Base 根提交：`git show --full-index --end-of-options <rev>`
- `DiffBinary`（PR patch）：`git diff --full-index --binary --end-of-options <base> <head>`。
- `DiffNameOnly(base, head, {NeedsMergeBase:true})`：`git diff --name-only`，NeedsMergeBase 时先求 merge-base。
- 解析（StreamParseDiff）：按 `"diff --git "` 开头切文件，跳过 `--- `/`+++ ` 行，`@` 开头为 hunk（按 `"@@"` 切分行号），行前缀 `' '`/`'+'`/`'-'`，二进制以 `"Binary"` 开头，识别 `\ No newline at end of file`；受 maxFiles/maxFileLines/maxLineChars 截断。
- 渲染：`DiffSection.ComputedInlineDiffFor` 用 diffmatchpatch（DiffEditCost=100）生成行内 `<span class="added-code">`/`<span class="removed-code">`；非 UTF-8 先探测编码转码。分割/统一视图由 `?style=split` 决定。
- 单提交页路由：`/commit/:sha(7-40hex).patch|.diff` 由 web 新路由处理；`/compare/:before(40hex)...:after(40hex)` → CompareDiff。

### 3.4 blame
- Gogs **web 界面未接入 blame**（route 中无 handler）。

### 3.5 Raw / Archive
- Raw（`/raw/{ref}/{filepath}`）：`resolveRef`（branch→tag）→ `commit.Blob(filepath)` → `blob.Bytes()`；头：非文本非图片 → `Content-Disposition: attachment; filename="..."` + `Content-Transfer-Encoding: binary`；文本且未开 render → `text/plain; charset=utf-8`；`Last-Modified` 取该路径最新提交的 Committer 时间。
- Archive（`/archive/*`）：按后缀 `.zip`→`git.ArchiveZip`、`.tar.gz`→`git.ArchiveTarGz`，缓存到 `<repoPath>/archives/{zip|targz}/<前10位SHA><ext>`；ref 解析顺序 branch→tag→7..40 位 SHA。git-module 命令：`git archive --prefix=<prefix> --format=zip|tar.gz -o <dst> --end-of-options <sha>`。

### 3.6 分支列表（branch.go）
- 来源 `Repository.GetBranches()`（git-module `ShowRef`：输出按空白切分，TrimPrefix `refs/heads/`），每分支取 `GetCommit()`；按 `protect_branch` 表标 `IsProtected`；overview 页按最后提交时间分 active(30 天内)/stale(90 天外)。

## 4. Wiki（internal/database/wiki.go、route/repo/wiki.go）
- 独立裸仓库 `{owner}/{repo}.wiki.git`；分支：`WikiBranch` = 有 `main` 用 `main`，否则 `master`。
- 页面名 = 文件名去 `.md`；slug 规则 `ToWikiPageName`：`url.QueryUnescape` → `pathx.Clean` → **把所有 `/` 替换为空格**（单层扁平）；URL 侧 `ToWikiPageURL = url.QueryEscape(name)`。
- **首页为 `Home.md`**（默认 `pageURL="Home"`）；**没有 `_Sidebar/_Footer` 特殊页面**；页面列表 = wiki 分支树中所有 `.md` blob（`ls-tree -z`）。
- 写操作（本地副本流程）：`InitWiki()`（不存在则 `git init --bare` + delegate hooks）→ `discardLocalWikiChanges`（有分支则 `git reset --hard origin/<branch>`）→ `UpdateLocalWiki`（clone 或 `fetch --prune` + `checkout <branch>` + `reset --hard origin/<branch>`）→ 写 `<title>.md`（新建时已存在报错；改名时删旧文件；先删 symlink 防写入）→ 默认 message：新建/更新 `"Update page '<title>'"`，删除 `"Delete page '<title>'"` → `git add --all` → `git commit`（作者为 doer）→ `git push origin <WikiBranch>`。
- 页面查看：`wikiRepo.Log(refs/heads/<branch>, LogOptions{Path: <page>.md})` 取最后修改者。

## 5. Pull Request（internal/database/pull.go、route/repo/pull.go、gitx/pull_request.go）

### 5.1 compare
- URL 段 `*` 按 `"..."` 切分：`<base ref>...[<head user>:]<head ref>`（同仓库 `master...feature`；跨仓库 `master...user:feature`）。head 用户查 `HasForkedRepo(headUser.ID, baseRepo.ID)`；head git repo = `git.Open(RepoPath(headUser.Name, headRepo.Name))`，base 用 `c.Repo.GitRepo`。
- `gitx.PullRequestMeta(headPath, basePath, headBranch, baseBranch)`：
  - 跨仓库：head repo 临时 remote `strconv.FormatInt(time.Now().UnixNano(), 10)`，`git remote add -f <tmp> <basePath>`（用后 `git remote remove <tmp>`）；远端分支名 `remotes/<tmp>/<baseBranch>`。
  - `git merge-base --end-of-options <base> <head>`（exit 1 → ErrNoMergeBase）；
  - 提交列表：`git log --pretty=format:%H --end-of-options <mergeBase>...<headBranch> --`；
  - 文件数：`DiffNameOnly(base, head, {NeedsMergeBase:true})`。
- diff 展示：head 仓库上 `RepoDiff(headGitRepo, headCommitID, ..., DiffOptions{Base: mergeBase})`；创建 PR 时 patch = `git diff --full-index --binary --end-of-options <mergeBase> <headRef>`，存 `PatchPath(index)`。

### 5.2 merge（PullRequest.Merge，MergeStyle：`create_merge_commit` / `rebase_before_merging`）
1. 临时目录 clone base 仓库并检出 base 分支：`git clone -b <BaseBranch> --end-of-options <baseRepoPath> <tmp>`（5 分钟）。
2. `git remote add head_repo <headRepoPath>`；`git fetch head_repo`。
3. Regular：`git merge --no-ff --no-commit --end-of-options head_repo/<HeadBranch>`，然后
   `git commit --author='<doer> <<email>>' -m "Merge branch '<HeadBranch>' of <HeadUserName>/<HeadRepoName> into <BaseBranch>" -m <commit_description>`
   （**注意：Gogs 原生合并消息没有 `(#index)` 后缀**）。
4. Rebase（需 `PullsAllowRebase`，否则回落 regular）：`git rebase --quiet --end-of-options <BaseBranch> head_repo/<HeadBranch>` → `git checkout -b <unixnano>` → `git checkout --end-of-options <BaseBranch>` → `git merge --end-of-options <tmpBranch>`。
5. `git push <tmp> <BaseBranch>`；随后置 `HasMerged/MergerID/MergedCommitID`，发 MergePullRequest action、PR closed webhook、伪造 push webhook（Ref=`refs/heads/<BaseBranch>`，Before=MergeBase，After=base 分支头）。
6. 合并后 defer：`HookQueue.Add(baseRepo.ID)` + `AddTestPullRequestTask(doer, baseRepo.ID, baseBranch, false)`。

### 5.3 可合并性测试（testPullRequest 机制）
- `PullRequestQueue`（UniqueQueue）；`AddToTaskQueue` 置 `Status=Checking`。`TestPullRequests` goroutine 消费：`testPatch()` 在 **base repo 本地副本**上 `UpdateLocalCopyBranch(BaseBranch)` 后执行 `git apply --check [--ignore-whitespace] <patchPath>`（`--ignore-whitespace` 由 `PullsIgnoreWhitespace`）；失败 → `Status=Conflict`，通过 → `Mergeable`。patch 不存在视为数据损坏直接跳过。
- push/合并后 `AddTestPullRequestTask(repoID, branch, isSync)`：找 `GetUnmergedPullRequestsByHeadInfo`（isSync 时发 `synchronized` webhook）→ 对每条 `UpdatePatch()`（head repo 临时 remote 拉 base、重算 MergeBase 与 binary patch）+ `PushToBaseRepo()`（推到 base 的 `refs/pull/<index>/head`：`git push <tmpRemote> <HeadBranch>:refs/pull/<index>/head`）→ 入测试队列；再找 `GetUnmergedPullRequestsByBaseInfo` 入队。

### 5.4 分支保护（cmd/gogs/hook.go runHookPreReceive，作用于 pre-receive，HTTP 与 SSH 共用）
- 查 `GetProtectBranchOfRepoByName(repoID, branchName)`（branchName 为短名）；`Protected=false` 跳过。
- `EnableWhitelist`：推送者不在白名单 → fail "not in the push whitelist"，且白名单成员**绕过** RequirePullRequest 检查。
- `RequirePullRequest` 且未绕过 → fail "commits must be merged through pull request"。
- 删除受保护分支（new=EmptyID）→ fail。
- 强推检测：`git rev-list --max-count=1 <old> ^<new>` 有输出 → fail "protected from force push"。
- 网页 merge 端：仅 `reqRepoWriter` 可 POST `/pulls/:index/merge`，且必须 `pr.CanAutoMerge() && !HasMerged`。

## 6. 内部 API 与任务触发
- `POST|GET /:username/:reponame/tasks/trigger`（TriggerTask）：query `branch`、`pusher`(userID)、`secret`(=`md5(owner.Salt)`)。校验通过后 `HookQueue.Add(repo.ID)`（投递 webhook）+ `go AddTestPullRequestTask(pusher, repoID, branch, true)`，返回 202。**调用方是 post-receive delegate hook**，不是浏览器。TS 版可用内部 HTTP 或直接函数调用替代。
- `/-/api/sanitize_ipynb`（SanitizeIpynb）：前端把 Jupyter Notebook (`.ipynb`) 的 HTML 交给服务端用 bluemonday 白名单清洗后返回纯文本，防 XSS；纯渲染安全组件。

## 7. git 版本要求与常用命令形态
- 依赖：`github.com/gogs/git-module v1.8.9`（外部库）。
- 启动检查：`exec.LookPath("git")` → `git version`（取第 3 字段）→ `< 1.8.3` 则 Fatal："Gogs requires Git version greater or equal to 1.8.3"。另自动 `git config --global user.name "Gogs"` / `user.email "gogs@fake.local"`（未设置时）。
- 关键 diff 限额配置：`Git.MaxDiffFiles(MAX_GIT_DIFF_FILES)`、`MaxDiffLines(MAX_GIT_DIFF_LINES)`、`MaxDiffLineChars(MAX_GIT_DIFF_LINE_CHARACTERS)`、`DisableDiffHighlight`；超时 `git.timeout`{Migrate/Mirror/Clone/Pull/Diff/GC}（秒）。
- 常用命令清单（TS git 封装需覆盖的最小集，均原文参数）：

| 用途 | 命令 |
|---|---|
| 版本 | `git version` |
| 初始化 | `git init --bare --end-of-options` |
| 设置默认分支 | `git symbolic-ref --end-of-options HEAD refs/heads/<branch>` |
| clone(到本地副本) | `git clone [-b <branch>] --end-of-options <repoPath> <dst>` |
| fork | `git clone --bare <baseRepoPath> <repoPath>` |
| fetch | `git fetch [--prune] --end-of-options` |
| push | `git push --end-of-options <remote> <branch>`（如 `<HeadBranch>:refs/pull/<index>/head`） |
| remote | `git remote add [-f] [--mirror=fetch] --end-of-options <name> <url>` / `git remote remove --end-of-options <name>` |
| reset | `git reset --hard origin/<branch>` |
| checkout | `git checkout [-b <new>] --end-of-options <branch>` |
| add/commit | `git add --all`；`git commit --author='<name> <<email>>' -m <msg> [-m <desc>]` |
| 引用 | `git rev-parse <rev>`（拒绝 `-` 开头）；`git show-ref --verify --end-of-options refs/heads/<b>`；`git update-server-info`；`git count-objects -v` |
| 日志 | `git log --pretty=format:%H --max-count=N --skip=N [--since=RFC3339] [--grep=kw --regexp-ignore-case] --end-of-options <rev> -- [path]` |
| 提交对象 | `git cat-file commit <sha>`；大小 `git cat-file -s <sha>`；`git show --name-status --pretty=format:'' <rev>` |
| 计数/列表 | `git rev-list --count --end-of-options <refspecs...> --`；`git rev-list --end-of-options <refs...> --`（区间 `A...B`） |
| merge-base | `git merge-base --end-of-options <base> <head>` |
| tree | `git ls-tree -z --end-of-options <treeID>`（-z=Verbatim，NUL 分隔） |
| diff | `git diff --full-index -M <base> --end-of-options <rev>`；`git diff --full-index --binary --end-of-options <base> <head>`；`git diff --name-only ...`；`git show --full-index --end-of-options <rev>` |
| archive | `git archive --prefix=<prefix> --format=zip|tar.gz -o <dst> --end-of-options <sha>` |
| blame（未接入 UI） | `git blame -l -s <rev> -- <file>` |
| smart http | `git <upload-pack|receive-pack> --stateless-rpc [--advertise-refs] <dir>` |
| 强推检测 | `git rev-list --max-count=1 <old> ^<new>` |

- 解析约定：log 只取 SHA 再逐个 `cat-file commit`（头字段 `tree/parent/author/committer`，`\n\n` 后为 message，`Summary=首行`）；ls-tree NUL 分隔，mode 定类型；diff 流式按 `diff --git `/`@@`/`--- `/`+++ `/`Binary`/`\ No newline at end of file` 标记切分；mirror 用 `git remote update` stderr 的 ` * `/` - `/`   ` 前缀解析 ref 增删改；`Info/refs` 广播需手写 pkt-line（`hex(len+4)` 4 位补零 + 内容 + `0000`）。

## 8. TS 实现要点速记
1. 磁盘布局必须逐字节对齐 `{Root}/{owner}/{repo}.git` 与 `.wiki.git`，否则与 DB 迁移/既有数据不兼容。
2. push 后处理可二选一：仿 delegate hook（写 pre-receive/update/post-receive 指向自有二进制，靠 env 传用户/仓库上下文），或 receive-pack 结束后进程内同步执行 PushUpdate 逻辑 + tasks/trigger 等价逻辑。
3. 所有用户输入进 git 参数处统一在 `--end-of-options` 之后再拼接（Gogs 全库如此，防参数注入），rev 拒绝 `-` 开头。
4. PR patch（`git diff --binary`）+ `git apply --check` 是可合并性的判定核心；`refs/pull/<index>/head` 由 PushToBaseRepo 手工维护。
5. wiki 只需 `Home.md` 默认页 + `.md` 文件即页面，slug 中 `/`→空格。
