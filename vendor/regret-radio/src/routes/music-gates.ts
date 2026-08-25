import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { createLogger } from "../logger.js";

/**
 * F9 · 音源开关（C4d-3）。一个全局 onRequest 钩子：当某音源被 config 禁用时，短路其路由返回 disabled。
 * 钩子先于路由执行，故同时覆盖「已 TS 化」与「仍桥接」的该源路由（无遗漏）。weather/discover 不属音源，不受影响。
 */

const log = createLogger("music");

/** 网易云音源涵盖的路由前缀（含登录；不含 weather/discover——它们独立于音源开关）。 */
const NETEASE_PREFIXES = [
  "/api/search",
  "/api/lyric",
  "/api/song/",
  "/api/artist/",
  "/api/playlist/",
  "/api/podcast/",
  "/api/login",
  "/api/logout",
];

/** 判定该 URL 是否落在「已禁用音源」名下；是则回源名，否则 null。纯函数，可单测。 */
export function disabledSourceFor(url: string, flags: { neteaseEnabled: boolean; qqEnabled: boolean }): "qq" | "netease" | null {
  const u = (url || "").split("?")[0];
  if (!flags.qqEnabled && u.startsWith("/api/qq/")) return "qq";
  if (!flags.neteaseEnabled && NETEASE_PREFIXES.some((p) => u.startsWith(p))) return "netease";
  return null;
}

/** 注册音源开关钩子。须在 app.listen 之前调用（onRequest 全局，对所有音乐路由生效）。 */
export function registerMusicSourceGates(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    const src = disabledSourceFor(req.url, config.music);
    if (!src) return;
    reply
      .code(200)
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store")
      .type("application/json; charset=utf-8")
      .send({ provider: src, disabled: true, error: src.toUpperCase() + "_SOURCE_DISABLED", songs: [], tracks: [], comments: [], playlists: [] });
  });
  log.info("music_source_gates", { netease: config.music.neteaseEnabled, qq: config.music.qqEnabled });
}
