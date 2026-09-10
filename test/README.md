# ts-gogs 测试套件

对运行中的 ts-gogs 服务做端到端全量验证的三个套件，统一由 `run-all.sh` 编排。

| 套件 | 覆盖 | 用例数 |
|---|---|---|
| `api-test.mjs` | API v1 全部端点组：用户/仓库 CRUD、contents/raw/git 数据、协作者、部署密钥、标签、里程碑、工单(增删改查/标签/评论)、webhook CRUD、用户密钥/邮箱/关注、token、组织与团队、markdown、认证失败路径、删除清理 | 107 |
| `git-test.mjs` | HTTP 智能协议（克隆/推拉/分支标签/二进制哈希往返/浅克隆/匿名与错密码拒绝/非快进拒绝+force）、**分支操作专项**（斜杠/点号命名分支、web 删分支、默认分支切换、跨分支建 PR 并合并、compare 页）、SSH authorized_keys 模式、LFS batch API 上传下载、webhook 真实投递（本地监听收 push 事件） | 69 |
| `scenario-dev.mjs` | **开发场景全流程演练**：组织/账号/仓库初始化 → 团队授权 → CI webhook → 功能分支开发 → issue 协作 → PR 评审合并 → 删分支 → tag + 网页发 Release → 归档下载 → star/explore/blame → 关 issue → SSH 推送 | 44 |
| `ui-test.mjs` | 真浏览器（系统 Chrome）：登录/注册（含验证码解码）、网页建仓、文件浏览、工单/评论/关闭、标签/里程碑、wiki、watch/star、explore、设置×9、管理后台×8、控制台零错误体检 | 54 |

## 运行

```bash
# 前置：构建并启动服务（测试打真实 HTTP/git/SSH 接口）
npm run build
node dist/index.js            # 0.0.0.0:3000

# 一键全量
npm test                      # = bash test/run-all.sh

# 单套件
npm run test:api
npm run test:git
npm run test:ui
```

环境变量（均有默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `GOGS_URL` | `http://127.0.0.1:3000` | 被测服务地址 |
| `ADMIN_USER` / `ADMIN_PASS` | `root` / `admin123` | 管理员账号（api/git 套件用 basic 铸 token） |
| `SSH_PORT` | `22` | git 套件的 SSH 测试端口（authorized_keys 模式需系统 sshd 开启） |
| `CHROME_PATH` | macOS Chrome 标准路径 | ui 套件使用的浏览器可执行文件 |

## 设计约定

- **认证策略对齐上游 wrapper**：`POST /users/:u/tokens` 走 basic（reqBasicAuth）；`/user/*`、`/users/:u/keys|repos|following|followers` 及仓库写操作走 token（reqToken）；`/admin/*` 接受 basic（reqAdmin）；仓库读接口公开。
- **用例自备数据**：每套件用时间戳+随机后缀创建自己的用户/仓库，结束自行清理（仅 UI 套件创建的组织因上游无组织删除 API 而残留）。
- **git 测试真实走协议**：clone/push 用 `git` 命令行（HTTP 与 ssh:// 双通道），LFS 直接打 batch API（不依赖 git-lfs 客户端），webhook 由脚本内起的 HTTP 监听接收。
- **UI 测试用 playwright-core 驱动系统 Chrome**，不用 headless shell；SPA 登录/登出要操作浏览器 cookie（`ctx.clearCookies()` 才是确定性登出）；注册验证码直接从服务端 SVG 的 `<text>` 节点解码。
- 每个用例输出 `ok/FAIL` 行，套件结束打印汇总，失败以非零码退出（CI 友好）。UI 截图落在 `test-artifacts/ui/`（已 gitignore）。
