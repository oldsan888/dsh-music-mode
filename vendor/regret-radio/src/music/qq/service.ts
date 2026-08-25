/**
 * QQ 音乐 service（C4c-2）：登录态 / 搜索 / 取址 / 歌词 / 评论 / 歌手 / 歌单。
 * 行为保真下沉 legacy/gateway.cjs；HTTP 经可注入 QQHttp（默认 qqHttp），便于单测对拍 cookie 方向。
 * 映射/解析复用 qq/cookie·mappers（已单测）+ util/quality·restriction。
 */

import { qqHttp, QQ_SMARTBOX_URL, type QQHttp } from "./client.js";
import { parseCookieString } from "../util/cookie.js";
import { qqCookieUin, qqCookieMusicKey, qqCookiePlaybackKey, normalizeQQProfile } from "./cookie.js";
import {
  mapQQSmartSong,
  mapQQTrack,
  mapQQPlaylist,
  mapQQPlaylistTrack,
  mapQQComment,
  qqSingerAvatar,
  isQQFavoritePlaylist,
  isQzoneBackgroundPlaylist,
  decodeQQLyricText,
  normalizeQQSongId,
} from "./mappers.js";
import { normalizeQualityPreference, qualityCandidatesFrom, QQ_QUALITY_CANDIDATE_TEMPLATES } from "../util/quality.js";
import { classifyQQPlaybackRestriction } from "../util/restriction.js";
import { createLogger } from "../../logger.js";

export type { QQHttp } from "./client.js";

const log = createLogger("music");

/** 智能搜索（smartbox）——匿名（getJSON cookie:false）。 */
async function qqSmartboxSearch(keywords: string, limit: number, http: QQHttp): Promise<any[]> {
  const json = await http.getJSON(
    QQ_SMARTBOX_URL,
    { format: "json", key: keywords, g_tk: "5381", loginUin: "0", hostUin: "0", inCharset: "utf8", outCharset: "utf-8", notice: "0", platform: "yqq.json", needNewCode: "0" },
    { cookie: false },
  );
  const items = json && json.data && json.data.song && json.data.song.itemlist;
  return (Array.isArray(items) ? items : []).slice(0, Math.max(1, Math.min(limit || 6, 10))).map(mapQQSmartSong);
}

/** 单曲详情（musicu，**默认不带 cookie**）。 */
async function qqSongDetail(mid: string, fallback: any, http: QQHttp): Promise<any> {
  if (!mid) return fallback;
  const json = await http.musicRequest({
    comm: { ct: 24, cv: 0 },
    songinfo: { module: "music.pf_song_detail_svr", method: "get_song_detail_yqq", param: { song_mid: mid } },
  });
  const data = json && json.songinfo && json.songinfo.data;
  return mapQQTrack(data && data.track_info, fallback);
}

/** 登录态：cookie 派生 uin/票据 → profile 接口（默认带 cookie）刷新画像。 */
export async function getQQLoginInfo(http: QQHttp = qqHttp): Promise<Record<string, any>> {
  const cookie = http.cookie();
  const cookieObj = parseCookieString(cookie);
  const uin = qqCookieUin(cookieObj);
  const musicKey = qqCookieMusicKey(cookieObj);
  if (!uin || !musicKey) return { provider: "qq", loggedIn: false, hasCookie: !!cookie };
  const fallback = normalizeQQProfile(null, cookieObj, !!cookie);
  try {
    const body = await http.getJSON("https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg", {
      cid: "205360838", userid: uin, reqfrom: "1", g_tk: "5381", loginUin: uin, hostUin: "0",
      format: "json", inCharset: "utf8", outCharset: "utf-8", notice: "0", platform: "yqq.json", needNewCode: "0",
    });
    const info = normalizeQQProfile(body, cookieObj, !!cookie);
    if (body && (body.code === 1000 || body.result === 301)) {
      return { ...fallback, profileUnavailable: true };
    }
    return info;
  } catch (e) {
    log.warn("qq_login_profile_failed", { error: (e as Error).message });
    return { ...fallback, profileUnavailable: true };
  }
}

/** 搜索：smartbox 取基础 → musicu 详情补全（匿名）→ 按 mid 去重。 */
export async function handleQQSearch(keywords: string, limit: number, http: QQHttp = qqHttp): Promise<any[]> {
  const kw = String(keywords || "").trim();
  if (!kw) return [];
  const base = await qqSmartboxSearch(kw, limit, http);
  const detailed = await Promise.all(
    base.map(async (item) => {
      try {
        return await qqSongDetail(item.mid, item, http);
      } catch (e) {
        log.warn("qq_search_detail_failed", { mid: item.mid, error: (e as Error).message });
        return item;
      }
    }),
  );
  const seen = new Set<string>();
  return detailed.filter((song) => {
    const key = song && (song.mid || song.id || song.name + "|" + song.artist);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return !!song.name;
  });
}

