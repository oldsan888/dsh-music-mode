import { ulid } from "ulid";
import { query, queryOne, execute } from "../store/sqlite.js";
import { getNowDate, parseSqliteUtc, toSqliteUtc } from "../store/clock.js";

/* ─────────── Types ─────────── */

/** 合法事件类型（单一真相源；类型联合由它派生）。HTTP 入口按此做运行时白名单——
 *  event_type 列无 CHECK 约束，没有这道闸任意字符串都能入库（聚合时只是拿 0 分，脏得无声）。 */
export const MUSIC_EVENT_TYPES = [
  "play_started",
  "play_completed",
  "skipped",
  "liked",
  "unliked",
  "queued",
] as const;

export type MusicEventType = (typeof MUSIC_EVENT_TYPES)[number];

const MUSIC_EVENT_TYPE_SET = new Set<string>(MUSIC_EVENT_TYPES);

export function isValidMusicEventType(t: string): t is MusicEventType {
  return MUSIC_EVENT_TYPE_SET.has(t);
}

export interface MusicEventInput {
  user_id: string;
  session_id?: string;
  track_id: string;
  track_title?: string;
  track_artist?: string;
  event_type: MusicEventType;
  position_ms?: number;
  duration_ms?: number;
  context?: Record<string, unknown>;
}

export interface MusicEventRow {
  event_id: string;
  user_id: string;
  session_id: string | null;
  track_id: string;
  track_title: string | null;
  track_artist: string | null;
  event_type: string;
  position_ms: number | null;
  duration_ms: number | null;
  context: string;
  created_at: string;
}

export interface MusicPreferenceRow {
  pref_id: string;
  user_id: string;
  artist: string;
  score: number;
  liked_count: number;
  skipped_count: number;
  completed_count: number;
  total_events: number;
  tendency: "positive" | "negative" | "neutral";
  status: "inferred" | "confirmed" | "rejected";
  evidence: string;
  created_at: string;
  updated_at: string;
}

/* ─────────── 偏好评分规则 ─────────── */

const SCORE_MAP: Record<string, number> = {
  liked: 5,
  play_completed: 2,
  queued: 1,
  unliked: -5,
};

function skipScore(positionMs: number | null): number {
  if (positionMs === null || positionMs === undefined) return -1;
  if (positionMs < 15000) return -3;
  if (positionMs < 30000) return -1;
  return 0;
}

/* ─────────── 聚合参数：时间衰减 & 键卫生（口味画像污染案修复，2026-07-05）─────────── */

// 老证据按半衰期指数淡出，而非被 LIMIT 硬窗口「悬崖式」挤掉（污染案根因②）。
// 与 memory 检索的 recency 同一范式（memory/reader/retrieval.ts）。
const PREF_HALFLIFE_DAYS = 30; // 30 天前的行为权重降到一半
const PREF_WINDOW_DAYS = 180; // 只看半年内；超窗事件权重已 <0.02，直接截断兼防全表扫描
const PREF_MAX_EVENTS = 5000; // 窗内安全上限，防极端用户全表扫描

// netease 的 remix/phonk 上游常把流派/后期标签塞进 artist 串，splitArtists 拆出来后
// 是「假歌手键」（"示例歌手- / Montagem" 里的 Montagem）。整键匹配（小写归一）过滤，
// 不做子串匹配以免误伤真实名（"Daft Punk" ≠ "funk"）。
const NOISE_ARTIST_KEYS = new Set([
  "montagem", "phonk", "funk", "sped up", "spedup", "slowed", "reverb",
  "slowed + reverb", "remix", "bootleg", "mashup", "nightcore", "8d",
  "instrumental", "karaoke", "cover", "vip", "edit",
]);

function isNoiseArtistKey(name: string): boolean {
  return NOISE_ARTIST_KEYS.has(name.trim().toLowerCase());
}

// 事件年龄（天）；镜像 retrieval.ts 的 recency 计算，受控时钟见 store/clock.ts。
function eventAgeDays(createdAt: string, now: Date): number {
  return Math.max(0, (now.getTime() - parseSqliteUtc(createdAt).getTime()) / 86_400_000);
}

/* ─────────── 事件写入 ─────────── */

