/**
 * 网易云发现首页（C5-1）。行为保真下沉 gateway.cjs 的 handleDiscoverHome：未登录回 starter；登录则
 * Promise.allSettled 并发拉「推荐歌单 / 热门播客 / 私人推荐 / 每日歌曲」四源，单源失败不拖垮整体。
 * 映射复用 netease/mappers（已单测）；NCM + getLoginInfo + cookie 可注入，便于单测不联网。
 *
 * 注：这是「忠实迁移」基线。LLM 增强发现（混合分层 + DJ 旁白）为后续独立增量，会另起 endpoint、可降级回落本基线。
 */

import { neteaseApi, currentCookie, getLoginInfo as bridgeGetLoginInfo, type NeteaseApi } from "./client.js";
import { mapSongRecord, mapDiscoverPlaylist, mapPodcastRadio, isLowSignalPodcastItem } from "./mappers.js";

export async function handleDiscoverHome(
  api: NeteaseApi = neteaseApi(),
  getLoginInfoFn: () => Promise<any> = bridgeGetLoginInfo,
  cookie: string = currentCookie(),
): Promise<Record<string, any>> {
  const info = await getLoginInfoFn();
  const loggedIn = !!(info && info.loggedIn);
  if (!loggedIn) {
    return { loggedIn: false, user: null, dailySongs: [], playlists: [], podcasts: [], mode: "starter", updatedAt: Date.now() };
  }

  const result = await Promise.allSettled([
    api.personalized({ limit: 8, cookie, timestamp: Date.now() }),
    api.dj_hot({ limit: 6, offset: 0, cookie, timestamp: Date.now() }),
    api.recommend_resource({ cookie, timestamp: Date.now() }),
    api.recommend_songs({ cookie, timestamp: Date.now() }),
  ]);

  const personalizedBody = (result[0].status === "fulfilled" && result[0].value && result[0].value.body) || {};
  const publicPlaylists = ((personalizedBody.result || personalizedBody.data || []) as any[])
    .map((pl) => mapDiscoverPlaylist(pl, "推荐歌单"))
    .filter((pl) => pl.id && pl.name)
    .slice(0, 8);

  const podcastBody = (result[1].status === "fulfilled" && result[1].value && result[1].value.body) || {};
  const podcastRaw = podcastBody.djRadios || podcastBody.djradios || podcastBody.radios || podcastBody.data || [];
  const podcasts = (Array.isArray(podcastRaw) ? podcastRaw : [])
    .map(mapPodcastRadio)
    .filter((p) => p.id && !isLowSignalPodcastItem(p))
    .slice(0, 6);

  let privatePlaylists: any[] = [];
  if (result[2].status === "fulfilled" && result[2].value) {
    const body = result[2].value.body || {};
    const raw = body.recommend || body.data || [];
    privatePlaylists = (Array.isArray(raw) ? raw : [])
      .map((pl) => mapDiscoverPlaylist(pl, "私人推荐"))
      .filter((pl) => pl.id && pl.name)
      .slice(0, 6);
  }

  let dailySongs: any[] = [];
  if (result[3].status === "fulfilled" && result[3].value) {
    const body = result[3].value.body || {};
    const raw = (body.data && (body.data.dailySongs || body.data.recommend)) || body.recommend || [];
    dailySongs = (Array.isArray(raw) ? raw : [])
      .map(mapSongRecord)
      .filter((song) => song.id && song.name)
      .slice(0, 12);
  }

  return {
    loggedIn,
    user: { userId: info.userId, nickname: info.nickname || "", avatar: info.avatar || "" },
    dailySongs,
    playlists: privatePlaylists.concat(publicPlaylists).slice(0, 10),
    podcasts,
    updatedAt: Date.now(),
  };
}
