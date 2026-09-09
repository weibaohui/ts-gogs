# Gogs 数据库完整 Schema（SQLite 建表契约）

> 源码基线：gogs main 分支（v0.13+）。来源：`internal/database/` 各模型文件的 `xorm`/`gorm` tag、`internal/database/models.go:legacyTables`、`internal/database/database.go:Tables`、`internal/database/migrations/`、官方生成文档 `docs/dev/database_schema.md`。

## 0. 总览与建表机制

共 **37 张表**，分三类建表路径：

| 路径 | 机制 | 表 |
|---|---|---|
| xorm 遗留表（28 张） | `x.Sync2(legacyTables...)`，按 `xorm` tag | user, public_key, two_factor, two_factor_recovery_code, repository, deploy_key, collaboration, upload, watch, star, issue, pull_request, comment, attachment, issue_user, label, issue_label, milestone, mirror, release, webhook, hook_task, protect_branch, protect_branch_whitelist, team, org_user, team_user, team_repo |
| GORM 新表（8 张） | GORM AutoMigrate，`NamingStrategy{SingularTable:true}` | access, access_token, action, email_address, follow, lfs_object, login_source, notice |
| 版本表 | migrations.Migrate | version |

注意：`Organization` 只是 `type Organization = User` 别名 + `TableName() "user"`，**没有独立 org 表**。

### 0.1 SQLite 类型映射
xorm v0.8.0 sqlite3 方言：`int*`→INTEGER、`bool`→INTEGER（DEFAULT true/false 改写 1/0）、`string`/`VARCHAR(n)`→TEXT、`xorm:"TEXT"`→TEXT。主键 `id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL`。索引命名：`INDEX` → `IDX_<表>_<列>`；`UNIQUE(name)` → `UQE_<表>_<name>`；单列 `UNIQUE` → `UQE_<表>_<列>`。无 NOT NULL 的列一律允许 NULL。全库无外键。
GORM（glebarez/sqlite）：`int64`→INTEGER、`bool`→NUMERIC(0/1)、`string`→TEXT、`time.Time`→DATETIME。

### 0.3 时间字段存储格式（重要）
- 遗留表：所有 `time.Time` 字段 tag 为 `xorm:"-"` **不落库**；落库列是对应 `*Unix int64` **Unix 秒**，由 BeforeInsert/BeforeUpdate 钩子写。
- 例外：`hook_task.delivered` 为 **UnixNano 纳秒**。
- GORM 表：`created_unix/updated_unix` Unix 秒；仅 `lfs_object.created_at` 是 DATETIME，TEXT `"2006-01-02 15:04:05.999999999-07:00"`（UTC 截断微秒）。

### 0.4 JSON 序列化列（TEXT 存 JSON 字符串）
| 表.列 | 内容 |
|---|---|
| `login_source.cfg` | 认证源 Provider 配置 JSON |
| `webhook.events` | HookEvent JSON（`{"push_only","send_everything","choose_events","events":{create,delete,fork,push,issues,pull_request,issue_comment,release}}` bool 组） |
| `webhook.meta` | 各 hook 类型私有配置 JSON（slack channel/username、discord、dingtalk 等） |
| `hook_task.payload_content` | webhook payload JSON |
| `hook_task.request_content` | `{"headers":{...}}` |
| `hook_task.response_content` | `{"status":int,"headers":{...},"body":"..."}` |
| `action.content` | op_type 5/20/21/22 推送类存 PushCommits/MirrorSyncPush JSON；6/7/10/12/13 等 issue 类存纯文本；其余空 |
| `protect_branch.whitelist_user_ids` / `whitelist_team_ids` | `[]int64` JSON 数组 |

## 1. user（个人 + 组织共用表，xorm）

