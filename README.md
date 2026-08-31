# @oldsan888/dsh-music-mode

音乐插件改自：https://github.com/XxHuberrr/Mineradio。感谢原作者的开源。

DSH 音乐模式插件：在 DSH Web 中加入「音乐」视图，托管 regret-radio 播放器，并向 Agent 提供播放控制、状态读取、滚动口味画像与用户授权听感手记工具。

插件以一个 bundle 接入 DSH，不修改 DSH 源码；运行数据独立保存在 `$DSH_HOME/dsh-music/data/`。

## 主要能力

- DSH 内置音乐舞台，支持网易云、QQ、搜索、播放队列与视觉效果。
- Agent 可放歌、切歌、暂停、调节音量、管理队列并读取播放器状态。
- 从真实播放事件生成近 180 天滚动音乐画像。
- 仅在用户明确表达时保存 B 面听感原话与明确喜恶。
- DSH 启动时拉起音乐后端，DSH 退出时同步回收子进程。

## 兼容性

| 项目 | 已验证版本 |
|---|---|
| 插件 | `0.2.0` / `e2b172d36ae604190ac9db2326035d59c44681dd` |
| DSH 源码 | `0.1.2-alpha.1` / `cd5ef8148158c3a752a658978873241fdf8e2bbc` |
| DSH npm API 包 | `0.1.1-rc.2` |
| Cordis | `4.0.1` |
| Node.js | `24.14.0` |

该组合已完成远端 Git 固定 SHA 安装、真实 LLM 工具调用、重启持久化与 Home 隔离验证。安装前请阅读[安装指南](docs/INSTALLATION.md)。

## 工具概览

- 播放与队列：`music_play_song`、`music_next`、`music_prev`、`music_pause`、`music_play`、`music_queue_*` 等。
- 状态与画像：`music_get_state`、`music_taste_summary`。
- B 面手记：`music_note_write`、`music_notes_read`。

完整参数、行为边界与数据模型见[技术参考](docs/TECHNICAL-REFERENCE.md)。

## 目录

```text
dsh-music-mode/
├─ cordis.patch.yml          # 向 DSH Loader 插入三个入口
├─ src/
│  ├─ server/                # 播放器托管、HTTP 反代、Agent 工具
│  └─ client/                # DSH 音乐视图
├─ vendor/regret-radio/      # 音乐后端与前端核心
├─ test/                     # 插件契约与安全边界测试
├─ docs/                     # 安装、技术与验证文档
└─ lib/                      # prepare/build 生成的发布入口
```

## 文档索引

- [安装、配置、升级与故障排查](docs/INSTALLATION.md)
- [工具、架构、数据与安全边界](docs/TECHNICAL-REFERENCE.md)
- [公开可复核的隔离验证报告](docs/VALIDATION.md)
- [vendored regret-radio 说明](vendor/regret-radio/README.md)
- [第三方许可](THIRD_PARTY_NOTICES.md)

## 安全与许可

音乐页面及 API 默认仅接受直接 loopback 请求；不要直接暴露到局域网或公网。提供商登录态只有在设置独立 `RUNTIME_CONFIG_MASTER_KEY` 后才加密持久化。

本发行包整体采用 GPL-3.0-or-later，原因是包含并修改了 GPL 音乐核心。第三方保留条款见 `THIRD_PARTY_NOTICES.md`。