/** 取址：按音质候选构造 filename，vkey 接口（**带 cookie:true**）取 purl；失败按授权/版权分类受限。 */
export async function handleQQSongUrl(mid: string, mediaMid: string, qualityPreference: string, http: QQHttp = qqHttp): Promise<Record<string, any>> {
  const songmid = String(mid || "").trim();
  if (!songmid) return { provider: "qq", url: "", error: "MISSING_MID", message: "Missing QQ song mid" };
  const guid = String(10000000 + Math.floor(Math.random() * 90000000));
  const cookieObj = parseCookieString(http.cookie());
  const uin = qqCookieUin(cookieObj) || "0";
  const musicKey = qqCookieMusicKey(cookieObj);
  const playbackKey = qqCookiePlaybackKey(cookieObj);
  const fileMediaMid = String(mediaMid || "").trim();
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const mediaIds: string[] = [];
  if (fileMediaMid) mediaIds.push(fileMediaMid);
  if (songmid && !mediaIds.includes(songmid)) mediaIds.push(songmid);
  const fileCandidates = mediaIds.flatMap((mediaId) =>
    qualityCandidatesFrom(requestedQuality, QQ_QUALITY_CANDIDATE_TEMPLATES).map((item) => ({ ...item, mediaId, filename: item.prefix + mediaId + item.ext })),
  );
  const filenames = fileCandidates.map((item) => item.filename);
  const param: Record<string, any> = {
    guid,
    songmid: filenames.length ? filenames.map(() => songmid) : [songmid],
    songtype: filenames.length ? filenames.map(() => 0) : [0],
    uin,
    loginflag: 1,
    platform: "20",
  };
  if (filenames.length) param.filename = filenames;
  const comm: Record<string, any> = { uin, format: "json", ct: musicKey ? 19 : 24, cv: 0 };
  if (musicKey) comm.authst = musicKey;
  const json = await http.musicRequest({ comm, req_0: { module: "vkey.GetVkeyServer", method: "CgiGetVkey", param } }, { cookie: true });
  const data = json && json.req_0 && json.req_0.data;
  const infos = data && Array.isArray(data.midurlinfo) ? data.midurlinfo : [];
  const info = infos.find((item: any) => item && item.purl) || infos[0];
  const purl = info && info.purl;
  if (purl) {
    const sip = (data.sip && data.sip[0]) || "https://ws.stream.qqmusic.qq.com/";
    const fileMeta = fileCandidates.find((item) => item.filename === info.filename) || ({} as Partial<(typeof fileCandidates)[number]>);
    return {
      provider: "qq",
      url: sip + purl,
      trial: false,
      playable: true,
      level: fileMeta.level || info.filename || "",
      quality: fileMeta.label || info.filename || "",
      filename: info.filename || "",
      requestedQuality,
    };
  }
  const restriction = classifyQQPlaybackRestriction(info, { hasSession: !!(uin && musicKey), hasPlaybackKey: !!(uin && playbackKey) });
  return {
    provider: "qq",
    url: "",
    playable: false,
    error: "QQ_URL_UNAVAILABLE",
    loggedIn: !!(uin && musicKey),
    playbackKeyReady: !!(uin && playbackKey),
    restriction,
    reason: restriction.category,
    message: restriction.message,
    qqCode: info && (info.result || info.code || info.errtype),
    rawMessage: info && (info.msg || info.tips || info.errmsg || ""),
    tried: fileCandidates.map((item) => item.label + " · " + item.filename),
    requestedQuality,
  };
}

