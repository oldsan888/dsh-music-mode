/**
 * 网易云账号写 service（C6-3b）：红心/取消红心（song/like）、建歌单（playlist/create）、收藏歌曲到歌单
 * （playlist/add-song：playlist_tracks op=add 主接口 → 失败回退 playlist_track_add）。行为保真下沉 legacy
 * gateway.cjs 对应 handler。NCM/登录态/cookie 可注入，单测注入假 NCM、不碰真账号。
 *
 * 未登录处理交路由层映射为 401（复刻 legacy requireLogin）；缺参由路由层映射 400。
 * 注：NCM 红心导出名为 `like`（gateway 内别名 like_song）。
 */

import { neteaseApi, currentCookie, getLoginInfo as bridgeGetLoginInfo, type NeteaseApi } from "./client.js";
import type { NeteaseLoginInfo } from "./login-normalize.js";
import { normalizeApiCode, normalizeApiMessage } from "../util/format.js";

type GetLogin = () => Promise<NeteaseLoginInfo>;

/** 红心 / 取消红心。like 为布尔，下发 NCM 时转字符串 "true"/"false"（逐字沿用 legacy）。 */
export async function handleLikeSong(
  id: string,
  like: boolean,
  api: NeteaseApi = neteaseApi(),
  getLoginInfoFn: GetLogin = bridgeGetLoginInfo,
  cookie: string = currentCookie(),
): Promise<{ loggedIn: boolean; id?: string; liked?: boolean; code?: number; body?: any }> {
  const info = await getLoginInfoFn();
  if (!info.loggedIn || !info.userId) return { loggedIn: false };
  if (!id) return { loggedIn: true };
  const r = await api.like({ id, like: String(like), cookie, timestamp: Date.now() });
  const code = (r.body && r.body.code) || r.code || 200;
  return { loggedIn: true, id, liked: like, code, body: r.body || r };
}

/** 建歌单。privacy 默认 "0"（公开），"10" 为隐私。取 body.playlist || body.data。 */
export async function handleCreatePlaylist(
  name: string,
  privacy: string,
  api: NeteaseApi = neteaseApi(),
  getLoginInfoFn: GetLogin = bridgeGetLoginInfo,
  cookie: string = currentCookie(),
): Promise<{ loggedIn: boolean; playlist?: any; body?: any }> {
  const info = await getLoginInfoFn();
  if (!info.loggedIn || !info.userId) return { loggedIn: false };
  if (!name) return { loggedIn: true };
  const r = await api.playlist_create({ name, privacy, cookie, timestamp: Date.now() });
  const created = (r.body && (r.body.playlist || r.body.data)) || {};
  return { loggedIn: true, playlist: created, body: r.body || r };
}

export interface AddSongResult {
  loggedIn: boolean;
  badRequest?: boolean;
  pid?: string;
  id?: string;
  success?: boolean;
  code?: number;
  message?: string;
  body?: any;
  attempts?: { api: string; code: number; message: string; body: any }[];
}

/** 收藏歌曲到歌单：playlist_tracks(op=add) 主接口 → 失败回退 playlist_track_add（逐字沿用 legacy 双尝试）。 */
export async function handleAddSongToPlaylist(
  pid: string,
  id: string,
  api: NeteaseApi = neteaseApi(),
  getLoginInfoFn: GetLogin = bridgeGetLoginInfo,
  cookie: string = currentCookie(),
): Promise<AddSongResult> {
  const info = await getLoginInfoFn();
  if (!info.loggedIn || !info.userId) return { loggedIn: false };
  if (!pid || !id) return { loggedIn: true, badRequest: true };

  const attempts: { api: string; code: number; message: string; body: any }[] = [];
  let finalBody: any = null;
  let finalCode = 0;
  let finalMessage = "";
  let success = false;

  const primary = await api.playlist_tracks({ op: "add", pid, tracks: String(id), cookie, timestamp: Date.now() });
  finalBody = primary.body || primary;
  finalCode = normalizeApiCode(primary);
  finalMessage = normalizeApiMessage(primary);
  success = finalCode === 200 && !(finalBody && finalBody.error);
  attempts.push({ api: "playlist_tracks", code: finalCode, message: finalMessage, body: finalBody });

  if (!success && typeof api.playlist_track_add === "function") {
    try {
      const fallback = await api.playlist_track_add({ pid, ids: String(id), cookie, timestamp: Date.now() });
      finalBody = fallback.body || fallback;
      finalCode = normalizeApiCode(fallback);
      finalMessage = normalizeApiMessage(fallback);
      success = finalCode === 200 && !(finalBody && finalBody.error);
      attempts.push({ api: "playlist_track_add", code: finalCode, message: finalMessage, body: finalBody });
    } catch (fallbackErr) {
      const errBody = (fallbackErr as any).body || (fallbackErr as any).response || {};
      finalBody = errBody;
      finalCode = normalizeApiCode(errBody);
      finalMessage = normalizeApiMessage(errBody) || (fallbackErr as Error).message || "";
      attempts.push({ api: "playlist_track_add", code: finalCode, message: finalMessage, body: errBody });
    }
  }

  return { loggedIn: true, pid, id, success, code: finalCode, message: finalMessage, body: finalBody, attempts };
}
