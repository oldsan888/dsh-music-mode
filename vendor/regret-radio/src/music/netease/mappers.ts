/**
 * 网易云专属映射层（C4b）。把 NCM 原始响应记录归一为前端契约对象。纯函数、无 I/O，可单测。
 *
 * 行为保真（高危）：字段兜底顺序、artist 拼接（' / '）、podcast 的 playableId 选取、
 * mapDiscoverPlaylist 里 `||`/`&&` 的优先级（cover 经 uiElement 兜底）一旦改动会改变
 * 搜索/取址/播客/发现页的呈现。下沉自 legacy/gateway.cjs，逻辑逐字对照。
 */

export interface NeteaseArtist {
  id: unknown;
  name: string;
}

export interface NeteaseSong {
  provider: "netease";
  source: "netease";
  type: "song";
  id: unknown;
  name: unknown;
  artist: string;
  artists: NeteaseArtist[];
  artistId: unknown;
  album: string;
  cover: string;
  duration: number;
  fee: unknown;
}

/** 艺人数组归一：取 {id,name}，过滤无名者。 */
export function mapArtists(raw: any): NeteaseArtist[] {
  return (raw || [])
    .map((a: any) => ({ id: a && a.id, name: (a && a.name) || "" }))
    .filter((a: NeteaseArtist) => a.name);
}

/** 单曲记录归一（cloudsearch/song_detail 的 songs 元素）。 */
export function mapSongRecord(s: any): NeteaseSong {
  s = s || {};
  const artists = mapArtists(s.ar || s.artists);
  const album = s.al || s.album || {};
  return {
    provider: "netease",
    source: "netease",
    type: "song",
    id: s.id,
    name: s.name,
    artist: artists.map((a) => a.name).join(" / "),
    artists,
    artistId: artists[0] && artists[0].id,
    album: album.name || "",
    cover: album.picUrl || album.coverUrl || "",
    duration: s.dt || s.duration || 0,
    fee: s.fee,
  };
}

/** 发现页歌单归一（personalized/recommend_resource 等）。 */
export function mapDiscoverPlaylist(pl: any, tag?: string) {
  pl = pl || {};
  const creator = pl.creator || pl.user || {};
  const id = pl.id || pl.resourceId || pl.creativeId;
  return {
    provider: "netease",
    source: "netease",
    type: "playlist",
    id,
    name: pl.name || pl.title || "",
    cover:
      pl.picUrl ||
      pl.coverImgUrl ||
      pl.coverUrl ||
      (pl.uiElement && pl.uiElement.image && pl.uiElement.image.imageUrl) ||
      "",
    trackCount: pl.trackCount || pl.songCount || pl.programCount || 0,
    playCount: pl.playCount || pl.playcount || 0,
    creator: creator.nickname || creator.name || "",
    tag: tag || pl.alg || "",
  };
}

/** 播客电台归一（dj_detail/dj_hot/cloudsearch 1009 等）。 */
export function mapPodcastRadio(r: any) {
  r = r || {};
  const dj = r.dj || r.djSimple || r.djUser || r.creator || {};
  const id = r.id || r.rid || r.radioId;
  return {
    id,
    rid: id,
    name: r.name || r.radioName || "",
    cover: r.picUrl || r.picURL || r.coverUrl || r.coverImgUrl || r.avatarUrl || "",
    desc: r.desc || r.description || r.rcmdText || "",
    djName: dj.nickname || r.djName || r.nickname || "",
    category: r.category || r.categoryName || "",
    programCount: r.programCount || r.programNum || r.programCnt || 0,
    subCount: r.subCount || r.subedCount || r.subscriberCount || 0,
  };
}

/** 播客单期节目归一（dj_program）。playableId 取 mainSong.id（可播曲）。 */
export function mapPodcastProgram(p: any, fallbackRadio?: any) {
  p = p || {};
  const mainSong = p.mainSong || p.song || p.mainTrack || {};
  const radio = p.radio || fallbackRadio || {};
  const mappedRadio = mapPodcastRadio(radio);
  const artists = mapArtists(mainSong.ar || mainSong.artists || []);
  const album = mainSong.al || mainSong.album || {};
  const dj = p.dj || radio.dj || {};
  const playableId = mainSong.id || p.mainSongId || p.songId;
  return {
    type: "podcast",
    source: "podcast",
    id: playableId,
    programId: p.id || p.programId,
    radioId: mappedRadio.id,
    name: p.name || mainSong.name || "",
    artist: mappedRadio.name || dj.nickname || artists.map((a) => a.name).join(" / ") || mappedRadio.djName || "",
    artists,
    artistId: artists[0] && artists[0].id,
    album: mappedRadio.name || album.name || "Podcast",
    cover: p.coverUrl || p.cover || p.blurCoverUrl || mappedRadio.cover || album.picUrl || "",
    duration: p.duration || mainSong.dt || mainSong.duration || 0,
    fee: mainSong.fee,
    djName: mappedRadio.djName || dj.nickname || "",
    radioName: mappedRadio.name || "",
    desc: p.description || p.desc || "",
    createTime: p.createTime || 0,
    serialNum: p.serialNum || p.serial || 0,
  };
}

