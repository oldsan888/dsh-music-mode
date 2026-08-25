/**
 * 网易云只读检索 service（C4b-2）：搜索 / 歌词 / 评论 / 歌手 / 歌单曲目。
 * 行为保真下沉 legacy/gateway.cjs 的对应 handler，编排逻辑（封面兜底、歌词 new→old 回退、
 * 评论 hot 分支、歌手/歌单二级回退）逐字对照；映射复用 netease/mappers，纯逻辑已单测。
 *
 * NCM 可注入（默认取 neteaseApi()）、cookie 默认 currentCookie()——使本层可注入假 NCM 单测、不联网。
 */

import { neteaseApi, currentCookie, type NeteaseApi } from "./client.js";
import { mapSongRecord, type NeteaseSong } from "./mappers.js";
import { hasNeteaseSvip, type NeteaseLoginInfo } from "./login-normalize.js";
import { normalizeQualityPreference, qualityCandidatesFrom, NETEASE_QUALITY_CANDIDATES } from "../util/quality.js";
import { classifyNeteasePlaybackRestriction } from "../util/restriction.js";
import { createLogger } from "../../logger.js";

export type { NeteaseApi } from "./client.js";

const log = createLogger("music");

/** 搜索（cloudsearch）+ 对缺封面歌曲用 song_detail 批量兜底。 */
export async function handleSearch(
  keywords: string,
  limit: number,
  api: NeteaseApi = neteaseApi(),
  cookie: string = currentCookie(),
): Promise<NeteaseSong[]> {
  const result = await api.cloudsearch({ keywords, limit, cookie });
  const songs = result.body && result.body.result && result.body.result.songs ? result.body.result.songs : [];
  let mapped: NeteaseSong[] = songs.map((s: any) => mapSongRecord(s));

  const missing = mapped.filter((s) => !s.cover).map((s) => s.id);
  if (missing.length) {
    try {
      const dd = await api.song_detail({ ids: missing.join(","), cookie });
      const songsArr = (dd.body && dd.body.songs) || [];
      const idToPic: Record<string, string> = {};
      songsArr.forEach((s: any) => {
        const pic = (s.al && s.al.picUrl) || (s.album && s.album.picUrl) || "";
        if (pic) idToPic[s.id] = pic;
      });
      mapped = mapped.map((s) => (s.cover ? s : { ...s, cover: idToPic[String(s.id)] || "" }));
    } catch (e) {
      log.warn("search_backfill_failed", { error: (e as Error).message });
    }
  }
  return mapped;
}

/** 歌词：优先 lyric_new（逐字 yrc），无 lrc/yrc 时回退 lyric。 */
export async function handleLyric(
  id: string,
  api: NeteaseApi = neteaseApi(),
  cookie: string = currentCookie(),
): Promise<{ lyric: string; tlyric: string; yrc: string; source: string }> {
  let body: any = {};
  let source = "lyric";
  try {
    if (typeof api.lyric_new === "function") {
      const nr = await api.lyric_new({ id, cookie, timestamp: Date.now() });
      body = nr.body || {};
      source = "lyric_new";
    }
  } catch (errNew) {
    log.warn("lyric_new_failed", { error: (errNew as Error).message });
  }
  if (!((body.lrc && body.lrc.lyric) || (body.yrc && body.yrc.lyric))) {
    const r = await api.lyric({ id, cookie, timestamp: Date.now() });
    body = r.body || body || {};
    source = "lyric";
  }
  return {
    lyric: (body.lrc && body.lrc.lyric) || "",
    tlyric: (body.tlyric && body.tlyric.lyric) || "",
    yrc: (body.yrc && body.yrc.lyric) || "",
    source,
  };
}

/** 歌曲评论：offset=0 优先热门评论，否则普通评论；过滤空内容。 */
export async function handleSongComments(
  id: string,
  limit: number,
  offset: number,
  api: NeteaseApi = neteaseApi(),
  cookie: string = currentCookie(),
): Promise<{ id: string; total: number; comments: any[]; hot: boolean; body: any }> {
  const r = await api.comment_music({ id, limit, offset, cookie, timestamp: Date.now() });
  const body = r.body || r || {};
  const raw = body.hotComments && offset === 0 ? body.hotComments : body.comments || [];
  const comments = (raw || [])
    .map((c: any) => ({
      id: c.commentId,
      content: c.content || "",
      likedCount: c.likedCount || 0,
      time: c.time || 0,
      user: c.user ? { id: c.user.userId, nickname: c.user.nickname || "", avatar: c.user.avatarUrl || "" } : null,
    }))
    .filter((c: { content: string }) => c.content);
  return { id, total: body.total || 0, comments, hot: !!(body.hotComments && offset === 0), body };
}

