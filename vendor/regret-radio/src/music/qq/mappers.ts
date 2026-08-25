/**
 * QQ 音乐映射层 + 歌词解码（C4c-1）。把 QQ 各接口原始记录归一为前端契约对象。纯函数、无 I/O，可单测。
 *
 * 行为保真（高危）：mid 优先于数字 id、duration 秒→毫秒、封面/头像 URL 模板、
 * decodeQQLyricText 的 base64 嗅探（QQ 歌词常为 base64，误判会让歌词全损）。
 * 消费 util/format 的 decodeHtmlEntities。
 */

import { decodeHtmlEntities } from "../util/format.js";

export interface QQArtist {
  id: unknown;
  mid: unknown;
  name: string;
}

/** 艺人数组归一（name||title，过滤无名）。 */
export function mapQQArtists(raw: any): QQArtist[] {
  return (raw || [])
    .map((a: any) => ({ id: a && a.id, mid: a && a.mid, name: (a && (a.name || a.title)) || "" }))
    .filter((a: QQArtist) => a.name);
}

/** 专辑封面 URL（按 albumMid 构造）；空 → 空。 */
export function qqAlbumCover(albumMid: unknown, size?: number): string {
  if (!albumMid) return "";
  const px = size || 300;
  return "https://y.qq.com/music/photo_new/T002R" + px + "x" + px + "M000" + albumMid + ".jpg?max_age=2592000";
}

/** 歌手头像 URL（按 singerMid 构造）；空 → 空。 */
export function qqSingerAvatar(singerMid: unknown, size?: number): string {
  if (!singerMid) return "";
  const px = size || 300;
  return "https://y.qq.com/music/photo_new/T001R" + px + "x" + px + "M000" + singerMid + ".jpg?max_age=2592000";
}

/** 歌单归一（subscribed 由 kind==='collect' 决定）。 */
export function mapQQPlaylist(pl: any, kind?: string) {
  pl = pl || {};
  const id = pl.dissid || pl.tid || pl.dirid || pl.id || pl.diss_id;
  return {
    provider: "qq",
    source: "qq",
    id: id ? String(id) : "",
    name: pl.diss_name || pl.name || pl.title || "",
    cover: pl.diss_cover || pl.logo || pl.picurl || pl.cover || "",
    trackCount: pl.song_cnt || pl.songnum || pl.total_song_num || pl.song_count || 0,
    playCount: pl.listen_num || pl.visitnum || pl.play_count || 0,
    creator: pl.hostname || pl.nick || pl.creator || "QQ 音乐",
    subscribed: kind === "collect",
    specialType: 0,
  };
}

/** 歌单内单曲归一（兼容 track_info/songInfo 包裹）。 */
export function mapQQPlaylistTrack(raw: any) {
  raw = raw || {};
  const track = raw.songid || raw.songmid || raw.mid || raw.name ? raw : raw.track_info || raw.songInfo || raw.songinfo || raw.song || {};
  const album = track.album || {};
  const artists = mapQQArtists(track.singer || track.singers || []);
  const mid = track.mid || track.songmid || raw.mid || raw.songmid || "";
  const albumMid = album.mid || track.albummid || raw.albummid || "";
  return {
    provider: "qq",
    source: "qq",
    type: "qq",
    id: mid || String(track.id || track.songid || raw.id || raw.songid || ""),
    qqId: track.id || track.songid || raw.id || raw.songid || "",
    mid,
    songmid: mid,
    mediaMid: (track.file && track.file.media_mid) || track.strMediaMid || track.media_mid || raw.strMediaMid || "",
    name: track.name || track.songname || raw.songname || "",
    artist: artists.map((a) => a.name).join(" / ") || track.singername || raw.singername || "",
    artists,
    artistId: artists[0] && (artists[0].id || artists[0].mid),
    artistMid: artists[0] && artists[0].mid,
    album: album.name || album.title || track.albumname || raw.albumname || "",
    albumMid,
    cover: qqAlbumCover(albumMid, 300),
    duration: (Number(track.interval || raw.interval) || 0) * 1000,
    fee: track.pay && Number(track.pay.pay_play) ? 1 : 0,
    playable: false,
  };
}