export function recordEvent(input: MusicEventInput): MusicEventRow {
  const event_id = `mevt_${ulid()}`;
  const contextStr = JSON.stringify(input.context ?? {});

  execute(
    `INSERT OR IGNORE INTO music_events
     (event_id, user_id, session_id, track_id, track_title, track_artist, event_type, position_ms, duration_ms, context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event_id,
      input.user_id,
      input.session_id ?? null,
      input.track_id,
      input.track_title ?? null,
      input.track_artist ?? null,
      input.event_type,
      input.position_ms ?? null,
      input.duration_ms ?? null,
      contextStr,
    ],
  );

  return queryOne<MusicEventRow>(
    `SELECT * FROM music_events WHERE event_id = ?`,
    [event_id],
  )!;
}

/* ─────────── 事件查询 ─────────── */

export function getRecentEvents(userId: string, limit = 100): MusicEventRow[] {
  return query<MusicEventRow>(
    // rowid DESC 兜底：时钟是秒级，同秒事件（跳歌+下一首 play_started 常同秒）不加此项顺序不定，
    // 会毁掉下游「尾部连跳」的顺序判定。rowid 即插入序，确定性。
    `SELECT * FROM music_events WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [userId, limit],
  );
}

/* ─────────── 聚合器：压缩事件 → music_preferences ─────────── */

// 合作歌手分隔符：斜杠（netease 标准 " / " 及无空格变体）、&、顿号（含全角变体）
const ARTIST_SEPARATORS = /[/／&＆、]/;
// 只清首尾的空白和连字符（"示例歌手-" 这类上游脏尾巴），名字内部的连字符（Artist-X）不动
const EDGE_JUNK = /^[\s\-–—－]+|[\s\-–—－]+$/g;

/**
 * 把 track_artist 原始串拆成单个歌手名（trim + 去重 + 去空）。
 * events 表存原始串不动，拆分只发生在聚合/消费层。
 */
