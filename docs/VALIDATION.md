# 公开隔离验证报告

验证日期：2026-08-30。

## 对象

| 项目 | 版本 |
|---|---|
| 插件 | `0.2.0` / `e2b172d36ae604190ac9db2326035d59c44681dd` |
| DSH | `0.1.2-alpha.1` / `cd5ef8148158c3a752a658978873241fdf8e2bbc` |
| Cordis | `4.0.1` |
| Node.js | `24.14.0` |
| 安装来源 | GitHub 远端完整 SHA |

测试使用从已验证 LLM 配置基线复制出的全新 `DSH_HOME`。插件没有从本地仓库安装，也没有复用旧 profile 或旧音乐数据库。

## 源码检查

- 本地 HEAD 与 GitHub revision 一致。
- 使用真实 DSH npm API 类型，未使用手写宿主 shim。
- `pnpm peers check` 与 `pnpm typecheck` 通过。
- 76 项测试通过：顶层 12、vendor Node 11、Vitest 53。
- 三个 bundle 入口构建通过。
- dry-run 包不含 vendor 测试、缓存或 `node_modules`。

真实类型检查发现并修复了一个旧 shim 隐藏的问题：`music_note_write` 无偏好时曾返回 `undefined` 字段，不符合 DSH JSON tool-output 契约。

## 远端安装

首次安装触发 pnpm 的 Git prepare 安全拦截；授权完整 Git revision 后，profile 安装又要求授权 `better-sqlite3` 与 `esbuild` 构建脚本。加入三个明确授权项后安装成功。

结果：

- lockfile resolution 固定到目标 SHA。
- peer 检查无告警。
- dump-config 出现 visual、tool、client 三个音乐入口。
- `better-sqlite3` 在 Node 24.14.0 下安装并加载成功。

这些安全拦截是 pnpm 的预期行为，具体配置见[安装指南](INSTALLATION.md)。

## 启动与客户端

- DSH 监听 3080，音乐后端作为其子进程监听 8090。
- `/regret-visual/` 返回 200，并包含视觉引导注入。
- 播放器状态与口味画像 API 返回有效结构。
- DSH boot manifest 包含插件，client combo 返回 200 并包含 `music-theater`。
- SQLite 与日志只出现在新 Home 的 `dsh-music/data/`。

## 真实 LLM 工具链

第一会话要求模型保存一条带明确喜欢的 B 面原话：

- DSH 事件流包含 `tool/call: music_note_write` 与对应 `tool/result`。
- 模型完成约定回复。
- `music_notes` 中存在授权原文。
- `music_preferences` 中同步存在 positive 偏好，证明原子联动完成。

停止 DSH 后，8090 子进程同步退出。用同一 Home 重启后创建第二会话：

- 模型实际调用 `music_notes_read`。
- 工具读回重启前原文。
- 模型完成约定回复。

因此真实 LLM 注册、工具执行、SQLite 写入和跨进程读取均通过。

## 隔离结果

以首次音乐启动时间为界，排除 `node_modules` 检查旧环境：旧开发 Home、原始干净 Home、配置基线 Home和两个既有记忆测试 Home均为 0 个文件修改。新 Home 的 `settings.yaml` 与基线哈希一致；所有音乐数据均落入新 Home。

## 验证注意事项

DSH session 文件默认是多帧 `.jsonl.zstd`。不要用普通文本搜索判断工具是否执行；应使用 DSH `session/page`、事件流或业务数据库。验证脚本还应从 projection cache row 的 `seq` 字段取 `throughSeq`，而不是从 row value 中读取。

## 结论

该 revision 已通过公开仓库消费者最关心的路径：固定 SHA 获取、独立安装、宿主兼容、客户端装载、后端生命周期、真实工具写入、重启持久化与 Home 隔离。