/** 歌词：musicu（带 cookie）优先，空则 legacy fcg（带 cookie）回退；均经 base64 嗅探解码。 */
export async function handleQQLyric(mid: string, id: string, http: QQHttp = qqHttp): Promise<Record<string, any>> {
  const songMID = String(mid || "").trim();
  const songID = normalizeQQSongId(id);
  if (!songMID && !songID) return { provider: "qq", error: "Missing QQ song mid or id", lyric: "" };

  let lyricText = "";
  let transText = "";
  let qrcText = "";
  let romaText = "";
  let source = "qq-musicu";

  try {
    const param: Record<string, any> = {};
    if (songMID) param.songMID = songMID;
    if (songID) param.songID = songID;
    const json = await http.musicRequest(
      { comm: { ct: 24, cv: 0 }, lyric: { module: "music.musichallSong.PlayLyricInfo", method: "GetPlayLyricInfo", param } },
      { cookie: true },
    );
    const data = json && json.lyric && json.lyric.data;
    lyricText = decodeQQLyricText(data && data.lyric);
    transText = decodeQQLyricText(data && data.trans);
    qrcText = decodeQQLyricText(data && data.qrc);
    romaText = decodeQQLyricText(data && data.roma);
  } catch (e) {
    log.warn("qq_lyric_musicu_failed", { error: (e as Error).message });
  }

  if (!lyricText && songMID) {
    try {
      const body = await http.getJSON(
        "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
        {
          songmid: songMID, songtype: "0", format: "json", nobase64: "1", g_tk: "5381",
          loginUin: qqCookieUin(parseCookieString(http.cookie())) || "0", hostUin: "0",
          inCharset: "utf8", outCharset: "utf-8", notice: "0", platform: "yqq.json", needNewCode: "0",
        },
        { headers: { Referer: "https://y.qq.com/portal/player.html" } },
      );
      lyricText = decodeQQLyricText(body && body.lyric);
      transText = decodeQQLyricText(body && (body.trans || body.tlyric)) || transText;
      source = "qq-legacy";
    } catch (e) {
      log.warn("qq_lyric_legacy_failed", { error: (e as Error).message });
    }
  }

  return {
    provider: "qq",
    id: songID || "",
    mid: songMID,
    lyric: lyricText,
    tlyric: transText,
    yrc: "",
    qrc: qrcText,
    roma: romaText,
    source: lyricText ? source : "qq-empty",
  };
}

/** 评论：id 缺失时用 mid 经 song_detail 反查 topid；offset=0 优先热评。 */
export async function handleQQSongComments(id: string, mid: string, limit: number, offset: number, http: QQHttp = qqHttp): Promise<Record<string, any>> {
  let topid = String(id || "").replace(/\D/g, "");
  if (!topid && mid) {
    try {
      const detail = await qqSongDetail(mid, { mid }, http);
      topid = String((detail && (detail.qqId || detail.id)) || "").replace(/\D/g, "");
    } catch (e) {
      log.warn("qq_comments_detail_failed", { error: (e as Error).message });
    }
  }
  if (!topid) return { provider: "qq", error: "Missing QQ song id", comments: [] };
  const page = Math.max(0, Math.floor((offset || 0) / Math.max(1, limit || 20)));
  const uin = qqCookieUin(parseCookieString(http.cookie())) || "0";
  const body = await http.getJSON(
    "https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg",
    {
      g_tk: "5381", loginUin: uin, hostUin: "0", format: "json", inCharset: "utf8", outCharset: "utf-8", notice: "0", platform: "yqq.json", needNewCode: "0",
      cid: "205360772", reqtype: "2", biztype: "1", topid, cmd: "8", needmusiccrit: "0", pagenum: String(page), pagesize: String(limit || 20),
    },
    { headers: { Referer: "https://y.qq.com/n/ryqq/songDetail/" + encodeURIComponent(mid || topid) } },
  );
  const hotList = body && body.hot_comment && body.hot_comment.commentlist;
  const normalList = body && body.comment && body.comment.commentlist;
  const raw = offset === 0 && Array.isArray(hotList) && hotList.length ? hotList : normalList || [];
  const comments = (raw || []).map(mapQQComment).filter((c: { content: string }) => c.content);
  const total = Number(body && body.comment && (body.comment.commenttotal || body.comment.comment_total)) || comments.length;
  return { provider: "qq", id: topid, total, comments, hot: !!(offset === 0 && Array.isArray(hotList) && hotList.length) };
}

