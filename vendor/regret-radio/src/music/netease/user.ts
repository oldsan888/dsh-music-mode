/**
 * 网易云用户库只读 service（C6-3a）：用户歌单列表（user/playlists）+ 红心查询（song/like/check）。
 * 行为保真下沉 legacy/gateway.cjs 对应 handler；登录态经 getLoginInfo、cookie 经 currentCookie——均可注入，
 * 单测注入假 NCM/登录态、不联网。未登录处理：user/playlists 回 {loggedIn:false} 空列表（200，路由层）；
 * song/like/check 由路由层映射为 401（复刻 legacy requireLogin）。
 */

import { neteaseApi, currentCookie, getLoginInfo as bridgeGetLoginInfo, type NeteaseApi } from "./client.js";
import type { NeteaseLoginInfo } from "./login-normalize.js";
import { createLogger } from "../../logger.js";

const log = createLogger("music");

export interface UserPlaylistSummary {
  id: unknown;
  name: unknown;
  cover: string;
  trackCount: number;
  playCount: number;
  creator: string;
  subscribed: boolean;
  specialType: number;
}

/** 用户歌单列表（user_playlist）。limit clamp 到 [12,100]，逐字沿用 legacy。 */
export async function handleUserPlaylists(
  limit = 60,
  api: NeteaseApi = neteaseApi(),
  getLoginInfoFn: () => Promise<NeteaseLoginInfo> = bridgeGetLoginInfo,
  cookie: string = currentCookie(),
): Promise<{ loggedIn: boolean; userId?: unknown; playlists: UserPlaylistSummary[] }> {
  const info = await getLoginInfoFn();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, playlists: [] };
  const lim = Math.max(12, Math.min(100, Number(limit) || 60));
  const r = await api.user_playlist({ uid: info.userId, limit: lim, cookie, timestamp: Date.now() });
  const playlists: UserPlaylistSummary[] = (((r.body && r.body.playlist) || []) as any[]).map((pl) => ({
    id: pl.id,
    name: pl.name,
    cover: pl.coverImgUrl || "",
    trackCount: pl.trackCount || 0,
    playCount: pl.playCount || 0,
    creator: (pl.creator && pl.creator.nickname) || "",
    subscribed: !!pl.subscribed,
    specialType: pl.specialType || 0,
  }));
  return { loggedIn: true, userId: info.userId, playlists };
}

/**
 * 红心查询（song_like_check 直查 → 失败/空回退 likelist）。ids 为已解析的字符串数组。
 * 未登录 → {loggedIn:false}（路由层据此 401）；ids 空 → {loggedIn:true, liked:{}}（路由层据此 400）。
 */
export async function handleLikeCheck(
  ids: string[],
  api: NeteaseApi = neteaseApi(),
  getLoginInfoFn: () => Promise<NeteaseLoginInfo> = bridgeGetLoginInfo,
  cookie: string = currentCookie(),
): Promise<{ loggedIn: boolean; ids: string[]; liked: Record<string, boolean> }> {
  const info = await getLoginInfoFn();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, ids: [], liked: {} };
  if (!ids.length) return { loggedIn: true, ids: [], liked: {} };

  let likedIds: string[] = [];
  try {
    if (typeof api.song_like_check === "function") {
      const checked = await api.song_like_check({ ids: JSON.stringify(ids.map(Number).filter(Boolean)), cookie, timestamp: Date.now() });
      const data = (checked.body && (checked.body.data || checked.body.ids)) || checked.body || {};
      if (Array.isArray(data)) likedIds = data.map(String);
      else if (data && typeof data === "object") {
        ids.forEach((id) => {
          if (data[id] || data[String(id)] || data[Number(id)]) likedIds.push(String(id));
        });
      }
    }
  } catch (e) {
    log.warn("like_check_direct_failed", { error: (e as Error).message });
  }
  if (!likedIds.length) {
    const r = await api.likelist({ uid: info.userId, cookie, timestamp: Date.now() });
    likedIds = (((r.body && r.body.ids) || []) as any[]).map(String);
  }
  const set = new Set(likedIds);
  const liked: Record<string, boolean> = {};
  ids.forEach((id) => {
    liked[id] = set.has(String(id));
  });
  return { loggedIn: true, ids, liked };
}
