import { config } from "../config.js";
import { handleSearch } from "./netease/service.js";
import { handleQQSearch } from "./qq/service.js";
import { getPreferences, splitArtists } from "./events.js";
import { createLogger } from "../logger.js";

const log = createLogger("music");

/**
 * play_song 后端选定（2026-07-04，治「编歌名→播成别的→同轮假报」）。
 *
 * 此前 play_song 是纯 fire-and-forget：前端收到 SSE 事件后自己搜索取第一匹配，模型同轮
 * 续写时只知道自己的搜索词——查无此歌时播出来的是完全另一首，模型却拿编造的歌名播报
 * （真机实锤：query"热血燃 华晨宇"→实播《Here We Are》，嘴上说《热血燃》）。
 * 现在由后端在返回工具结果前先把搜索做掉：选定即权威——resolved 曲目随工具结果喂给模型
 * （同轮播报接地），并随 SSE 事件带给前端照单直接播（不再重搜，前端 stage 展示照旧自己补）。
 *
 * 三态语义（调用方 tool-registry 按此措辞 note）：
 * - hit：选定曲目，模型可点名播报。
 * - miss：所有启用音源都干净地搜空——可笃定告诉用户没找到。
 * - unavailable：超时/源异常/无可用源——不确定，回退旧 fire-and-forget 行为（前端照旧自己搜）。
 */

export interface ResolvedTrack {
  id: string;
  provider: "netease" | "qq";
  name: string;
  artist: string;
  album?: string;
  cover?: string;
}

export type ResolveOutcome =
  | { kind: "hit"; track: ResolvedTrack }
  | { kind: "miss" }
  | { kind: "unavailable" };

export interface ResolveDeps {
  searchNetease: (keywords: string, limit: number) => Promise<any[]>;
  searchQQ: (keywords: string, limit: number) => Promise<any[]>;
  flags: () => { neteaseEnabled: boolean; qqEnabled: boolean };
  /** 用户 negative 口味（music_preferences）→ 歌手集合列表（一行一个集合，行内已 splitArtists）。 */
  negativeArtistSets: (userId: string) => string[][];
}

const defaultDeps: ResolveDeps = {
  searchNetease: (keywords, limit) => handleSearch(keywords, limit),
  searchQQ: (keywords, limit) => handleQQSearch(keywords, limit),
  flags: () => ({ neteaseEnabled: config.music.neteaseEnabled, qqEnabled: config.music.qqEnabled }),
  negativeArtistSets: (userId) =>
    getPreferences(userId)
      .filter((p) => p.tendency === "negative")
      .map((p) => splitArtists(p.artist))
      .filter((s) => s.length > 0),
};

/**
 * 拉黑命中判定：负向行的歌手集合【整体包含于】候选歌手集合才算命中——
 * 讨厌「示例歌手甲 / 翻唱者甲」这个组合 ≠ 讨厌示例歌手甲本人；单人负向行照常命中一切含该歌手的歌。
 */
function isBlocked(candidateArtists: string[], negSets: string[][]): boolean {
  if (negSets.length === 0 || candidateArtists.length === 0) return false;
  const have = new Set(candidateArtists.map((a) => a.toLowerCase()));
  return negSets.some((ns) => ns.length > 0 && ns.every((a) => have.has(a.toLowerCase())));
}

/** 上游搜索偶发抽风不能拖住整轮回复：超时即降级 unavailable，前端照旧自己搜（最坏=现状）。 */
const DEFAULT_TIMEOUT_MS = 3000;
const SEARCH_LIMIT = 10;

function toNeteaseTrack(s: any): ResolvedTrack | null {
  if (!s || s.id == null || !s.name) return null;
  return {
    id: String(s.id),
    provider: "netease",
    name: String(s.name),
    artist: String(s.artist ?? "") || (s.artists || []).map((a: any) => a?.name).filter(Boolean).join(" / "),
    album: String(s.album ?? ""),
    cover: String(s.cover ?? ""),
  };
}

