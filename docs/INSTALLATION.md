# 安装与运维

本文面向只拿到公开 Git 仓库的开发者或 AI 安装代理。默认使用远端 Git 完整 commit，不使用本地 `file:` 路径。

## 前置条件

- 已安装并能启动 DSH Web。
- Node.js、pnpm 与 Git 可用。
- 明确指定测试或生产 `DSH_HOME`；仅更换 DSH 源码目录不会隔离 Home。
- 3080 与 8090 端口未被其他 DSH/音乐实例占用。

从 DSH 源码工作区运行时：

```powershell
$env:DSH_HOME = 'E:\path\to\isolated-dsh-home'
pnpm install --frozen-lockfile
pnpm run build
```

POSIX shell 使用 `export DSH_HOME=/path/to/isolated-dsh-home`。

## 固定 revision 安装

已端到端验证的 revision：

```text
e2b172d36ae604190ac9db2326035d59c44681dd
```

先编辑 `$DSH_HOME/profiles/web/pnpm-workspace.yaml`。保留原有配置，并加入：

```yaml
allowBuilds:
  '@oldsan888/dsh-music-mode@git+https://github.com/oldsan888/dsh-music-mode.git#e2b172d36ae604190ac9db2326035d59c44681dd': true
  better-sqlite3: true
  esbuild: true

peerDependencyRules:
  ignoreMissing:
    - '@deepseek-ai/*'
```

这些授权分别允许 Git 包执行 `prepare`、SQLite 原生模块安装和 esbuild 安装。`ignoreMissing` 只告诉独立 profile：`@deepseek-ai/*` peer 由 DSH 宿主提供；它不会安装第二份宿主 API。

执行安装：

```powershell
pnpm dsh plugin --profile web add "git+https://github.com/oldsan888/dsh-music-mode.git#e2b172d36ae604190ac9db2326035d59c44681dd"
```

如果先执行安装再配置，pnpm 会报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 或 `ERR_PNPM_IGNORED_BUILDS`。按其输出补齐上述键后重试即可。若 pnpm 自动写入 `set this to true or false` 占位值，请把占位值替换成 `true`，不要保留重复 YAML 键。

## 安装验收

```powershell
pnpm dsh plugin --profile web list
pnpm --dir "$env:DSH_HOME/profiles/web" peers check
pnpm dsh --profile web --dump-config
```

验收标准：

- 插件列表包含 `@oldsan888/dsh-music-mode@0.2.0`。
- peer 检查无问题。
- dump-config 包含：
  - `music-server-regret-visual`
  - `music-tool-music`
  - `music-ui-music-mode`
- `$DSH_HOME/profiles/web/pnpm-lock.yaml` 的 resolution commit 等于安装 revision。

DSH CLI 可能把 profile `package.json` 中的 dependency 归一化为不带 fragment 的 Git URL，因此 revision 的最终权威证据是 lockfile，不是 manifest。

## 启动与功能验收

```powershell
pnpm dsh --profile web --no-open
```

正常状态：

- DSH 监听 `127.0.0.1:3080`。
- 托管音乐后端作为 DSH 子进程监听 `127.0.0.1:8090`。
- Web 中出现「音乐」视图。
- `$DSH_HOME/dsh-music/data/regret-radio.db` 被创建。

建议依次验证：

1. 打开音乐视图，确认页面可加载。
2. 让 Agent 调用 `music_get_state`。
3. 用明确曲目写入一条 `music_note_write`，再用 `music_notes_read` 读回。
4. 重启 DSH 后再次读取，确认持久化。
5. 检查旧 Home 在测试期间没有文件变化。

播放器未打开时，播放控制返回 `no_player` 是正确行为，不应伪报成功。

## 配置

三个 Loader entry 的可调项：

| entry id | 配置 | 默认值/说明 |
|---|---|---|
| `music-server-regret-visual` | `backendPort` | `8090` |
|  | `stageRoot` / `backendRoot` | 通常不应覆盖 |
|  | `hostBackend` | `true`，由 DSH 托管后端 |
|  | `allowRemote` | `false`，保持本机边界 |
|  | `accessToken` | 远程模式必需，至少 32 字符 |
| `music-tool-music` | `baseUrl` | `http://127.0.0.1:3080` |
|  | `userId` | `default`，必须与播放器一致 |
|  | `timeoutMs` | `4000` |
| `music-ui-music-mode` | — | 音乐视图，无配置 |

使用 profile 的 `cordis.patch.yml` overlay 修改 entry config，不要编辑 `node_modules` 中的安装副本。

播放器身份默认是 `default`。若修改音乐页面的 `localStorage.regretradio.user_id`，必须同步修改 `music-tool-music.userId`，否则控制工具会返回 `no_player`。

## 登录态持久化

网易云/QQ 登录在音乐页面内完成。若需要跨后端进程保存登录态，为运行环境设置独立的 64 位十六进制 `RUNTIME_CONFIG_MASTER_KEY`。不要把密钥写入 Git、README、URL、浏览器代码或公开日志。

未设置该密钥时，登录态只保留在当前后端进程内；插件不会把明文 Cookie 写入 SQLite。

## 升级、备份与卸载

升级前：

1. 停止 DSH。
2. 备份 `$DSH_HOME/dsh-music/data/`。
3. 审阅新 commit。
4. 在 `allowBuilds` 中暂时同时保留旧 SHA 与新 SHA，且都设为 `true`。
5. 用新 SHA 执行 plugin add；确认 lockfile 已切换到新 commit。
6. 删除旧 SHA 的 `allowBuilds` 键，再重新执行完整验收。

pnpm 在替换 Git 包的安装事务中仍可能检查旧 revision 的构建许可。若提前删除旧键，它会报 `ERR_PNPM_IGNORED_BUILDS`，并可能为旧 SHA 写入 `set this to true or false` 占位项；将旧、新键暂时同时授权即可完成升级。

卸载使用 DSH plugin remove 命令。卸载插件不会自动删除 `$DSH_HOME/dsh-music/data/`；确认备份与用途后再由用户决定是否清理。

## 常见问题

| 现象 | 原因/处理 |
|---|---|
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | 加入 pnpm 输出的完整 Git `allowBuilds` 键 |
| `ERR_PNPM_IGNORED_BUILDS` | 授权 `better-sqlite3` 和 `esbuild` |
| `duplicated mapping key` | 删除 pnpm 自动占位项或其他重复键 |
| dump-config 缺三个 entry | 检查 bundle patch 是否被 profile include |
| 8090 未监听 | 查后端 spawn 日志、端口占用与原生 SQLite 构建 |
| 音乐页存在但工具报 `no_player` | 打开音乐视图，并核对两端 `userId` |
| 重启后登录失效 | 设置独立 `RUNTIME_CONFIG_MASTER_KEY` |
| 直接搜索 session zstd 看不到结果 | 使用 DSH `session/page` 或数据库进行验收 |

AI 安装代理必须保护 DSH/音乐凭据，不得输出 token、Cookie 或 API key；不得未经授权删除旧 Home、音乐数据库或推送新 revision。
