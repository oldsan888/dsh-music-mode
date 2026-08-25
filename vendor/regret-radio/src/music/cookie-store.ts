/**
 * Cookie 存取（C6-2，ADR-5）：持久化**反转为 SQLite 自持**（music_cookies 表），取代旧的 gateway 文件委派。
 *
 * 真源 = SQLite。gateway.cjs 仅保留运行期内存缓存：其 saveCookie/saveQQCookie 经**注入的 persist 回调**落库
 * （无文件 I/O、无 require 环——cookie-store → gateway 单向），boot 时由 initCookieStore 从库回灌 gateway 内存。
 * 登录路由消费的门面 getNetease/setNetease/getQQ/setQQ 签名不变。
 *
 * 迁移：首次启动若库内某源为空且旧文件（data/.cookie / .qq-cookie）存在，一次性导入，保住既有登录态。
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import { getDb } from "../store/sqlite.js";
import { config } from "../config.js";
import {
  decryptRuntimeConfig,
  encryptRuntimeConfig,
  isRuntimeSecretStorageAvailable,
} from "../store/secure-app-config.js";

type Db = ReturnType<typeof getDb>;

const requireCjs = createRequire(import.meta.url);
let gw: { saveCookie?: (c: string) => void; saveQQCookie?: (c: string) => void; setCookiePersist?: (fn: (provider: string, cookie: string) => void) => void; setRuntimeCookie?: (provider: string, c: string) => void } | null = null;
function gateway() {
  if (!gw) gw = requireCjs("./legacy/gateway.cjs");
  return gw!;
}

function rawCookieRow(provider: string, db: Db): string {
  const row = db.prepare("SELECT cookie FROM music_cookies WHERE provider = ?").get(provider) as { cookie?: string } | undefined;
  return (row && row.cookie) || "";
}

/**
 * Read only authenticated-encrypted cookie records. Legacy plaintext is never
 * returned to the runtime gateway, so an upgrade cannot keep using an exposed
 * login session.
 */
export function getCookieRow(provider: string, db: Db = getDb()): string {
  const raw = rawCookieRow(provider, db);
  return raw ? decryptRuntimeConfig(raw, config.security.runtimeConfigMasterKey) ?? "" : "";
}

/** UPSERT encrypted cookie material; a missing master key disables persistence. */
export function setCookieRow(provider: string, cookie: string, db: Db = getDb()): void {
  if (!isRuntimeSecretStorageAvailable()) {
    throw new Error("RUNTIME_CONFIG_MASTER_KEY is required to persist music login cookies");
  }
  const encrypted = encryptRuntimeConfig(cookie || "", config.security.runtimeConfigMasterKey);
  db.prepare(
    "INSERT INTO music_cookies (provider, cookie, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(provider) DO UPDATE SET cookie = excluded.cookie, updated_at = excluded.updated_at",
  ).run(provider, encrypted, new Date().toISOString());
}

function deleteCookieRow(provider: string, db: Db): void {
  db.prepare("DELETE FROM music_cookies WHERE provider = ?").run(provider);
}

/** Upgrade legacy plaintext records in place, or remove them when no key exists. */
export function secureStoredCookies(db: Db = getDb()): void {
  for (const provider of ["netease", "qq"]) {
    const raw = rawCookieRow(provider, db);
    if (!raw || raw.startsWith("enc:v1:")) continue;
    if (isRuntimeSecretStorageAvailable()) setCookieRow(provider, raw, db);
    else deleteCookieRow(provider, db);
  }
}

/** 旧文件 cookie → SQLite 一次性迁移：仅当库内该源为空且文件存在时导入（不覆盖库值）。db/fs/paths 可注入单测。 */
export function migrateCookieFiles(
  db: Db = getDb(),
  fsLike: Pick<typeof fs, "existsSync" | "readFileSync" | "unlinkSync"> = fs,
  paths: { netease: string; qq: string } = { netease: config.music.cookieFile, qq: config.music.qqCookieFile },
): void {
  if (!isRuntimeSecretStorageAvailable()) return;
  const sources: [string, string][] = [
    ["netease", paths.netease],
    ["qq", paths.qq],
  ];
  for (const [provider, file] of sources) {
    try {
      if (file && fsLike.existsSync(file)) {
        if (!getCookieRow(provider, db)) {
          const c = String(fsLike.readFileSync(file, "utf8")).trim();
          if (c) setCookieRow(provider, c, db);
        }
        // 只有加密库记录可成功解密后才移除明文源；失败保留以便人工恢复。
        if (getCookieRow(provider, db)) fsLike.unlinkSync(file);
      }
    } catch {
      /* 文件读失败忽略 */
    }
  }
}

let initialized = false;
/**
 * 启动初始化（须在 app.listen 前调用一次）：注册 persist 回调（gateway 写 → SQLite）+ 迁移旧文件 + 回灌 gateway 运行期 cookie。
 * 顺序关键：先注册回调、再迁移、最后回灌（回灌走 setRuntimeCookie 不触发回写）。
 */
export function initCookieStore(): void {
  if (initialized) return;
  initialized = true;
  const db = getDb();
  secureStoredCookies(db);
  const g = gateway();
  g.setCookiePersist?.((provider: string, cookie: string) => setCookieRow(provider, cookie, db));
  migrateCookieFiles(db);
  g.setRuntimeCookie?.("netease", getCookieRow("netease", db));
  g.setRuntimeCookie?.("qq", getCookieRow("qq", db));
}

/** 公共门面（登录路由消费，签名不变）。写经 gateway.saveCookie（归一 + 内存 + persist→SQLite）；读取库（真源）。 */
export const cookieStore = {
  getNetease(): string {
    return getCookieRow("netease");
  },
  setNetease(cookie: string): void {
    gateway().saveCookie?.(cookie);
  },
  getQQ(): string {
    return getCookieRow("qq");
  },
  setQQ(cookie: string): void {
    gateway().saveQQCookie?.(cookie);
  },
};