/** 从对象按 keys 顺序取第一个数组（支持 .list/.data/.resources 包裹）。 */
export function firstArrayFrom(obj: any, keys: string[]): any[] {
  obj = obj || {};
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.list)) return value.list;
    if (value && Array.isArray(value.data)) return value.data;
    if (value && Array.isArray(value.resources)) return value.resources;
  }
  return [];
}

/** 播客「声音」归一（sati_resource_sub_list / record_recent_voice，含 resource 包裹）。 */
export function mapPodcastVoice(v: any) {
  v = v || {};
  const raw = v.resource || v.voice || v.data || v.program || v;
  const mainSong = raw.mainSong || raw.song || raw.track || {};
  const radio = raw.radio || raw.djRadio || raw.voiceList || raw.podcast || {};
  const playableId = raw.trackId || raw.songId || raw.mainSongId || mainSong.id || raw.id;
  return {
    type: "podcast",
    source: "podcast",
    sourceType: "podcast-voice",
    id: playableId,
    programId: raw.programId || raw.voiceId || raw.id,
    radioId: radio.id || radio.radioId || radio.voiceListId || raw.radioId || raw.voiceListId,
    name: raw.name || raw.songName || raw.title || mainSong.name || "",
    artist: radio.name || radio.radioName || radio.voiceListName || raw.podcastName || raw.djName || "Voice",
    album: radio.name || radio.radioName || raw.podcastName || "Podcast",
    cover: raw.coverUrl || raw.cover || raw.picUrl || raw.coverImgUrl || radio.picUrl || radio.coverUrl || "",
    duration: raw.duration || raw.durationMs || mainSong.dt || mainSong.duration || 0,
    djName: raw.djName || (radio.dj && radio.dj.nickname) || "",
    radioName: radio.name || radio.radioName || raw.podcastName || "",
    desc: raw.desc || raw.description || "",
  };
}

/** 播客电台（收藏/创建集合视图）归一：在 mapPodcastRadio 上叠加 collection 字段。 */
export function mapPodcastCollectionRadio(r: any, key?: string) {
  const radio = mapPodcastRadio(r);
  return {
    ...radio,
    type: "podcast-radio",
    sourceType: "podcast-radio",
    collectionKey: key || "",
    radioId: radio.id,
    name: radio.name,
    artist: radio.djName || radio.category || "Podcast",
    album: radio.category || "Podcast",
  };
}

interface CollectionMetaBase {
  key: string;
  title: string;
  sub: string;
  itemType: string;
}

/** 「我的播客」分组元信息（collect/created/liked，未知 key 回退）。 */
export function podcastCollectionMeta(key: string, items: any[]) {
  const presets: Record<string, CollectionMetaBase> = {
    collect: { key: "collect", title: "收藏播客", sub: "你收藏的播客", itemType: "radio" },
    created: { key: "created", title: "创建播客", sub: "你创建的播客", itemType: "radio" },
    liked: { key: "liked", title: "喜欢的声音", sub: "收藏或最近喜欢的声音", itemType: "voice" },
  };
  const meta = presets[key] || { key, title: key, sub: "", itemType: "radio" };
  const first = (items || [])[0] || {};
  return {
    ...meta,
    count: (items || []).length,
    cover: first.cover || first.picUrl || first.coverUrl || "",
  };
}

function lowSignalText(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

/** 发现页低质播客过滤：付费/qzone/背景音乐/特定噪声电台。 */
export function isLowSignalPodcastItem(item: any): boolean {
  const name = lowSignalText(item && (item.name || item.title || item.radioName));
  const sub = lowSignalText(item && (item.djName || item.category || item.desc || item.sub));
  const text = name + " " + sub;
  return /购买播客|付费精品|qzone|空间背景音乐|背景音乐|四只烤翅|试纸烤翅/i.test(text);
}
