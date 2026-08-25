import { getDb } from "./sqlite.js";

/**
 * 应用级 KV 配置存储（09，ADR-5：SQLite 单一真相源）。
 * 用途：运行时 AI 提供方配置（前端「小白接入」保存的 provider/key/model 等）。
 * key 明文存服务端——单机单用户、自己的机器，与 .env 明文存 key 同级；绝不回传前端、绝不进日志。
 * db 可注入便于单测（与 cookie-store 同范式）。
 */

type Db = ReturnType<typeof getDb>;

/** 读一个 KV。缺省 → null。 */
export function readAppConfig(key: string, db: Db = getDb()): string | null {
  const row = db
    .prepare("SELECT value FROM app_config WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

/** 写一个 KV（upsert）。 */
export function writeAppConfig(key: string, value: string, db: Db = getDb()): void {
  db.prepare(
    "INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value, new Date().toISOString());
}

/** 删一个 KV。 */
export function deleteAppConfig(key: string, db: Db = getDb()): void {
  db.prepare("DELETE FROM app_config WHERE key = ?").run(key);
}
