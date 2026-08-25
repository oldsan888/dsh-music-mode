import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendJson } from "./shared.js";
import {
  getQQLoginInfo,
  handleQQSearch,
  handleQQSongUrl,
  handleQQLyric,
  handleQQSongComments,
  handleQQArtistDetail,
  handleQQUserPlaylists,
  handleQQPlaylistTracks,
} from "../music/qq/service.js";
import { qqLoginByCookie, qqLogout } from "../music/qq/login.js";
import { config } from "../config.js";
import { createLogger } from "../logger.js";

/**
 * QQ 音乐只读路由（M2-C C4c-2）：搜索/取址/歌词/评论/歌手/登录态/歌单。
 * 从 C1 桥接迁出为原生 TS（静态路由优先于保留的桥接 `/api/qq/*` 通配——登录写 `/api/qq/login/cookie`·`/api/qq/logout`
 * 仍走桥接，留 C4d）。取参 → 调 service → 回包，复刻 legacy sendJSON 的状态码/响应头/错误兜底。
 *
 * 注：`sendJson` 已下沉 routes/shared.ts 单一真相源；`query`（trivial 取 query 串）仍各自持有。
 */

const log = createLogger("music");

function query(req: FastifyRequest): Record<string, string> {
  return (req.query as Record<string, string>) || {};
}

async function searchRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const kw = query(req).keywords || "";
    const limit = Math.max(4, Math.min(12, parseInt(query(req).limit || "8", 10) || 8));
    sendJson(reply, { provider: "qq", songs: await handleQQSearch(kw, limit) });
  } catch (err) {
    log.error("qq_search_error", { error: (err as Error).message });
    sendJson(reply, { provider: "qq", error: (err as Error).message, songs: [] }, 500);
  }
}

async function songUrlRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const q = query(req);
    const mid = q.mid || q.id || "";
    const mediaMid = q.mediaMid || q.media_mid || "";
    const quality = q.quality || config.music.defaultQuality; // F12 默认音质兜底
    sendJson(reply, await handleQQSongUrl(mid, mediaMid, quality));
  } catch (err) {
    log.error("qq_song_url_error", { error: (err as Error).message });
    sendJson(reply, { provider: "qq", url: "", playable: false, error: (err as Error).message }, 500);
  }
}

async function lyricRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const q = query(req);
    const mid = q.mid || q.songmid || "";
    const id = q.id || q.qqId || "";
    if (!mid && !id) return sendJson(reply, { provider: "qq", error: "Missing QQ song mid or id", lyric: "" }, 400);
    sendJson(reply, await handleQQLyric(mid, id));
  } catch (err) {
    log.error("qq_lyric_error", { error: (err as Error).message });
    sendJson(reply, { provider: "qq", error: (err as Error).message, lyric: "" }, 500);
  }
}

async function loginStatusRoute(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    sendJson(reply, await getQQLoginInfo());
  } catch (err) {
    log.error("qq_login_status_error", { error: (err as Error).message });
    sendJson(reply, { provider: "qq", loggedIn: false, error: (err as Error).message }, 500);
  }
}

async function userPlaylistsRoute(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    sendJson(reply, await handleQQUserPlaylists());
  } catch (err) {
    log.error("qq_user_playlists_error", { error: (err as Error).message });
    sendJson(reply, { provider: "qq", loggedIn: false, error: (err as Error).message, playlists: [] }, 500);
  }
}

async function playlistTracksRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const id = query(req).id || query(req).disstid || "";
    sendJson(reply, await handleQQPlaylistTracks(id));
  } catch (err) {
    log.error("qq_playlist_tracks_error", { error: (err as Error).message });
    sendJson(reply, { provider: "qq", error: (err as Error).message, tracks: [] }, 500);
  }
}

async function artistDetailRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const mid = query(req).mid || query(req).singermid || "";
    const limit = Math.max(10, Math.min(80, parseInt(query(req).limit || "36", 10) || 36));
    if (!mid) return sendJson(reply, { provider: "qq", error: "MISSING_SINGER_MID", artist: null, songs: [] }, 400);
    sendJson(reply, await handleQQArtistDetail(mid, limit));
  } catch (err) {
    log.error("qq_artist_detail_error", { error: (err as Error).message });
    sendJson(reply, { provider: "qq", error: (err as Error).message, artist: null, songs: [] }, 500);
  }
}

async function songCommentsRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const q = query(req);
    const id = q.id || q.qqId || "";
    const mid = q.mid || q.songmid || "";
    const limit = Math.max(6, Math.min(50, parseInt(q.limit || "20", 10) || 20));
    const offset = Math.max(0, parseInt(q.offset || "0", 10) || 0);
    sendJson(reply, await handleQQSongComments(id, mid, limit, offset));
  } catch (err) {
    log.error("qq_song_comments_error", { error: (err as Error).message });
    sendJson(reply, { provider: "qq", error: (err as Error).message, comments: [] }, 500);
  }
}

async function loginCookieRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const raw = body.cookie || body.data || body.text || "";
    const r = await qqLoginByCookie(raw);
    sendJson(reply, r.payload, r.statusCode);
  } catch (err) {
    log.error("qq_login_cookie_error", { error: (err as Error).message });
    sendJson(reply, { provider: "qq", loggedIn: false, error: (err as Error).message }, 500);
  }
}

function logoutRoute(_req: FastifyRequest, reply: FastifyReply): void {
  try {
    sendJson(reply, qqLogout());
  } catch (err) {
    log.error("qq_logout_error", { error: (err as Error).message });
    sendJson(reply, { provider: "qq", loggedIn: false, error: (err as Error).message }, 500);
  }
}

/** 注册 QQ 只读路由 + 登录写（C4d-1）。须在 app.listen 之前、桥接之前调用。 */
export function registerQQ(app: FastifyInstance): void {
  app.get("/api/qq/search", searchRoute);
  app.get("/api/qq/song/url", songUrlRoute);
  app.get("/api/qq/lyric", lyricRoute);
  app.get("/api/qq/login/status", loginStatusRoute);
  app.get("/api/qq/user/playlists", userPlaylistsRoute);
  app.get("/api/qq/playlist/tracks", playlistTracksRoute);
  app.get("/api/qq/artist/detail", artistDetailRoute);
  app.get("/api/qq/song/comments", songCommentsRoute);
  // C4d-1 登录写（POST cookie + 登出）
  app.post("/api/qq/login/cookie", loginCookieRoute);
  app.post("/api/qq/logout", logoutRoute);
  log.info("qq_registered", { routes: 10, mode: "ts(C4c-2/C4d-1)" });
}