/** 歌手主页（musicu，带 cookie）：详情 + 热门歌曲。 */
export async function handleQQArtistDetail(mid: string, limit: number, http: QQHttp = qqHttp): Promise<Record<string, any>> {
  const singerMid = String(mid || "").trim();
  const num = Math.max(10, Math.min(80, parseInt(String(limit || "36"), 10) || 36));
  if (!singerMid) return { provider: "qq", error: "MISSING_SINGER_MID", artist: null, songs: [] };
  const json = await http.musicRequest(
    { comm: { ct: 24, cv: 0 }, singer: { module: "music.web_singer_info_svr", method: "get_singer_detail_info", param: { sort: 5, singermid: singerMid, sin: 0, num } } },
    { cookie: true },
  );
  const block = json && json.singer;
  if (!block || Number(block.code || 0) !== 0) {
    return { provider: "qq", error: (block && (block.message || block.msg || block.code)) || "QQ_ARTIST_DETAIL_FAILED", artist: null, songs: [] };
  }
  const data = block.data || {};
  const info = data.singer_info || data.singerInfo || {};
  const rawSongs = Array.isArray(data.songlist) ? data.songlist : [];
  const songs = rawSongs
    .map((raw: any) => mapQQTrack((raw && (raw.track_info || raw.songInfo || raw.songinfo || raw.song)) || raw, {}))
    .filter((song: any) => song && song.name && (song.mid || song.id));
  const matchedSongArtist = songs[0] && (songs[0].artists || []).find((a: any) => a && a.mid === singerMid);
  const artistMid = info.mid || singerMid;
  const artistName = info.name || info.title || (matchedSongArtist && matchedSongArtist.name) || "";
  const totalSong = Number(data.total_song || data.song_count || 0) || songs.length;
  return {
    provider: "qq",
    artist: {
      provider: "qq",
      id: info.id || "",
      mid: artistMid,
      name: artistName,
      avatar: info.pic || info.avatar || qqSingerAvatar(artistMid, 300),
      fans: Number(info.fans || 0) || 0,
      musicSize: totalSong,
      albumSize: Number(data.total_album || 0) || 0,
      mvSize: Number(data.total_mv || 0) || 0,
    },
    total: totalSong,
    songs,
  };
}

/** 用户歌单（创建 + 收藏，均带 cookie）：去重、过滤 qzone 背景、置顶「我喜欢」。 */
export async function handleQQUserPlaylists(http: QQHttp = qqHttp): Promise<Record<string, any>> {
  const info = await getQQLoginInfo(http);
  if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: "qq", playlists: [] };
  const uin = info.userId;
  const createdReq = http.getJSON(
    "https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss",
    { hostUin: 0, hostuin: uin, sin: 0, size: 200, g_tk: 5381, loginUin: uin, format: "json", inCharset: "utf8", outCharset: "utf-8", notice: 0, platform: "yqq.json", needNewCode: 0 },
    { headers: { Referer: "https://y.qq.com/portal/profile.html" } },
  );
  const collectReq = http.getJSON(
    "https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg",
    { ct: 20, cid: 205360956, userid: uin, reqtype: 3, sin: 0, ein: 80 },
    { headers: { Referer: "https://y.qq.com/portal/profile.html" } },
  );
  const [createdRaw, collectRaw] = await Promise.allSettled([createdReq, collectReq]);
  const created =
    createdRaw.status === "fulfilled" && createdRaw.value && createdRaw.value.data && Array.isArray(createdRaw.value.data.disslist)
      ? createdRaw.value.data.disslist.map((pl: any) => mapQQPlaylist(pl, "created"))
      : [];
  const collected =
    collectRaw.status === "fulfilled" && collectRaw.value && collectRaw.value.data && Array.isArray(collectRaw.value.data.cdlist)
      ? collectRaw.value.data.cdlist.map((pl: any) => mapQQPlaylist(pl, "collect"))
      : [];
  const seen = new Set<string>();
  const playlists = created
    .concat(collected)
    .filter((pl: any) => {
      if (!pl.id || !pl.name || seen.has(pl.id)) return false;
      if (isQzoneBackgroundPlaylist(pl)) return false;
      seen.add(pl.id);
      return true;
    })
    .sort((a: any, b: any) => Number(isQQFavoritePlaylist(b)) - Number(isQQFavoritePlaylist(a)));
  return { loggedIn: true, provider: "qq", userId: uin, playlists };
}

/** 歌单曲目（带 cookie）。 */
export async function handleQQPlaylistTracks(id: string, http: QQHttp = qqHttp): Promise<Record<string, any>> {
  const info = await getQQLoginInfo(http);
  if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: "qq", tracks: [] };
  const pid = String(id || "").trim();
  if (!pid) return { loggedIn: true, provider: "qq", error: "Missing QQ playlist id", tracks: [] };
  const result = await http.getJSON(
    "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg",
    { type: 1, utf8: 1, disstid: pid, loginUin: info.userId, format: "json", inCharset: "utf8", outCharset: "utf-8", notice: 0, platform: "yqq.json", needNewCode: 0 },
    { headers: { Referer: "https://y.qq.com/n/yqq/playlist" } },
  );
  const detail = result && result.cdlist && result.cdlist[0] ? result.cdlist[0] : {};
  const rawTracks = Array.isArray(detail.songlist) ? detail.songlist : [];
  const tracks = rawTracks.map(mapQQPlaylistTrack).filter((s: any) => s.name && (s.mid || s.id));
  const playlist = { provider: "qq", id: pid, name: detail.dissname || detail.diss_name || detail.name || "", cover: detail.logo || detail.diss_cover || "", trackCount: tracks.length };
  return { loggedIn: true, provider: "qq", playlist, tracks };
}
