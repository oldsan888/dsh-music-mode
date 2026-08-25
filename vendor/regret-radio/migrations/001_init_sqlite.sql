-- Regretio SQLite Schema

-- 对话表
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
  message_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages (user_id, created_at);

-- 会话表（备用，实际用内存缓存）
CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  data            TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 记忆表（核心）
CREATE TABLE IF NOT EXISTS memories (
  memory_id         TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  scope             TEXT NOT NULL DEFAULT 'user',
  type              TEXT NOT NULL,
  namespace         TEXT NOT NULL,
  key               TEXT,
  content           TEXT NOT NULL,
  raw_quote         TEXT,
  value             TEXT,
  tags              TEXT NOT NULL DEFAULT '[]',
  importance        REAL NOT NULL DEFAULT 0.5,
  confidence        REAL NOT NULL DEFAULT 0.7,
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at  TEXT,
  expires_at        TEXT,
  source            TEXT NOT NULL,
  evidence_ids      TEXT NOT NULL DEFAULT '[]',
  superseded_by     TEXT,
  embedding         BLOB,
  embedding_ver     INTEGER NOT NULL DEFAULT 1,
  embedding_pending INTEGER NOT NULL DEFAULT 0
);

-- 唯一索引：同一 (user, namespace, key) 最多一条 active semantic
CREATE UNIQUE INDEX IF NOT EXISTS uniq_semantic_active
  ON memories (user_id, namespace, key)
  WHERE status = 'active' AND type = 'semantic' AND key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_user_status_imp
  ON memories (user_id, status, importance DESC);

CREATE INDEX IF NOT EXISTS idx_memories_user_type_status
  ON memories (user_id, type, status);

-- 事件日志表
CREATE TABLE IF NOT EXISTS mem_event_log (
  event_id          TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  turn_id           TEXT NOT NULL,
  message_ids       TEXT NOT NULL,
  extractor_version TEXT NOT NULL DEFAULT 'v1.0',
  status            TEXT NOT NULL DEFAULT 'pending',
  processed_at      TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mem_event_log_status ON mem_event_log (status, created_at);

-- 音乐行为事件表
CREATE TABLE IF NOT EXISTS music_events (
  event_id      TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  session_id    TEXT,
  track_id      TEXT NOT NULL,
  track_title   TEXT,
  track_artist  TEXT,
  event_type    TEXT NOT NULL,
  position_ms   INTEGER,
  duration_ms   INTEGER,
  context       TEXT DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_music_events_user ON music_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_music_events_track ON music_events(user_id, track_id, event_type);

-- 音乐偏好推断表（独立于 memories，由 aggregator 压缩管理）
CREATE TABLE IF NOT EXISTS music_preferences (
  pref_id       TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  artist        TEXT NOT NULL,
  score         REAL NOT NULL DEFAULT 0,
  liked_count   INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  total_events  INTEGER NOT NULL DEFAULT 0,
  tendency      TEXT NOT NULL DEFAULT 'neutral',  -- positive / negative / neutral
  status        TEXT NOT NULL DEFAULT 'inferred', -- inferred / confirmed / rejected
  evidence      TEXT DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_music_pref_user_artist
  ON music_preferences(user_id, artist);

-- Hermes-style 核心画像：用户画像摘要（从 memories 压缩而来）
CREATE TABLE IF NOT EXISTS user_core_profiles (
  user_id           TEXT PRIMARY KEY,
  user_md           TEXT NOT NULL DEFAULT '',
  version           INTEGER NOT NULL DEFAULT 1,
  source_memory_ids TEXT NOT NULL DEFAULT '[]',
  char_count        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active',
  dirty_at          TEXT,
  dirty_reason      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dube 自身运行约定：全局/profile-level，不按用户重复保存
CREATE TABLE IF NOT EXISTS agent_profile (
  profile_id  TEXT PRIMARY KEY DEFAULT 'dube',
  agent_md    TEXT NOT NULL DEFAULT '',
  version     INTEGER NOT NULL DEFAULT 1,
  char_count  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 核心画像变更审计
CREATE TABLE IF NOT EXISTS core_profile_events (
  event_id     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  action       TEXT NOT NULL,
  section      TEXT NOT NULL,
  old_text     TEXT,
  new_text     TEXT,
  evidence_ids TEXT NOT NULL DEFAULT '[]',
  source       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_core_profile_events_user
  ON core_profile_events(user_id, created_at);

-- 定时任务（持久调度器，plans/2026-07-07-scheduled-tasks-and-proactivity）。
-- 单一真相在 SQLite（ADR-5）+ 轮询触发；setTimeout 重启即丢，故持久化。
-- 时间列一律 clock.ts 的 UTC 文本格式 'YYYY-MM-DD HH:MM:SS'（可字典序比较，供 fire_at <= now 认领）。
-- 注意：ensureSchedulerSchema(db)（scheduler/store.ts）保有同一份 DDL 供 :memory: 单测，改此处务必同步。
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  task_id        TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,                   -- 'reminder' | 'playback' | 'proactive'(阶段5)
  fire_at        TEXT NOT NULL,                   -- 调度器按此触发（UTC 文本）
  payload        TEXT NOT NULL DEFAULT '{}',      -- JSON：reminder={what}; playback={action,args}
  channels       TEXT NOT NULL DEFAULT '[]',      -- JSON string[]：['web','feishu']；空=回源通道
  origin_channel TEXT,                            -- 创建时来源通道
  origin_chat_id TEXT,                            -- 飞书创建时的 chat_id（回投用）
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|firing|fired|cancelled|expired
  received_at    TEXT NOT NULL,                   -- 用户发信息时刻（时间基准锚，§1）
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  fired_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sched_pending ON scheduled_tasks(status, fire_at);

-- 主动性发言日志（阶段5，plans/2026-07-07-phase5-proactivity-plan §2）。
-- 每句 dube 主动发言一行：频率封顶 / 不理降频 / 回应率指标的单一事实源（指标绝不看发送量）。
-- 「回应」= 推送后回应窗内用户开口（代理判定；窗按 kind：interlude 10min / checkin、morning 12h）。
-- 注意：ensureProactiveSchema(db)（proactive/store.ts）保有同一份 DDL 供 :memory: 单测，改此处务必同步。
CREATE TABLE IF NOT EXISTS proactive_log (
  log_id       TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,                -- 'interlude' | 'checkin' | 'morning'
  channel      TEXT NOT NULL,                -- 'web' | 'feishu'
  text         TEXT NOT NULL,                -- 实际说出的那句话
  trigger_note TEXT,                         -- 触发摘要（哪些信号命中，复盘/调参用）
  delivered    INTEGER NOT NULL DEFAULT 0,   -- 连接级送达（pushNotify/sendFeishuText 返回值）
  responded_at TEXT,                         -- 回应窗内用户开口的时刻
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proactive_user ON proactive_log(user_id, created_at);
