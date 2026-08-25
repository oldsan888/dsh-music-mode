import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { config } from "../config.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.resolve(config.sqlite.path);

    // 确保目录存在
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(dbPath);

    // DSH slim：上游 Memory v3 的 sqlite-vec 向量检索属 A 派，已随瘦身剥离，
    // 不再加载扩展；B 躯干派只做普通 SQLite 读写（events/preferences/cookie/KV）。

    // 启用 WAL 模式（更好的并发性能）
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");

    // 执行迁移
    const migrationPath = path.resolve("migrations/001_init_sqlite.sql");
    const migration = fs.readFileSync(migrationPath, "utf-8");
    db.exec(migration);

    // 增量迁移（Memory v2）：幂等地补列，避免单独的迁移 runner
    ensureMemoryV2Columns(db);

    // 用户设置表（dube 名字 / 音色模式），幂等建表
    ensureUserSettingsTable(db);

    // 阶段5 主动性旋钮/静音列：存量表幂等补列（CREATE TABLE IF NOT EXISTS 不加列）
    ensureUserSettingsColumns(db);

    // 音乐 cookie 表（C6-2，ADR-5）：netease/qq 登录 cookie 自持，幂等建表
    ensureMusicCookiesTable(db);

    // 应用级 KV 配置（09，ADR-5）：运行时 AI 提供方配置等，幂等建表
    ensureAppConfigTable(db);

    // B 面听感手记：用户原创内容独立于可衰减的行为事件永久保存。
    ensureMusicNotesTable(db);
  }
  return db;
}

/** 音乐 cookie 持久化（C6-2，ADR-5）：按 provider(netease/qq) 主键存登录 cookie。可重复执行。 */
function ensureMusicCookiesTable(database: Database.Database): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS music_cookies (
       provider TEXT PRIMARY KEY,
       cookie TEXT NOT NULL DEFAULT '',
       updated_at TEXT
     )`,
  );
}

/** 应用级 KV 配置（09，ADR-5）：运行时 AI 提供方配置等，按 key 主键存。可重复执行。 */
function ensureAppConfigTable(database: Database.Database): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS app_config (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL DEFAULT '',
       updated_at TEXT
     )`,
  );
}

/** B 面听感手记。独立表避免原文被 music_events 的窗口/清理策略波及。 */
function ensureMusicNotesTable(database: Database.Database): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS music_notes (
       note_id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       track_id TEXT NOT NULL,
       track_title TEXT,
       track_artist TEXT,
       provider TEXT,
       work_key TEXT NOT NULL,
       mood TEXT,
       text TEXT,
       prompt TEXT,
       prompt_kind TEXT,
       source TEXT NOT NULL,
       shared_at TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     );
     CREATE INDEX IF NOT EXISTS idx_music_notes_user_work
       ON music_notes(user_id, work_key, created_at DESC);
     CREATE INDEX IF NOT EXISTS idx_music_notes_user_time
       ON music_notes(user_id, created_at DESC);`,
  );
}

/** 用户级设置：助手名、音色模式、主动性旋钮。按 user_id 主键存。可重复执行。 */
function ensureUserSettingsTable(database: Database.Database): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS user_settings (
       user_id TEXT PRIMARY KEY,
       assistant_name TEXT,
       voice_mode TEXT,
       proactivity_level TEXT DEFAULT 'off',
       proactive_muted_until TEXT,
       updated_at TEXT
     )`,
  );
}

/**
 * 阶段5 主动性设置列（plans/2026-07-07-phase5-proactivity-plan §2）。
 * SQLite 不支持 IF NOT EXISTS for ADD COLUMN，故先读 PRAGMA table_info、仅补缺失列
 * （ensureMemoryV2Columns 同款）。默认 'off'：主动性是用户往上拧的旋钮，绝不默认开。
 */
function ensureUserSettingsColumns(database: Database.Database): void {
  const cols = new Set(
    (database.prepare("PRAGMA table_info(user_settings)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  const adds: Array<[string, string]> = [
    // 主动性旋钮：'off' | 'standard'（读取侧再做正向白名单归一，双保险）
    ["proactivity_level", "TEXT DEFAULT 'off'"],
    // 全局静音到某时刻（UTC 文本 'YYYY-MM-DD HH:MM:SS'，字典序可比 now）
    ["proactive_muted_until", "TEXT"],
  ];
  for (const [name, def] of adds) {
    if (!cols.has(name)) {
      database.exec(`ALTER TABLE user_settings ADD COLUMN ${name} ${def}`);
    }
  }
}

/**
 * Memory v2 新增列。SQLite 不支持 IF NOT EXISTS for ADD COLUMN，
 * 故先读 PRAGMA table_info，仅补缺失列。可重复执行。
 */
function ensureMemoryV2Columns(database: Database.Database): void {
  const cols = new Set(
    (database.prepare("PRAGMA table_info(memories)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  const adds: Array<[string, string]> = [
    // 召回强化：被读取的次数，用于检索打分中的「频率」维度
    ["access_count", "INTEGER NOT NULL DEFAULT 0"],
    // 反思（reflection）最后一次把该 episodic 纳入 insight 的时间
    ["last_reflected_at", "TEXT"],
    // Memory v3 分层：1=核心层 2=活跃层 3=归档层
    ["tier", "INTEGER NOT NULL DEFAULT 2"],
    // 最近一次被检索打分命中的时间（供分层降级用）
    ["last_ranked_at", "TEXT"],
  ];
  for (const [name, def] of adds) {
    if (!cols.has(name)) {
      database.exec(`ALTER TABLE memories ADD COLUMN ${name} ${def}`);
    }
  }
  // 已有 core.* 记忆回填为 Tier 1（幂等：仅修正仍为默认值 2 的核心记忆）
  database.exec(
    `UPDATE memories SET tier = 1 WHERE namespace LIKE 'core.%' AND tier = 2`,
  );
  // 检索常用：按 user + type + status + importance 排序拉候选池
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_memories_user_type_status_imp
       ON memories (user_id, type, status, importance DESC)`,
  );
  // 分层检索：按 user + type + status + tier 拉候选
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_memories_user_type_status_tier
       ON memories (user_id, type, status, tier)`,
  );
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// 事务封装
export function withTx<T>(fn: (db: Database.Database) => T): T {
  const database = getDb();
  return database.transaction(() => fn(database))();
}

// 查询辅助（返回数组）
export function query<T = any>(sql: string, params?: unknown[]): T[] {
  const database = getDb();
  const stmt = database.prepare(sql);
  if (params) {
    return stmt.all(...params) as T[];
  }
  return stmt.all() as T[];
}

// 获取单行
export function queryOne<T = any>(sql: string, params?: unknown[]): T | undefined {
  const database = getDb();
  const stmt = database.prepare(sql);
  if (params) {
    return stmt.get(...params) as T | undefined;
  }
  return stmt.get() as T | undefined;
}

// 执行（INSERT/UPDATE/DELETE）
export function execute(sql: string, params?: unknown[]): Database.RunResult {
  const database = getDb();
  const stmt = database.prepare(sql);
  if (params) {
    return stmt.run(...params);
  }
  return stmt.run();
}