/** 歌手主页：详情 + 热门歌曲（artist_songs hot，空则回退 artist_top_song）。 */
export async function handleArtistDetail(
  id: string,
  limit: number,
  api: NeteaseApi = neteaseApi(),
  cookie: string = currentCookie(),
): Promise<{ id: string; artist: Record<string, unknown>; songs: NeteaseSong[]; body: any }> {
  let detailBody: any = {};
  try {
    const detail = await api.artist_detail({ id, cookie, timestamp: Date.now() });
    detailBody = detail.body || detail || {};
  } catch (e) {
    log.warn("artist_detail_failed", { error: (e as Error).message });
  }
  let rawSongs: any[] = [];
  try {
    const list = await api.artist_songs({ id, order: "hot", limit, offset: 0, cookie, timestamp: Date.now() });
    const b = list.body || list || {};
    rawSongs = b.songs || (b.data && b.data.songs) || [];
  } catch (e) {
    log.warn("artist_songs_failed", { error: (e as Error).message });
  }
  if (!rawSongs.length) {
    const top = await api.artist_top_song({ id, cookie, timestamp: Date.now() });
    const b = top.body || top || {};
    rawSongs = b.songs || [];
  }
  const artist = detailBody.artist || (detailBody.data && (detailBody.data.artist || detailBody.data)) || {};
  const songs = rawSongs.map(mapSongRecord).filter((s) => s.id).slice(0, limit);
  return {
    id,
    artist: {
      id: artist.id || id,
      name: artist.name || artist.artistName || "",
      avatar: artist.avatar || artist.cover || artist.picUrl || artist.img1v1Url || "",
      brief: artist.briefDesc || artist.description || artist.desc || "",
      musicSize: artist.musicSize || artist.songSize || 0,
      albumSize: artist.albumSize || 0,
    },
    songs,
    body: detailBody,
  };
}

/** 歌单曲目：优先 playlist_track_all（全量），空则回退 playlist_detail（带歌单 meta）。 */
export async function handlePlaylistTracks(
  id: string,
  api: NeteaseApi = neteaseApi(),
  cookie: string = currentCookie(),
): Promise<{ playlist: { id: string; name: string; cover: string; trackCount: number }; tracks: NeteaseSong[] }> {
  let playlistMeta = { id, name: "", cover: "", trackCount: 0 };
  let rawTracks: any[] = [];

  if (typeof api.playlist_track_all === "function") {
    try {
      const all = await api.playlist_track_all({ id, limit: 500, offset: 0, cookie, timestamp: Date.now() });
      rawTracks = (all.body && (all.body.songs || all.body.tracks)) || [];
    } catch (err) {
      log.warn("playlist_track_all_failed", { error: (err as Error).message });
    }
  }

  if (!rawTracks.length && typeof api.playlist_detail === "function") {
    const detail = await api.playlist_detail({ id, s: 0, cookie, timestamp: Date.now() });
    const pl = (detail.body && detail.body.playlist) || {};
    playlistMeta = { id: pl.id || id, name: pl.name || "", cover: pl.coverImgUrl || "", trackCount: pl.trackCount || 0 };
    rawTracks = pl.tracks || [];
  }

  const tracks = rawTracks.map(mapSongRecord).filter((t) => t.id);
  if (!playlistMeta.trackCount) playlistMeta.trackCount = tracks.length;
  return { playlist: playlistMeta, tracks };
}

/**
 * 取址：按音质从高到低探测（song_url_v1 优先，失败回退 song_url 的 br 接口）。
 * 命中完整 url 立即返回；仅有试听片段则记为兜底；全程失败则按 fee/code/登录态归类不可播原因。
 * svip 专属候选（jymaster）仅在登录态为 svip 时探测。
 */
export async function handleSongUrl(
  id: string,
  loginInfo: NeteaseLoginInfo,
  qualityPreference: string,
  api: NeteaseApi = neteaseApi(),
  cookie: string = currentCookie(),
): Promise<Record<string, unknown>> {
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const svipReady = hasNeteaseSvip(loginInfo);
  const qualities = qualityCandidatesFrom(requestedQuality, NETEASE_QUALITY_CANDIDATES).filter((q) => !q.svip || svipReady);

  let trialFallback: Record<string, unknown> | null = null;
  let lastData: any = null;
  let lastError: Error | null = null;

  for (const q of qualities) {
    try {
      let result: any;
      try {
        result = await api.song_url_v1({ id, level: q.level, cookie });
      } catch {
        result = await api.song_url({ id, br: q.br, cookie });
      }
      const d = result.body && result.body.data && result.body.data[0];
      if (d) lastData = d;
      const url = d && d.url;
      const freeTrial = d && d.freeTrialInfo;
      if (url && !freeTrial) {
        return { url, trial: false, playable: true, level: q.level, quality: q.label, br: d.br, requestedQuality };
      }
      if (url && freeTrial && !trialFallback) {
        trialFallback = {
          url,
          trial: true,
          playable: true,
          level: q.level,
          quality: q.label,
          br: d.br,
          requestedQuality,
          trialInfo: freeTrial,
          restriction: classifyNeteasePlaybackRestriction(d, loginInfo),
        };
      }
    } catch (err) {
      lastError = err as Error;
    }
  }
  if (trialFallback) return trialFallback;
  const restriction = classifyNeteasePlaybackRestriction(lastData, loginInfo);
  return {
    url: null,
    trial: false,
    playable: false,
    reason: restriction.category,
    message: restriction.message,
    restriction,
    lastCode: lastData && lastData.code,
    fee: lastData && lastData.fee,
    error: lastError && lastError.message,
    requestedQuality,
  };
}