function toQQTrack(s: any): ResolvedTrack | null {
  const id = s && (s.mid || s.songmid || s.id);
  if (!id || !s.name) return null;
  return {
    id: String(id),
    provider: "qq",
    name: String(s.name),
    artist: String(s.artist ?? s.singer ?? ""),
    album: String(s.album ?? ""),
    cover: String(s.cover ?? ""),
  };
}

/**
 * 三档择优：
 * ① 未拉黑 且 歌手集合全部被查询点名（"示例歌曲 示例歌手甲"→原唱 {示例歌手甲} 全命中,
 *    翻唱 {示例歌手甲,翻唱者甲} 不全命中——上游排序有时会把翻唱排在原唱前）；
 * ② 未拉黑的首个候选；
 * ③ 全被拉黑时回退第一有效候选（口味是偏好不是禁令，用户点名要照放）。
 * 查询没点歌手时 ① 自然落空，行为与 ② 一致——纯增益无回退风险。
 */
function pickTrack(
  songs: any[],
  toTrack: (s: any) => ResolvedTrack | null,
  negSets: string[][],
  query: string,
): ResolvedTrack | null {
  let firstValid: ResolvedTrack | null = null;
  let firstUnblocked: ResolvedTrack | null = null;
  for (const s of songs || []) {
    const t = toTrack(s);
    if (!t) continue;
    if (!firstValid) firstValid = t;
    const artists = splitArtists(t.artist);
    if (isBlocked(artists, negSets)) continue;
    if (!firstUnblocked) firstUnblocked = t;
    if (artists.length > 0 && artists.every((a) => query.includes(a))) return t; // ①
  }
  return firstUnblocked ?? firstValid;
}

/** 网易优先、QQ 兜底（与前端实播主源一致）；miss 要求所有启用源都干净搜空。 */
export async function resolvePlayQuery(
  query: string,
  opts?: { userId?: string; timeoutMs?: number; deps?: Partial<ResolveDeps> },
): Promise<ResolveOutcome> {
  const q = String(query || "").trim();
  if (!q) return { kind: "unavailable" };
  const deps: ResolveDeps = { ...defaultDeps, ...(opts?.deps ?? {}) };
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const work = (async (): Promise<ResolveOutcome> => {
    const flags = deps.flags();
    // 拉黑规避（任务①同源数据）：candidate 命中 negative 口味 → 跳到下一候选。fail-open。
    let negSets: string[][] = [];
    if (opts?.userId) {
      try {
        negSets = deps.negativeArtistSets(opts.userId);
      } catch (e) {
        log.warn("resolve_neg_prefs_failed", { error: (e as Error).message });
      }
    }
    let sawError = false;
    let searchedAny = false;

    if (flags.neteaseEnabled) {
      searchedAny = true;
      try {
        const hit = pickTrack(await deps.searchNetease(q, SEARCH_LIMIT), toNeteaseTrack, negSets, q);
        if (hit) return { kind: "hit", track: hit };
      } catch (e) {
        sawError = true;
        log.warn("resolve_netease_failed", { query: q, error: (e as Error).message });
      }
    }
    if (flags.qqEnabled) {
      searchedAny = true;
      try {
        const hit = pickTrack(await deps.searchQQ(q, SEARCH_LIMIT), toQQTrack, negSets, q);
        if (hit) return { kind: "hit", track: hit };
      } catch (e) {
        sawError = true;
        log.warn("resolve_qq_failed", { query: q, error: (e as Error).message });
      }
    }
    // 有源报错/没有可用源 → 不能笃定「没有这首歌」，交回前端旧路径
    if (!searchedAny || sawError) return { kind: "unavailable" };
    return { kind: "miss" };
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<ResolveOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "unavailable" }), timeoutMs);
    });
    const outcome = await Promise.race([work, timeout]);
    if (outcome.kind === "unavailable") {
      // 超时路径：work 还在后台跑也无妨（无副作用，只是废弃的搜索）
      log.info("resolve_play_query", { query: q, outcome: outcome.kind });
    } else {
      log.info("resolve_play_query", {
        query: q,
        outcome: outcome.kind,
        picked: outcome.kind === "hit" ? `${outcome.track.name} - ${outcome.track.artist}` : undefined,
      });
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
