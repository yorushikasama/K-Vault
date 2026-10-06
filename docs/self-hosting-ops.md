# 自托管实例运维笔记

记录 `tg.yorushika.cyou` 这台机器的实际结构。这里写的是**现状**，不是理想方案——
避免下次更新时重新摸一遍，也避免用错方法把线上弄坏。

## 与 Docker 部署的区别

`README-DOCKER.md` 描述的是镜像方案（nginx + Node + SQLite 打包在一个容器里）。
这台机器**不用 Docker**，是裸机 nginx + systemd 直接跑 Node。两者的差异集中在
「静态文件从哪来」这一点上。

## 实际结构

```text
nginx（80/443，www-data）
  ├─ 静态文件：root /opt/k-vault/web
  ├─ /api/、/file/、/upload  → 反代 127.0.0.1:8787
  └─ 找不到的路径 → 回落到 index.html（Content-Type: text/html）

systemd: kvault.service（User=kvault）
  └─ ExecStart=/usr/bin/node index-local.js
     WorkingDirectory=/opt/k-vault/server
     EnvironmentFile=/etc/kvault.env
```

关键点：**`git` 更新的是仓库根目录（`/opt/k-vault`），而 nginx 读的是
`/opt/k-vault/web`。** 两者是独立副本，只 `git pull` 不会改变线上页面。

`/opt/k-vault/server/index-local.js` 是**服务器本地文件，不在仓库里**：
上游 `index.js` 调 `serve({port})` 不带 hostname，会绑所有网卡；这个包装把它
限制在 loopback 上。任何「同步仓库到服务器」的操作都不能删它或覆盖它。

## 更新方式

机器上已装了一个幂等的部署脚本，优先用它：

```bash
sudo kvault-deploy              # 拉代码 → 应用补丁栈 → 重建 web/ → 重启 → 健康检查
sudo kvault-deploy --static-only  # 只重建静态副本，不重启 Node
```

脚本本体在 `/usr/local/share/kvault/kvault-deploy`，流程是 6 步：
`git reset --hard origin/main` → 应用 `patches/*.patch` → 确保 `index-local.js`
存在 → 从 `git ls-files` 重建 `/opt/k-vault/web`（rsync `--delete`）→ 重启并用
`/api/health` 轮询最多 25 秒 → 打印版本与内存占用。

`git reset --hard` 会丢弃工作区改动，`rsync --delete` 会删掉 `web/` 里不在
清单内的文件——这两处都是破坏性的，运行前确认工作区没有要保留的东西。

### 补丁栈

`/usr/local/share/kvault/patches/*.patch`，每个补丁在 `reset --hard` 之后按文件名
顺序重新应用。脚本会检测补丁是否已并入上游：既不能正向也不能反向应用时才算失败。

**当前状态（2026-10-07 核对）**：

```text
/usr/local/share/kvault/
  ├─ kvault-deploy              ← 脚本本体
  ├─ index-local.js             ← index-local.js 的模板
  ├─ telegram-local-botapi.patch  ← 在 patches/ 的**上一层**，不会被自动应用
  └─ patches/                   ← 空目录，没有任何 .patch
```

`patches/` 是空的，所以补丁栈这一步实际不生效。那个 `telegram-local-botapi.patch`
放在上一层，脚本的 glob 匹配不到它。它涉及的 5 个文件（`server/app.js`、
`server/lib/config.js`、`server/lib/storage/adapters/telegram.js`、
`server/lib/storage/factory.js`、`server/lib/repos/storage-config-repo.js`）
在工作区里都已与 `origin/main` 完全一致，即内容已并入上游，不再需要打。
正/反向 `git apply --check` 都失败属于正常现象——文件已被 checkout 成上游版本，
补丁的上下文自然对不上。不要据此判断补丁「坏了」；如果以后真的要重新启用它，
先确认这一点。

### 不用脚本时（curl 不可用环境下的备用路径）

`scripts/deploy-remote.py` 提供 `put` / `run` 两种模式，用 SFTP 上传并远程执行，
密码只从 `KV_SSH_PASSWORD` 读。本次就是这样做的：

```bash
# 1. 从提交导出静态文件（不要从工作区导，工作区可能有未提交改动）
git show HEAD:<file> > staging/<file>

# 2. 上传到服务器临时目录
MSYS_NO_PATHCONV=1 KV_SSH_PASSWORD=... python scripts/deploy-remote.py put staging /tmp/kvault-web-new

# 3. 备份 → 清理废弃文件 → 复制到位 → 修属主
```

注意两点：Windows 的 Git Bash 会把 `/tmp/...` 改写成 `C:\Users\...\Temp\...`，
所以调用前要加 `MSYS_NO_PATHCONV=1`；`/opt/k-vault/web` 与 `server/` 属主虽
是 `kvault` 但当前用户 `wbadmin` 没有写权限，需要 `sudo`。

## 改完之后必须验证的事

`curl` 看 HTTP 200 是不够的——登录保护会把所有页面重定向到 `/login.html?redirect=...`，
未登录时每个页面都返回登录页的 200。要看到真实页面必须带会话：

```bash
# 取会话 cookie
PW=$(sudo grep '^BASIC_PASS=' /etc/kvault.env | cut -d= -f2-)
curl -s -X POST http://127.0.0.1:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  --data "{\"username\":\"admin\",\"password\":\"$PW\"}" -c /tmp/kvault-cookies.txt

# 带 cookie 取真实页面，核对标题与体积
curl -s -b /tmp/kvault-cookies.txt https://tg.yorushika.cyou/admin.html | grep -o '<title>[^<]*</title>'
```

判据建议用「文件体积 + 标题」而不是状态码：`index.html` 156,881 字节、
`admin.html` 194,782 字节这一级别是当前构建的正常值。

`/opt/k-vault/web` 的全部文件应与 `git show HEAD:<file>` 逐字节一致，可用 md5 比对。
比对二进制（`logo.png`、`favicon.ico`）时要用 `git show HEAD:f > f.bin` 落成文件再算，
直接管道给 `md5sum` 会被行尾转换改掉哈希。

## 已知问题

- **`admin-imgtc.html` 的 `updateStats` 有崩溃风险**：`Object.keys(this.fileConfig).find(t => this.fileConfig[t].exts...)`
  在 `fileConfig` 出现没有 `exts` 的键时会抛 `TypeError: Cannot read properties of undefined (reading 'exts')`。
  目前 4 个键（image/video/audio/document）都有 `exts`，所以只在特定数据下才触发，
  线上观察到过一次间歇性报错。这个问题在 `438a9d6` 之前就存在。

- **`git fetch` 会报 `cannot open '.git/FETCH_HEAD': Permission denied`**：
  `.git` 下部分文件属主是 root。用 `sudo kvault-deploy` 或
  `sudo git -c safe.directory=/opt/k-vault -C /opt/k-vault ...` 绕过。