| 列 | Go 字段 | SQLite 类型 | 约束/说明 |
|---|---|---|---|
| id | ID int64 | INTEGER | PRIMARY KEY AUTOINCREMENT |
| lower_name | LowerName | TEXT | UNIQUE (UQE_user_lower_name) |
| name | Name | TEXT | UNIQUE (UQE_user_name) |
| full_name | FullName | TEXT | |
| email | Email | TEXT | 主邮箱 |
| passwd | Password（列名 passwd） | TEXT | |
| login_source | LoginSource int64 | INTEGER | 默认 0 |
| login_name | LoginName | TEXT | |
| type | Type int | INTEGER | 0=个人 1=组织 |
| location | Location | TEXT | |
| website | Website | TEXT | |
| rands | Rands | TEXT | |
| salt | Salt | TEXT | |
| created_unix | CreatedUnix int64 | INTEGER | Unix 秒 |
| updated_unix | UpdatedUnix int64 | INTEGER | Unix 秒 |
| last_repo_visibility | LastRepoVisibility bool | INTEGER | |
| max_repo_creation | MaxRepoCreation int | INTEGER | 默认 -1（=全局默认） |
| is_active | IsActive bool | INTEGER | |
| is_admin | IsAdmin bool | INTEGER | |
| allow_git_hook | AllowGitHook bool | INTEGER | |
| allow_import_local | AllowImportLocal bool | INTEGER | |
| prohibit_login | ProhibitLogin bool | INTEGER | |
| avatar | Avatar | TEXT | |
| avatar_email | AvatarEmail | TEXT | |
| use_custom_avatar | UseCustomAvatar bool | INTEGER | |
| num_followers | NumFollowers int | INTEGER | |
| num_following | NumFollowing int | INTEGER | 默认 0 |
| num_stars | NumStars int | INTEGER | |
| num_repos | NumRepos int | INTEGER | |
| description | Description | TEXT | 组织用 |
| num_teams | NumTeams int | INTEGER | 组织用 |
| num_members | NumMembers int | INTEGER | 组织用 |

## 2. email_address（GORM）
| id INTEGER PK autoincr | uid INTEGER（UserID，INDEX idx_email_address_user_id） | email TEXT（复合唯一 (uid,email)） | is_activated NUMERIC 默认 FALSE |

## 3. follow（GORM）
| id PK | user_id | follow_id | 复合唯一 (user_id,follow_id) |

## 4. access（GORM，单数表名）
| id PK | user_id | repo_id | mode INTEGER | 复合唯一 (user_id,repo_id) |

## 5. access_token（GORM）
| id PK | uid INTEGER（INDEX idx_access_token_user_id） | name TEXT | sha1 VARCHAR(40) UNIQUE | sha256 VARCHAR(64) UNIQUE | created_unix | updated_unix |

## 6. action（GORM）
| id PK | user_id（INDEX idx_action_user_id，接收者） | op_type int（1..22） | act_user_id | act_user_name TEXT | repo_id（INDEX idx_action_repo_id） | repo_user_name | repo_name | ref_name | is_private NUMERIC 默认 FALSE | content TEXT（JSON/文本） | created_unix |

## 7. lfs_object（GORM，复合主键）
| repo_id PK部分 | oid TEXT PK部分 | size INTEGER | storage TEXT（"local"） | created_at DATETIME（TEXT 格式） |

## 8. login_source（GORM）
| id PK | type int（0=None 1=Plain 2=LDAP 3=SMTP 4=PAM 5=DLDAP 6=GitHub 999=Mock） | name TEXT UNIQUE | is_actived NUMERIC | is_default NUMERIC | cfg TEXT（JSON） | created_unix | updated_unix |

## 9. notice（GORM）
| id PK | type int（1=仓库删除通知，唯一取值） | description TEXT | created_unix |

## 10. version（GORM）
| id PK（恒 1 单行） | version INTEGER（当前=22；minDBVersion=19+3 迁移） |

## 11. public_key（xorm，SSH 公钥；用户与部署密钥共用）
| id PK autoincr | owner_id（IDX_public_key_owner_id） | name | fingerprint | content | mode INTEGER 默认 2 | type INTEGER 默认 1（1=用户 2=部署） | created_unix | updated_unix |

## 12. deploy_key（xorm）
| id PK | key_id（UNIQUE(s)=(key_id,repo_id)；指向 public_key.id） | repo_id（同上唯一，IDX） | name | fingerprint | created_unix | updated_unix |

## 13. collaboration（xorm，单数表名）
| id PK | user_id（UNIQUE(s)=(user_id,repo_id)，IDX） | repo_id（同上，IDX） | mode INTEGER 默认 2 |

## 14. upload（xorm）
| id PK | uuid UNIQUE | name |

## 15. watch（xorm）
| id PK | user_id（UNIQUE(watch)=(user_id,repo_id)） | repo_id（同上） |

## 16. star（xorm）
| id PK | uid（UNIQUE(s)=(uid,repo_id)） | repo_id（同上） |