/** 智能搜索（smartbox）结果归一（字段稀疏）。 */
export function mapQQSmartSong(item: any) {
  item = item || {};
  const mid = item.mid || item.songmid || item.id || "";
  return {
    provider: "qq",
    source: "qq",
    type: "qq",
    id: mid,
    qqId: item.id || item.docid || "",
    mid,
    songmid: mid,
    name: item.name || item.title || "",
    artist: item.singer || "",
    artists: item.singer ? [{ name: item.singer }] : [],
    album: "",
    cover: "",
    duration: 0,
    fee: 0,
    playable: false,
  };
}

/** 完整单曲归一（song_detail 等），缺字段时用 fallback（如 smartbox 结果）兜底。 */
export function mapQQTrack(track: any, fallback?: any) {
  track = track || {};
  fallback = fallback || {};
  const album = track.album || {};
  const artists = mapQQArtists(track.singer || []);
  const mid = track.mid || fallback.mid || fallback.songmid || "";
  const albumMid = album.mid || album.pmid || "";
  return {
    provider: "qq",
    source: "qq",
    type: "qq",
    id: mid,
    qqId: track.id || fallback.qqId || fallback.id || "",
    mid,
    songmid: mid,
    mediaMid: track.file && track.file.media_mid,
    name: track.name || track.title || fallback.name || "",
    artist: artists.map((a) => a.name).join(" / ") || fallback.artist || "",
    artists: artists.length ? artists : fallback.artists || [],
    artistId: artists[0] && (artists[0].id || artists[0].mid),
    artistMid: artists[0] && artists[0].mid,
    album: album.name || album.title || fallback.album || "",
    albumMid,
    cover: qqAlbumCover(albumMid, 300) || fallback.cover || "",
    duration: (Number(track.interval) || 0) * 1000,
    fee: track.pay && Number(track.pay.pay_play) ? 1 : 0,
    playable: false,
  };
}

/** 评论归一（秒级时间戳 *1000 转毫秒）。 */
export function mapQQComment(raw: any) {
  raw = raw || {};
  const user = raw.user || raw.uin || {};
  const nickname = raw.nick || raw.nickname || raw.encrypt_uin || user.nick || user.nickname || user.name || "QQ 音乐用户";
  const avatar = raw.avatarurl || raw.avatar || user.avatarurl || user.avatar || "";
  const timeRaw = Number(raw.time || raw.commenttime || raw.createTime || 0) || 0;
  return {
    id: raw.commentid || raw.commentId || raw.id || "",
    content: raw.rootcommentcontent || raw.content || raw.comment || "",
    likedCount: Number(raw.praisenum || raw.praise_num || raw.likedCount || 0) || 0,
    time: timeRaw && timeRaw < 10000000000 ? timeRaw * 1000 : timeRaw,
    user: {
      id: raw.encrypt_uin || raw.uin || user.uin || "",
      nickname,
      avatar,
    },
  };
}

/** 「我喜欢」类歌单识别（排序置顶用）。 */
export function isQQFavoritePlaylist(pl: any): boolean {
  const name = String((pl && pl.name) || "").trim();
  return /我喜欢|我的喜欢|喜欢的音乐/i.test(name);
}

/** QQ 空间背景音乐歌单识别（过滤噪声）。 */
export function isQzoneBackgroundPlaylist(pl: any): boolean {
  const text = String(((pl && pl.name) || "") + " " + ((pl && pl.creator) || "")).toLowerCase();
  return /qzone|空间|背景音乐/i.test(text);
}

/** QQ 歌词解码：HTML 实体 + base64 嗅探（QQ 歌词常 base64，非 LRC 起始且形似 base64 才解）。 */
export function decodeQQLyricText(text: unknown): string {
  let raw = decodeHtmlEntities(String(text || "").trim());
  if (!raw) return "";
  const compact = raw.replace(/\s+/g, "");
  const looksBase64 = compact.length >= 8 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  if (looksBase64 && !/^\s*\[/.test(raw)) {
    try {
      const decoded = Buffer.from(compact, "base64").toString("utf8").replace(/^﻿/, "");
      if (decoded && (decoded.includes("[") || /[一-龥]/.test(decoded))) raw = decoded;
    } catch {
      /* base64 解码失败：保留原文 */
    }
  }
  return decodeHtmlEntities(raw).replace(/\r\n/g, "\n").trim();
}

/** 取数字歌曲 id（Number），无数字 → 0。 */
export function normalizeQQSongId(id: unknown): number {
  const n = String(id || "").replace(/\D/g, "");
  return n ? Number(n) : 0;
}
