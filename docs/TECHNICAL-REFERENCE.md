# 技术参考

## 组成

`cordis.patch.yml` 向 DSH Loader 插入三个入口：

| entry | 作用 |
|---|---|
| `server-visual` | 启动 vendored 后端、托管静态页、注册 loopback HTTP 反代 |
| `server-tool` | 注册 Agent 音乐工具，并把命令转发给浏览器播放器 |
| package root/client | 向 `conversation.view` 注册 `music-theater` |

浏览器播放器是播放状态的唯一真相源。Agent 命令通过 DSH 3080 的同源端点转到 8090 后端，再经 SSE 送往当前音乐页面。

## 工具

### 播放与队列

- `music_next`、`music_prev`、`music_toggle`、`music_pause`、`music_play`
- `music_volume`、`music_set_play_mode`
- `music_search`、`music_play_song`、`music_play_stageindex`
- `music_queue_add_song`、`music_queue_add_index`
- `music_play_queueindex`、`music_queue_remove`、`music_queue_clear`
- `music_remove_current`、`music_rate`

控制端只有在播放器报告 `delivered=true && ok=true` 时才宣称成功。未打开音乐页返回 `no_player`，超时返回 `timeout`。

### 状态与画像

- `music_get_state`：读取当前曲目、播放状态与队列快照。
- `music_taste_summary`：只读聚合事件、歌手倾向、重复完整播放、15 秒内快切与已授权手记。无 pending/checkpoint/consume 副作用。

行为画像属于 `agent-inferred`。用户明确表达和用户维护的长期记忆始终优先。

### B 面手记

- `music_note_write`：仅保存用户明确说出的听感原话；可原子记录 `liked` / `disliked`。
- `music_notes_read`：返回聚合与用户已授权给 DSH 的原文；未授权原文在服务端不可达。

不得把播放、循环或跳过行为改写为用户感受。若用户既表达原话又明确喜欢/不喜欢，应只调用 `music_note_write` 并填写 `preference`，不要再重复调用评分工具。

## 数据

默认运行根：

```text
$DSH_HOME/dsh-music/data/
├─ regret-radio.db
├─ regret-radio.db-wal
├─ regret-radio.db-shm
├─ logs/
├─ beatmaps/
├─ .cookie
└─ .qq-cookie
```

Cookie 文件是否持久化取决于 `RUNTIME_CONFIG_MASTER_KEY`。数据库包含音乐事件、偏好、B 面手记和应用配置；升级/迁移前应整体备份该目录。

## 依赖契约

运行时宿主 API 是 peers：Cordis、DSH tools、host webserver、client locale/conversation/slots。插件构建把 Cordis、DSH tools 和浏览器平台模块保持 external，避免加载第二份宿主服务或 React。

当前 DSH Git 源码为 `0.1.2-alpha.1`，npm 上对应 API 包最高稳定可安装版本为 `0.1.1-rc.2`，因此 peer range 明确接受这两个已验证版本。rc.2 用于独立开发类型检查，实际运行解析到 DSH profile 提供的 alpha.1 宿主包。

## HTTP 安全边界

- 默认只接受 loopback socket、loopback Host 且没有代理转发标记的直接请求。
- 写操作还要求同源上下文。
- 媒体代理限制提供商域名，并拒绝解析到私网/loopback 的地址。
- `allowRemote=true` 时必须提供至少 32 字符的 `accessToken`，并由受信反向代理注入 Bearer；不得放进前端或公开 URL。
- 音乐后端是 DSH 子进程；DSH effect dispose 时回收后端。

## 构建与测试

```bash
pnpm install --frozen-lockfile
pnpm peers check
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run
```

测试覆盖安装契约、客户端对话桥、安全边界、SSRF、Cookie 迁移、命令白名单、B 面手记和口味聚合。