## 17. repository（xorm）
| 列 | Go 字段 | 约束/说明 |
|---|---|---|
| id | ID | PK autoincr |
| owner_id | OwnerID | UNIQUE(s)=(owner_id,lower_name) |
| lower_name | LowerName | 同上唯一；IDX_repository_lower_name |
| name | Name | IDX_repository_name |
| description | Description | |
| website | Website | |
| default_branch | DefaultBranch | |
| size | Size int64 | 默认 0 |
| use_custom_avatar | UseCustomAvatar bool | |
| num_watches / num_stars / num_forks / num_issues / num_closed_issues / num_pulls / num_closed_pulls | int | |
| num_milestones / num_closed_milestones | int | 默认 0 |
| is_private | IsPrivate bool | |
| is_unlisted | IsUnlisted bool | 默认 0 |
| is_bare | IsBare bool | |
| is_mirror | IsMirror bool | |
| enable_wiki | bool | 默认 1 |
| allow_public_wiki | bool | |
| enable_external_wiki | bool | |
| external_wiki_url | TEXT | |
| enable_issues | bool | 默认 1 |
| allow_public_issues | bool | |
| enable_external_tracker | bool | |
| external_tracker_url / external_tracker_format / external_tracker_style | TEXT | |
| enable_pulls | bool | 默认 1 |
| pulls_ignore_whitespace | bool | 默认 0 |
| pulls_allow_rebase | bool | 默认 0 |
| is_fork | bool | 默认 0 |
| fork_id | int64 | |
| created_unix / updated_unix | int64 | Unix 秒 |

## 18. issue（xorm；is_pull 区分 issue/PR）
| id PK | repo_id（IDX；UNIQUE(repo_index)=(repo_id,index)） | index（仓库内序号，同上唯一） | poster_id | name TEXT（Title 列名为 name） | content | milestone_id | priority | assignee_id | is_closed | is_pull（false=issue true=PR） | num_comments | deadline_unix | created_unix | updated_unix |

## 19. issue_user（xorm）
| id PK | uid（IDX_issue_user_uid） | issue_id | repo_id（IDX） | milestone_id | is_read | is_assigned | is_mentioned | is_poster | is_closed |

## 20. pull_request（xorm）
| id PK | type int（0=gogs 1=git） | status int（0=conflict 1=checking 2=mergeable） | issue_id（IDX_pull_request_issue_id） | index | head_repo_id | base_repo_id | head_user_name | head_branch | base_branch | merge_base VARCHAR(40) | has_merged | merged_commit_id | merger_id | merged_unix |

## 21. comment（xorm）
| id PK | type int（0..6） | poster_id | issue_id（IDX_comment_issue_id） | commit_id int64（历史遗留） | line int64 | content | created_unix | updated_unix | commit_sha VARCHAR(40) |

## 22. attachment（xorm）
| id PK | uuid UNIQUE | issue_id（IDX） | comment_id | release_id（IDX） | name | created_unix |

## 23. label（xorm）
| id PK | repo_id（IDX_label_repo_id） | name | color VARCHAR(7)（#RRGGBB） | num_issues | num_closed_issues |

## 24. issue_label（xorm）
| id PK | issue_id（UNIQUE(s)=(issue_id,label_id)） | label_id（同上） |

## 25. milestone（xorm）
| id PK | repo_id（IDX_milestone_repo_id） | name | content | is_closed | num_issues | num_closed_issues | completeness int（1-100） | deadline_unix（0=无期限） | closed_date_unix |

## 26. release（xorm）
| id PK | repo_id | publisher_id | tag_name | lower_tag_name | target | title | sha1 VARCHAR(40) | num_commits int64 | note | is_draft 默认 0 | is_prerelease | created_unix |

## 27. mirror（xorm）
| id PK | repo_id | interval int（小时） | enable_prune 默认 1 | updated_unix（LastSyncUnix） | next_update_unix（NextSyncUnix） |

## 28. webhook（xorm）
| id PK | repo_id | org_id | url | content_type int（1=JSON 2=FORM） | secret | events TEXT（JSON） | is_ssl | is_active | hook_task_type int（1=gogs 2=slack 3=discord 4=dingtalk） | meta TEXT（JSON） | last_status int（0=none 1=succeed 2=failed） | created_unix | updated_unix |

