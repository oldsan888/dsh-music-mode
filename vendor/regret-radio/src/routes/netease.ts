import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendJson } from "./shared.js";
import {
  handleSearch,
  handleLyric,
  handleSongComments,
  handleArtistDetail,
  handlePlaylistTracks,
  handleSongUrl,
} from "../music/netease/service.js";
import {
  handlePodcastSearch,
  handlePodcastHot,
  handlePodcastDetail,
  handlePodcastPrograms,
  handleMyPodcast,
  handleMyPodcastItems,
} from "../music/netease/podcast.js";
import { handleUserPlaylists, handleLikeCheck } from "../music/netease/user.js";
import { handleLikeSong, handleCreatePlaylist, handleAddSongToPlaylist } from "../music/netease/write.js";
import { handleDiscoverHome } from "../music/netease/discover.js";
import { getLoginInfo } from "../music/netease/client.js";
import { loginByCookie, logout, qrKey, qrCreate, qrCheck, loginStatus } from "../music/netease/login.js";
import { config } from "../config.js";
import { createLogger } from "../logger.js";

/**
 * 网易云只读路由（M2-C C4b-2/3）：搜索 / 歌词 / 评论 / 歌手 / 歌单曲目（C4b-2）+ 取址 / 播客读（C4b-3）。
 * 从 C1 桥接迁出为原生 TS：取参 → 调 service → 回包，复刻 legacy sendJSON 的状态码/响应头/错误兜底。
 *
 * 与桥接通配共存：精确路由 /api/search、/api/lyric 已从桥接移除；/api/song/url·comments 与 /api/podcast/{search,
 * hot,detail,programs} 为静态路由，优先于保留的桥接 /api/song/*（song/like 仍桥接）与 /api/podcast/*（my、my/items、
 * dj-beatmap 仍桥接）——Fastify 静态优先已验证。取址需 live 登录态：经 netease/client 的 getLoginInfo/currentCookie
 * 读 gateway 模块态（C4b 过渡，cookie 写副作用留 CJS）。
 */

const log = createLogger("music");

function query(req: FastifyRequest): Record<string, string> {
  return (req.query as Record<string, string>) || {};
}

async function searchRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const kw = query(req).keywords || "";
    const limit = parseInt(query(req).limit || "20", 10);
    sendJson(reply, { songs: await handleSearch(kw, limit) });
  } catch (err) {
    log.error("search_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message, songs: [] }, 500);
  }
}

async function lyricRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const id = query(req).id;
    if (!id) return sendJson(reply, { error: "Missing song id", lyric: "" }, 400);
    sendJson(reply, await handleLyric(id));
  } catch (err) {
    log.error("lyric_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message, lyric: "" }, 500);
  }
}

async function commentsRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const id = query(req).id;
    const limit = Math.max(6, Math.min(50, parseInt(query(req).limit || "20", 10) || 20));
    const offset = Math.max(0, parseInt(query(req).offset || "0", 10) || 0);
    if (!id) return sendJson(reply, { error: "Missing song id", comments: [] }, 400);
    sendJson(reply, await handleSongComments(id, limit, offset));
  } catch (err) {
    log.error("comments_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message, comments: [] }, 500);
  }
}

async function artistRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const id = query(req).id;
    const limit = Math.max(10, Math.min(80, parseInt(query(req).limit || "30", 10) || 30));
    if (!id) return sendJson(reply, { error: "Missing artist id", songs: [] }, 400);
    sendJson(reply, await handleArtistDetail(id, limit));
  } catch (err) {
    log.error("artist_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message, songs: [] }, 500);
  }
}

async function playlistTracksRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const id = query(req).id;
    if (!id) return sendJson(reply, { error: "Missing playlist id", tracks: [] }, 400);
    sendJson(reply, await handlePlaylistTracks(id));
  } catch (err) {
    log.error("playlist_tracks_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message, tracks: [] }, 500);
  }
}

async function songUrlRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const sid = query(req).id;
    const quality = query(req).quality || config.music.defaultQuality; // F12 默认音质兜底
    const loginInfo = await getLoginInfo();
    const info = await handleSongUrl(sid, loginInfo, quality);
    sendJson(reply, {
      ...info,
      loggedIn: loginInfo.loggedIn,
      vipType: loginInfo.vipType || 0,
      vipLevel: loginInfo.vipLevel || "none",
      isVip: !!loginInfo.isVip,
      isSvip: !!loginInfo.isSvip,
      vipLabel: loginInfo.vipLabel || "无VIP",
    });
  } catch (err) {
    log.error("song_url_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message }, 500);
  }
}

