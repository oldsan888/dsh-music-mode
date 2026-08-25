# @oldsan888/dsh-music-mode

> DSH「音乐模式」插件（bundle）。**一个 git 地址即可接入 DSH**：给 web 增加「音乐」tab 舞台（REGRET · MUSIC MODE），宿主托管 regret-radio 播放器，并给 agent 注册音乐控制、状态与口味工具。
>
> 开发与验证于 **DSH `0.1.0-rc.5`**（<https://github.com/deepseek-ai/deepseek-harness>）。

## 给 AI / 部署者的极简接入

```bash
# 方式 A：git 地址（推荐，一行接入）
dsh plugin --profile web add https://github.com/oldsan888/dsh-music-mode.git
# （pnpm ≥10 若拦截构建脚本：把打印的 allowBuilds 键加进
#   $DSH_HOME/profiles/web/pnpm-workspace.yaml，再重跑一次）

# 方式 B：已 clone 到本地（开发/离线也适用）
dsh plugin --profile web add "file:<absolute-path-to-dsh-music-mode>"

# 重启 web（Web Control 或 dsh web 重启），打开页面 → 顶部出现「对话 / 音乐」tab
```

装的是：一个 bundle 插件层（`dsh.bundle.patch`）+ 三个 entry（托管后端、AI 工具、「音乐」tab）＋ 拉起的 `music_*` 工具。**需要 DSH 已装 pnpm**（`dsh plugin` 转发 pnpm）。android:
- 音乐 tab 播放器首次使用需在网易云/QQ 登录（播放器内完成）。**运行时数据（登录态 / SQLite / 日志 / beatmap）由 host 自动重定向到可写数据目录**：默认 `$DSH_HOME/dsh-music/data/`（不写入插件安装目录，兼容 pnpm store 只读布局）。
- 若需跨重启保留网易云/QQ 登录态，请在运行环境设置 `RUNTIME_CONFIG_MASTER_KEY` 为独立的 64 位十六进制密钥；未设置时登录态只保留在当前后端进程内，不会明文写入 SQLite。

## 特性

- 「音乐」tab：对话区切换全屏舞台，播放在 DSH 内的完整 Regret 界面（登录/搜索/播放/QQ&网易云/VIP/3D 视觉）。
- **AI 可操控**：agent 拥有 17 个 `music_*` 动作（放歌/切歌/暂停/音量/播放模式/搜索/队列/好恶）+ `music_get_state` 读取播放器真相源快照。
- **按需读取口味**：`music_taste_summary` 无参数、无副作用；涉及音乐推荐、口味询问或刷新音乐长期记忆时，DSH 从 `music_events + music_preferences` 现场读取近 180 天完整滚动画像。行为画像不做首轮自动注入，也没有 checkpoint / pending / generate / consume 同步状态机。
- 播放器托管 + SSE content-type 修复（2026-08-19 端到端根因：反代必须透传 `text/event-stream`，否则浏览器 EventSource 连不上）——一起打包、开箱即用。
- 状态快照：浏览器播放器为唯一真相源，经 `/api/player/state` 上报，`music_get_state` 读取。

## 用法速记

- 对话区顶部切「音乐」→ 舞台。播放器内点歌 / 登录。
- 对 AI 说："放首示例歌手的示例歌曲""下一首""大点声""调到一半""搜示例歌手""现在放的什么" → AI 用 `music_*` 驱动。

## 配置

本插件为三层 `cordis.patch.yml` 行，不装时无任何副作用。核心可调项（宿主 profile 的 `cordis.patch.yml` 覆写对应行 config）：

| 行 id | 配置 | 作用 |
|---|---|---|
| `music-server-regret-visual` | `{ backendPort?, stageRoot?, backendRoot?, hostBackend?, allowRemote?, accessToken? }` | 托管后端端口（默认 8090）、资源路径覆盖；HTTP 默认仅本机。远程模式必须显式开启并由受信反代添加至少 32 字符的 Bearer token |
| `music-tool-music` | `{ baseUrl?, userId?, timeoutMs? }` | 命令端点基址（默认 `http://127.0.0.1:3080`）、播放器 id（默认 `default`）、relay 超时(ms) |
| `music-ui-music-mode` | — | 「音乐」tab 视图 |

### 播放器 user_id：由你决定（不是绑死 `default`）

播放器 SSE 身份默认 `default`（与工具默认一致，开箱即用）。要换 id：由部署的 AI **询问用户用什么 id** → 在音乐 tab 页面写入 `localStorage.regretradio.user_id`（任意非空值）→ 刷新 iframe 生效；**必须与 `music-tool-music` 的 `userId` 保持一致**（错位 → AI 报 `no_player`）。多实例各自独立后端时可都保持默认，id 只需在单个后端实例内唯一。详见 `vendor/regret-radio/README.md`「Deployer: player user_id is configurable」。

## 目录结构

```
dsh-music-mode/
├─ cordis.patch.yml        # bundle 层：insert 三行（托管后端 / AI 工具 / 音乐 tab）
├─ src/
│  ├─ index.ts             # client 行的 node 半（空 apply）+ 聚合包根
│  ├─ server/
│  │  ├─ visual.ts         # host：spawn 后端 + serve 前端 + /api 反代（含 SSE 修复）
│  │  └─ tool.ts           # host：音乐控制、状态、完整滚动口味与 B 面工具
│  ├─ client/              # client：音乐 tab 舞台（MusicTheaterView 等）
│  └─ typings/             # 宿主类型 shim（cordis services / dsh-tools / webServer）
└─ vendor/regret-radio/    # 音乐核心（瘦身后端 + 前端静态，自含）
```

## 本地开发 / 构建

```bash
pnpm install
npm run build      # tsdown：host ESM（lib/*.js）+ client CJS（lib/client.js）
npm run typecheck
```
- host entry 对 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 保持 external（运行解析到宿主 DSH 进程内提供者，绝不内联副本）。
- client bundle 走 `__ModuleLoader__.load({id, factory})` 协议：平台模块（react/cordis/…）external，其余依赖内联。

## 安全默认值

- 音乐静态页及全部 API 默认只接受直接本机 HTTP（loopback socket、loopback Host、且无代理转发标记）；宿主即使监听所有网卡或前置反向代理，也不会把远端请求“洗成”后端 loopback。
- 不建议直接暴露到局域网或公网。确需远程访问时，设置 `allowRemote: true` 和高熵 `accessToken`，并让受信反向代理在所有音乐资源请求上添加 `Authorization: Bearer ...`；不得把 token 写入前端代码或公开 URL。
- 提供商登录态仅在设置独立的 `RUNTIME_CONFIG_MASTER_KEY` 后加密持久化；旧明文 Cookie 成功迁移并校验后会被删除。

## 许可与第三方

- 本发行包整体：**GPL-3.0-or-later**，见 `LICENSE`。这是因为内含并修改了 GPL 音乐核心/视觉源码。
- 音乐视觉效果源自 GPL-3.0 的 [XxHuberrr/Mineradio.git](https://github.com/XxHuberrr/Mineradio.git)，本仓库是 DSH 专用修改版，不是原作者发布的官方版本。
- 单独捆绑的第三方库及其保留条款见 `THIRD_PARTY_NOTICES.md`；其中 GSAP 适用其 Standard License，不按 GPL 重新许可。
- 说明：`@deepseek-ai/*` 宿主能力（cordis / dsh-tools / webServer / client 服务）由**宿主 DSH** 提供，本包不重复安装。
