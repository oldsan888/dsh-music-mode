import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { sha1Hex } from "./util/crypto.js";
import { safeFilenameComponent, resolveUnderCwd } from "./util/fs.js";

/**
 * 节拍图磁盘缓存（M2-C C3，从原项目 server.js 移植为 TS）。
 *
 * 前端用 music-tempo 离线算出 beatmap 后 POST 持久化，下次 GET 命中即免算。
 * 与 `/api/podcast/dj-beatmap`（服务端 DSP 分析）无关，是独立的前端缓存。
 *
 * F8：原实现硬编码绝对盘符路径且**主动禁止 C 盘 / 要求目标盘根存在**，
 * 换机即废。这里改为可移植的 `config.music.beatCacheDir`（默认 `data/beatmaps`），
 * 去掉 C 盘禁忌——单机私人电台本就该落在项目 data/ 下。
 */

export interface BeatmapCacheInput {
  key?: unknown;
  map?: unknown;
  provider?: unknown;
  title?: unknown;
  artist?: unknown;
  mode?: unknown;
}

export interface BeatmapCacheEntry {
  v: number;
  key: string;
  savedAt: number;
  meta: { provider: string; title: string; artist: string; mode: string };
  map: Record<string, unknown>;
}

const MAX_CACHE_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_FILES = 500;

function pruneCache(root: string, keepFile: string): void {
  const files = readdirSync(root)
    .filter((name) => name.endsWith(".json") && join(root, name) !== keepFile)
    .map((name) => ({ path: join(root, name), mtime: statSync(join(root, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  while (files.length >= MAX_CACHE_FILES) {
    const victim = files.shift();
    if (victim) try { unlinkSync(victim.path); } catch { /* best effort */ }
  }
}

function resolvedDir(dir?: string): string {
  return resolveUnderCwd(dir ?? config.music.beatCacheDir);
}

/** 由 key 生成缓存文件路径：`<label>-<sha1>.json`（label 净化，防穿越）。 */
function cacheFile(key: string, dir: string): string | null {
  const raw = String(key || "").trim();
  if (!raw || raw.length > 240) return null;
  const label = safeFilenameComponent(raw, 48) || "beatmap";
  return join(dir, `${label}-${sha1Hex(raw)}.json`);
}

/** 缓存状态（供 /api/beatmap/cache/status）。去 C 盘禁忌后恒为 disk 模式。 */
export function beatCacheStatus(dir?: string): {
  enabled: boolean;
  dir: string;
  mode: "disk";
  reason: "";
} {
  return { enabled: true, dir: resolvedDir(dir), mode: "disk", reason: "" };
}

/** 读缓存：命中返回完整 entry，未命中/损坏返回 null。 */
export function readBeatmapCache(key: string, dir?: string): BeatmapCacheEntry | null {
  const file = cacheFile(key, resolvedDir(dir));
  if (!file || !existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw && raw.map ? (raw as BeatmapCacheEntry) : null;
  } catch {
    return null;
  }
}

/** 写缓存：校验 key+map，原子写（tmp→rename）。 */
export function writeBeatmapCache(
  body: BeatmapCacheInput,
  dir?: string,
): { ok: true; key: string; savedAt: number; dir: string } | { ok: false; error: string } {
  const key = String((body && body.key) || "").trim();
  const map = body?.map;
  if (!key || !map || typeof map !== "object") {
    return { ok: false, error: "INVALID_BEATMAP_CACHE_PAYLOAD" };
  }
  const root = resolvedDir(dir);
  const file = cacheFile(key, root);
  if (!file) return { ok: false, error: "INVALID_BEATMAP_CACHE_KEY" };
  const payload: BeatmapCacheEntry = {
    v: 1,
    key,
    savedAt: Date.now(),
    meta: {
      provider: String(body.provider || "").slice(0, 32),
      title: String(body.title || "").slice(0, 160),
      artist: String(body.artist || "").slice(0, 160),
      mode: String(body.mode || "mr").slice(0, 32),
    },
    map: map as Record<string, unknown>,
  };
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CACHE_ENTRY_BYTES) {
    return { ok: false, error: "BEATMAP_CACHE_ENTRY_TOO_LARGE" };
  }
  pruneCache(root, file);
  const tmp = file + ".tmp";
  writeFileSync(tmp, serialized);
  renameSync(tmp, file);
  return { ok: true, key, savedAt: payload.savedAt, dir: root };
}