async function podcastSearchRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const kw = (query(req).keywords || "").trim();
    const limit = Math.max(6, Math.min(30, parseInt(query(req).limit || "18", 10) || 18));
    if (!kw) return sendJson(reply, { podcasts: [] });
    sendJson(reply, await handlePodcastSearch(kw, limit));
  } catch (err) {
    log.error("podcast_search_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message, podcasts: [] }, 500);
  }
}

async function podcastHotRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const limit = Math.max(6, Math.min(30, parseInt(query(req).limit || "18", 10) || 18));
    const offset = Math.max(0, parseInt(query(req).offset || "0", 10) || 0);
    sendJson(reply, await handlePodcastHot(limit, offset));
  } catch (err) {
    log.error("podcast_hot_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message, podcasts: [] }, 500);
  }
}

async function podcastDetailRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const rid = query(req).id || query(req).rid;
    if (!rid) return sendJson(reply, { error: "Missing podcast id" }, 400);
    sendJson(reply, await handlePodcastDetail(rid));
  } catch (err) {
    log.error("podcast_detail_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message }, 500);
  }
}

async function podcastProgramsRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const rid = query(req).id || query(req).rid;
    if (!rid) return sendJson(reply, { error: "Missing podcast id", programs: [] }, 400);
    const limit = Math.max(10, Math.min(60, parseInt(query(req).limit || "30", 10) || 30));
    const offset = Math.max(0, parseInt(query(req).offset || "0", 10) || 0);
    sendJson(reply, await handlePodcastPrograms(rid, limit, offset));
  } catch (err) {
    log.error("podcast_programs_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message, programs: [] }, 500);
  }
}

async function loginCookieRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const raw = body.cookie || body.data || body.text || "";
    const r = await loginByCookie(raw);
    sendJson(reply, r.payload, r.statusCode);
  } catch (err) {
    log.error("login_cookie_error", { error: (err as Error).message });
    sendJson(reply, { loggedIn: false, error: (err as Error).message }, 500);
  }
}

async function logoutRoute(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    sendJson(reply, await logout());
  } catch (err) {
    log.error("logout_error", { error: (err as Error).message });
    sendJson(reply, { loggedIn: false, error: (err as Error).message }, 500);
  }
}

async function qrKeyRoute(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    sendJson(reply, await qrKey());
  } catch (err) {
    log.error("qr_key_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message }, 500);
  }
}

async function qrCreateRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    sendJson(reply, await qrCreate(query(req).key || ""));
  } catch (err) {
    log.error("qr_create_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message }, 500);
  }
}

async function qrCheckRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    sendJson(reply, await qrCheck(query(req).key || ""));
  } catch (err) {
    log.error("qr_check_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message }, 500);
  }
}

async function loginStatusRoute(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    sendJson(reply, await loginStatus());
  } catch (err) {
    log.error("login_status_error", { error: (err as Error).message });
    sendJson(reply, { loggedIn: false, error: (err as Error).message }, 500);
  }
}

async function discoverHomeRoute(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    sendJson(reply, await handleDiscoverHome());
  } catch (err) {
    log.error("discover_home_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message, loggedIn: false, dailySongs: [], playlists: [], podcasts: [] }, 500);
  }
}

// ---------- C6-3a 用户库 / 我的播客（登录态读）----------

async function userPlaylistsRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const limit = parseInt(query(req).limit || "60", 10);
    sendJson(reply, await handleUserPlaylists(limit));
  } catch (err) {
    log.error("user_playlists_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message, loggedIn: false, playlists: [] }, 500);
  }
}

async function likeCheckRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const idsRaw = query(req).ids || query(req).id || "";
    const ids = idsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const r = await handleLikeCheck(ids);
    // 复刻 legacy requireLogin：未登录 401 先于 ids 空 400。
    if (!r.loggedIn) return sendJson(reply, { error: "LOGIN_REQUIRED", loggedIn: false }, 401);
    if (!ids.length) return sendJson(reply, { error: "Missing song id", liked: {}, ids: [] }, 400);
    sendJson(reply, r);
  } catch (err) {
    log.error("like_check_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message }, 500);
  }
}

async function myPodcastRoute(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    sendJson(reply, await handleMyPodcast());
  } catch (err) {
    log.error("my_podcast_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message, collections: [] }, 500);
  }
}

async function myPodcastItemsRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const q = query(req);
    const key = q.key || "collect";
    const limit = parseInt(q.limit || "36", 10) || 36;
    const offset = parseInt(q.offset || "0", 10) || 0;
    sendJson(reply, await handleMyPodcastItems(key, limit, offset));
  } catch (err) {
    log.error("my_podcast_items_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message, items: [] }, 500);
  }
}

// ---------- C6-3b 账号写（红心 / 建歌单 / 收藏歌曲）；GET+POST 双方法，body 优先于 query（复刻 legacy）----------