## 29. hook_task（xorm）
| id PK | repo_id（IDX_hook_task_repo_id） | hook_id | uuid | type int | url | signature（HMAC） | payload_content（JSON） | content_type int | event_type TEXT（create/delete/fork/push/issues/pull_request/issue_comment/release） | is_ssl | is_delivered | delivered **UnixNano 纳秒** | is_succeed | request_content（JSON） | response_content（JSON） |

## 30. protect_branch（xorm）
| id PK | repo_id（UNIQUE(protect_branch)=(repo_id,name)） | name（同上唯一） | protected | require_pull_request | enable_whitelist | whitelist_user_ids TEXT（JSON []int64） | whitelist_team_ids TEXT（JSON []int64） |

## 31. protect_branch_whitelist（xorm）
| id PK | protect_branch_id | repo_id（UNIQUE(protect_branch_whitelist)=(repo_id,name,user_id)） | name（同上） | user_id（同上） |

## 32. team（xorm）
| id PK | org_id（IDX_team_org_id） | lower_name | name | description | authorize int（1=read 2=write 3=admin） | num_repos | num_members |

## 33. org_user（xorm）
| id PK | uid（IDX_org_user_uid；UNIQUE(s)=(uid,org_id)） | org_id（IDX_org_user_org_id；同上唯一） | is_public | is_owner | num_teams |

## 34. team_user（xorm）
| id PK | org_id（IDX_team_user_org_id） | team_id（UNIQUE(s)=(team_id,uid)） | uid（同上唯一） |

## 35. team_repo（xorm）
| id PK | org_id（IDX_team_repo_org_id） | team_id（UNIQUE(s)=(team_id,repo_id)） | repo_id（同上唯一） |

## 36. two_factor（xorm）
| id PK | user_id UNIQUE | secret TEXT（TOTP 密钥密文） | created_unix |

## 37. two_factor_recovery_code（xorm）
| id PK | user_id | code VARCHAR(11) | is_used |

---

## 附录 A. 枚举字段全部取值

| 字段 | 取值 |
|---|---|
| user.type | 0=个人 1=组织 |
| access.mode / collaboration.mode / public_key.mode / team.authorize | 0=none 1=read 2=write 3=admin 4=owner（team.authorize 实际只用 1/2/3） |
| comment.type | 0=普通评论 1=Reopen 2=Close 3=IssueRef 4=CommitRef 5=CommentRef 6=PullRef |
| comment 非持久化 ShowTag | 0=None 1=Poster 2=Writer 3=Owner |
| public_key.type | 1=用户 2=部署 |
| pull_request.type | 0=Gogs 1=Git |
| pull_request.status | 0=Conflict 1=Checking 2=Mergeable |
| action.op_type | 1=CreateRepo 2=RenameRepo 3=StarRepo 4=WatchRepo 5=CommitRepo 6=CreateIssue 7=CreatePullRequest 8=TransferRepo 9=PushTag 10=CommentIssue 11=MergePullRequest 12=CloseIssue 13=ReopenIssue 14=ClosePullRequest 15=ReopenPullRequest 16=CreateBranch 17=DeleteBranch 18=DeleteTag 19=ForkRepo 20=MirrorSyncPush 21=MirrorSyncCreate 22=MirrorSyncDelete |
| webhook.content_type / hook_task.content_type | 1=JSON 2=FORM |
| webhook.hook_task_type / hook_task.type | 1=GOGS 2=SLACK 3=DISCORD 4=DINGTALK |
| webhook.last_status | 0=None 1=Succeed 2=Failed |
| login_source.type | 0=None 1=Plain 2=LDAP 3=SMTP 4=PAM 5=DLDAP 6=GitHub 999=Mock |
| notice.type | 1=仓库删除通知 |
| version.version | 当前=22（19+3 迁移） |

## 附录 C. TS（SQLite）实现要点
1. 遗留表可空列极多，TS 读取按零值处理（gogs 依赖 AfterFind 把 `*Unix` 转回 time.Time，空=0）。
2. 时间统一：除 `hook_task.delivered`（纳秒）与 `lfs_object.created_at`（TEXT datetime）外，其余全部 INTEGER Unix 秒。
3. `VARCHAR(n)` 落库为 TEXT，长度仅在应用层校验。
4. 布尔存 0/1。
5. 复合唯一约束必须建（无 FK 兜底）。
6. JSON 列读取时 JSON.parse。
7. `user` 表同时服务个人与组织（type 区分）。