export function splitArtists(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(ARTIST_SEPARATORS)) {
    const name = part.replace(EDGE_JUNK, "");
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

interface ArtistScore {
  artist: string;
  score: number;
  events: number;
  liked: number;
  skipped: number;
  completed: number;
  tracks: Set<string>; // distinct track_id：负向建档去抖用（单曲反复快切不算讨厌歌手）
  lastEventIds: string[]; // 最近的事件 ID 作为证据
}

function computeArtistScores(userId: string): ArtistScore[] {
  const now = getNowDate();
  const cutoff = toSqliteUtc(new Date(now.getTime() - PREF_WINDOW_DAYS * 86_400_000));
  const events = query<MusicEventRow>(
    `SELECT * FROM music_events
     WHERE user_id = ? AND track_artist IS NOT NULL AND created_at > ?
     ORDER BY created_at DESC LIMIT ?`,
    [userId, cutoff, PREF_MAX_EVENTS],
  );

  const map = new Map<string, ArtistScore>();

  for (const e of events) {
    // 越老的行为权重越低（指数衰减），治「洪水挤出 500 硬窗口」的悬崖式误判
    const weight = Math.exp(-eventAgeDays(e.created_at, now) / PREF_HALFLIFE_DAYS);

    // 合作曲（"华晨宇 / 杨宗纬"）给每位歌手各记一份事件分；流派噪声键（Montagem）丢弃
    for (const artist of splitArtists(e.track_artist)) {
      if (isNoiseArtistKey(artist)) continue;

      if (!map.has(artist)) {
        map.set(artist, {
          artist, score: 0, events: 0, liked: 0, skipped: 0, completed: 0,
          tracks: new Set(), lastEventIds: [],
        });
      }
      const s = map.get(artist)!;
      s.events++;
      s.tracks.add(e.track_id);
      if (s.lastEventIds.length < 5) s.lastEventIds.push(e.event_id);

      const base = e.event_type === "skipped" ? skipScore(e.position_ms) : (SCORE_MAP[e.event_type] ?? 0);
      s.score += base * weight;

      if (e.event_type === "skipped") s.skipped++;
      if (e.event_type === "liked") s.liked++;
      if (e.event_type === "play_completed") s.completed++;
    }
  }

  return Array.from(map.values());
}

/**
 * 聚合器：压缩 music_events → music_preferences（upsert）。
 * 每次调用重算窗口内所有 artist 的（时间衰减）分数并更新 music_preferences。
 *
 * 三条防污染规则（口味画像污染案修复，2026-07-05）：
 *  ① 键卫生：流派噪声键（Montagem 等）在 computeArtistScores 丢弃；负向建档要 ≥2 首不同歌，
 *    单曲反复快切不足以拉黑歌手。
 *  ② 时间衰减：computeArtistScores 用半衰期指数衰减 + 180 天窗，老正向不再被事件洪水挤翻。
 *  ③ 中性回落：本轮算不出有效偏好的 inferred 键（跌回中性 / 证据滑出窗口 / 旧串键拆分后消失 /
 *    噪声键被过滤）一律删除，不再冻结；confirmed/rejected 是用户已定性的，绝不碰。
 *
 * 返回更新的偏好数量。
 */
export function aggregatePreferences(userId: string): number {
  const scores = computeArtistScores(userId);
  const activeKeys = new Set<string>();
  let updated = 0;

  for (const s of scores) {
    // score 列是 REAL；衰减后取整（近期事件 age≈0、权重≈1，整数分不受影响）
    const score = Math.round(s.score);

    let tendency: "positive" | "negative" | "neutral" = "neutral";
    if (score >= 5 && (s.liked >= 1 || s.completed >= 2)) {
      tendency = "positive";
    } else if (score <= -5 && s.skipped >= 2 && s.tracks.size >= 2) {
      tendency = "negative";
    }

    // 中性不建档；已有 inferred 档的回落清理见循环后
    if (tendency === "neutral") continue;
    activeKeys.add(s.artist);

    const existing = queryOne<MusicPreferenceRow>(
      `SELECT * FROM music_preferences WHERE user_id = ? AND artist = ?`,
      [userId, s.artist],
    );

    if (existing) {
      // 更新已有记录
      execute(
        `UPDATE music_preferences
         SET score = ?, liked_count = ?, skipped_count = ?, completed_count = ?,
             total_events = ?, tendency = ?, evidence = ?, updated_at = datetime('now')
         WHERE pref_id = ?`,
        [score, s.liked, s.skipped, s.completed, s.events, tendency, JSON.stringify(s.lastEventIds), existing.pref_id],
      );
    } else {
      // 新增
      execute(
        `INSERT INTO music_preferences
         (pref_id, user_id, artist, score, liked_count, skipped_count, completed_count, total_events, tendency, evidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`mpref_${ulid()}`, userId, s.artist, score, s.liked, s.skipped, s.completed, s.events, tendency, JSON.stringify(s.lastEventIds)],
      );
    }
    updated++;
  }

  // ③ 中性回落 + 键卫生收尾：inferred 里本轮不再是有效偏好的键一律删除（confirmed/rejected 不碰）。
  // 这同时取代了旧的「历史遗留串键」清理——非规范键拆分后不会进 activeKeys，自然被删。
  const inferred = query<{ pref_id: string; artist: string }>(
    `SELECT pref_id, artist FROM music_preferences WHERE user_id = ? AND status = 'inferred'`,
    [userId],
  );
  for (const row of inferred) {
    if (!activeKeys.has(row.artist)) {
      execute(`DELETE FROM music_preferences WHERE pref_id = ?`, [row.pref_id]);
    }
  }

  return updated;
}

/* ─────────── 偏好查询 ─────────── */

export function getPreferences(userId: string, status?: string): MusicPreferenceRow[] {
  if (status) {
    return query<MusicPreferenceRow>(
      `SELECT * FROM music_preferences WHERE user_id = ? AND status = ? ORDER BY score DESC`,
      [userId, status],
    );
  }
  return query<MusicPreferenceRow>(
    `SELECT * FROM music_preferences WHERE user_id = ? AND status != 'rejected' ORDER BY score DESC`,
    [userId],
  );
}

export function confirmPreference(prefId: string, userId: string): boolean {
  const existing = queryOne<MusicPreferenceRow>(
    `SELECT * FROM music_preferences WHERE pref_id = ? AND user_id = ?`,
    [prefId, userId],
  );
  if (!existing) return false;
  execute(`UPDATE music_preferences SET status = 'confirmed', updated_at = datetime('now') WHERE pref_id = ?`, [prefId]);
  return true;
}

export function rejectPreference(prefId: string, userId: string): boolean {
  const existing = queryOne<MusicPreferenceRow>(
    `SELECT * FROM music_preferences WHERE pref_id = ? AND user_id = ?`,
    [prefId, userId],
  );
  if (!existing) return false;
  execute(`UPDATE music_preferences SET status = 'rejected', updated_at = datetime('now') WHERE pref_id = ?`, [prefId]);
  return true;
}