async function likeRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const body = (req.body as any) || {};
    const q = (req.query as any) || {};
    const idRaw = body.id || q.id;
    const id = idRaw ? String(idRaw) : "";
    const like = String(body.like != null ? body.like : q.like || "true") !== "false";
    const r = await handleLikeSong(id, like);
    if (!r.loggedIn) return sendJson(reply, { error: "LOGIN_REQUIRED", loggedIn: false }, 401);
    if (!id) return sendJson(reply, { error: "Missing song id" }, 400);
    sendJson(reply, r);
  } catch (err) {
    log.error("like_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message }, 500);
  }
}

async function playlistCreateRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const body = (req.body as any) || {};
    const q = (req.query as any) || {};
    const name = String(body.name || q.name || "").trim();
    const privacy = String(body.privacy || q.privacy || "0");
    const r = await handleCreatePlaylist(name, privacy);
    if (!r.loggedIn) return sendJson(reply, { error: "LOGIN_REQUIRED", loggedIn: false }, 401);
    if (!name) return sendJson(reply, { error: "Missing playlist name" }, 400);
    sendJson(reply, r);
  } catch (err) {
    log.error("playlist_create_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message }, 500);
  }
}

async function playlistAddSongRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const body = (req.body as any) || {};
    const q = (req.query as any) || {};
    const pidRaw = body.pid || q.pid;
    const idRaw = body.id || body.ids || q.id || q.ids;
    const pid = pidRaw ? String(pidRaw) : "";
    const id = idRaw ? String(idRaw) : "";
    const r = await handleAddSongToPlaylist(pid, id);
    if (!r.loggedIn) return sendJson(reply, { error: "LOGIN_REQUIRED", loggedIn: false }, 401);
    if (r.badRequest) return sendJson(reply, { error: "Missing playlist id or song id" }, 400);
    if (!r.success) {
      return sendJson(
        reply,
        { loggedIn: true, pid: r.pid, id: r.id, success: false, code: r.code, error: r.message || "PLAYLIST_ADD_FAILED", attempts: r.attempts },
        r.code === 401 ? 401 : 409,
      );
    }
    sendJson(reply, { loggedIn: true, pid: r.pid, id: r.id, success: true, code: r.code, body: r.body, attempts: r.attempts });
  } catch (err) {
    log.error("playlist_add_song_error", { error: (err as Error).message });
    sendJson(reply, { error: (err as Error).message }, 500);
  }
}

/** 注册网易云路由（检索 + 取址 + 播客读 + 发现/AI + 用户库/我的播客 + 账号写）+ 登录（写 + 扫码 + 状态）。须在 app.listen 之前、桥接之前调用。 */
export function registerNetease(app: FastifyInstance): void {
  // C4b-2 检索类
  app.get("/api/search", searchRoute);
  app.get("/api/lyric", lyricRoute);
  app.get("/api/song/comments", commentsRoute);
  app.get("/api/artist/detail", artistRoute);
  app.get("/api/playlist/tracks", playlistTracksRoute);
  // C4b-3 取址 + 播客读（静态路由，优先于保留的桥接 /api/song/*、/api/podcast/* 通配）
  app.get("/api/song/url", songUrlRoute);
  app.get("/api/podcast/search", podcastSearchRoute);
  app.get("/api/podcast/hot", podcastHotRoute);
  app.get("/api/podcast/detail", podcastDetailRoute);
  app.get("/api/podcast/programs", podcastProgramsRoute);
  // C5-1 发现首页（忠实迁移基线）。
  app.get("/api/discover/home", discoverHomeRoute);
  // C4d-1 登录写（POST cookie + 登出）。POST 由 Fastify 原生 body 解析，绕过桥接 raw 流冲突。
  app.post("/api/login/cookie", loginCookieRoute);
  app.post("/api/logout", logoutRoute);
  // C4d-2 扫码登录 + 登录态查询
  app.get("/api/login/qr/key", qrKeyRoute);
  app.get("/api/login/qr/create", qrCreateRoute);
  app.get("/api/login/qr/check", qrCheckRoute);
  app.get("/api/login/status", loginStatusRoute);
  // C6-3a 用户库 / 我的播客（登录态读；静态路由优先于保留的桥接 /api/song/*、/api/podcast/* 通配）
  app.get("/api/user/playlists", userPlaylistsRoute);
  app.get("/api/song/like/check", likeCheckRoute);
  app.get("/api/podcast/my", myPodcastRoute);
  app.get("/api/podcast/my/items", myPodcastItemsRoute);
  // C6-3b 账号写（GET+POST；静态路由优先，迁后 /api/song/* 已从桥接移除）
  app.post("/api/song/like", likeRoute);
  app.post("/api/playlist/create", playlistCreateRoute);
  app.post("/api/playlist/add-song", playlistAddSongRoute);
  log.info("netease_registered", { routes: 25, mode: "ts(C4b/C4d/C5/C6-3)" });
}
