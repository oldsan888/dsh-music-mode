import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendJson } from "./shared.js";
import { analyzePodcastDjStream, analyzePodcastDjIntro } from "../music/dj/analyzer.js";
import { isAllowedMediaProxyUrl, isSafeResolvedMediaProxyUrl } from "../music/proxy.js";
import { config } from "../config.js";
import { createLogger } from "../logger.js";

/**
 * 播客 DJ 离线锁拍路由（M2-C C7-D6）：把 /api/podcast/dj-beatmap 从 C1 桥接（gateway.handle 唯一活路由）
 * 迁为原生 TS。DSP 走 music/dj/*（D1-D5，逐字对拍 CJS），SSRF 校验复用 music/proxy 的 isAllowedMediaProxyUrl
 * （真源白名单，比 gateway 副本更严）。intro>0 → 片头部分图；否则 → 整段/分窗自适应。userAgent 固定 config.music.userAgent。
 * C7-D7 后 C1 桥接（registerMusicGateway）已整体退役，本路由独立承接 /api/podcast/dj-beatmap。
 */

const log = createLogger("music");
const MAX_DURATION_SEC = 8 * 60 * 60;
const MAX_CONCURRENT_ANALYSES = 2;
let activeAnalyses = 0;

export function validDjDuration(value: unknown): number | null {
  const duration = Number(value || 0);
  return Number.isFinite(duration) && duration >= 0 && duration <= MAX_DURATION_SEC ? duration : null;
}

async function djBeatmapRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const q = (req.query as Record<string, string>) || {};
    const audioUrl = typeof q.url === "string" ? q.url : "";
    const durationSec = validDjDuration(q.duration);
    if (!audioUrl || durationSec === null || !isAllowedMediaProxyUrl(audioUrl) || !(await isSafeResolvedMediaProxyUrl(audioUrl))) {
      return sendJson(reply, { error: "Invalid audio url" }, 400);
    }
    if (activeAnalyses >= MAX_CONCURRENT_ANALYSES) return sendJson(reply, { error: "DJ_ANALYSIS_BUSY" }, 429);
    const introSec = Math.max(0, Number(q.intro || 0) || 0);
    const ua = config.music.userAgent;
    activeAnalyses++;
    let map;
    try {
      map = introSec
        ? await analyzePodcastDjIntro(audioUrl, { durationSec, introSec, userAgent: ua })
        : await analyzePodcastDjStream(audioUrl, { durationSec, userAgent: ua });
    } finally { activeAnalyses--; }
    sendJson(reply, { ok: true, map });
  } catch (err) {
    log.error("dj_beatmap_error", { error: (err as Error).message });
    sendJson(reply, { ok: false, error: (err as Error).message }, 500);
  }
}

/** 注册播客 DJ 锁拍路由（精确静态路由）。 */
export function registerDjBeatmap(app: FastifyInstance): void {
  app.get("/api/podcast/dj-beatmap", djBeatmapRoute);
  log.info("dj_beatmap_registered", { mode: "ts(C7-D6)" });
}
