import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  readBeatmapCache,
  writeBeatmapCache,
  beatCacheStatus,
  type BeatmapCacheInput,
} from "../music/beatmap-cache.js";
import { createLogger } from "../logger.js";

/**
 * 节拍图缓存路由（M2-C C3）。前端 music-tempo 算好的 beatmap 持久化读写。
 * dj-beatmap 的服务端 DSP 分析（analyzePodcastDjStream）仍走 C1 桥接（dj-analyzer 留 .cjs，ADR-9）。
 */

const log = createLogger("music");

function cacheStatus(): ReturnType<typeof beatCacheStatus> {
  return beatCacheStatus();
}

function cacheGet(req: FastifyRequest): Record<string, unknown> {
  const key = (req.query as Record<string, string>)?.key || "";
  const entry = readBeatmapCache(key);
  return entry
    ? { ok: true, hit: true, key: entry.key || key, map: entry.map, meta: entry.meta || {}, savedAt: entry.savedAt || 0 }
    : { ok: true, hit: false, key };
}

async function cachePost(req: FastifyRequest): Promise<unknown> {
  // 保真原始 server.js POST handler：sendJSON 默认 HTTP 200，软失败（非法 payload / 写盘异常）
  // 均以 200 + {ok:false,...} 返回，前端 apiJson 只读 body.ok（不看 status）；写盘抛错时降级
  // 为 memory-only 让前端停止重试，而非透传 Fastify 500。
  try {
    return writeBeatmapCache((req.body ?? {}) as BeatmapCacheInput);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return {
      ok: false,
      enabled: false,
      mode: "memory-only",
      reason: e?.code || e?.message || "BEAT_CACHE_WRITE_FAILED",
      dir: beatCacheStatus().dir,
    };
  }
}

/** 注册节拍缓存路由。须在 app.listen 之前、桥接之外（桥接已移除 /api/beatmap/*）。 */
export function registerBeatmap(app: FastifyInstance): void {
  app.get("/api/beatmap/cache/status", async () => cacheStatus());
  app.get("/api/beatmap/cache", async (req) => cacheGet(req));
  app.post("/api/beatmap/cache", cachePost);
  log.info("beatmap_registered", { routes: 3, dir: beatCacheStatus().dir });
}
