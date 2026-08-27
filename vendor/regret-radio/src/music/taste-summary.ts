/**
 * Read-only rolling music taste context.
 *
 * music_events/music_preferences remain the single source of truth. This module
 * never advances a checkpoint, creates pending work, or writes agent memory.
 * DSH calls the tool when music taste is relevant and may independently persist
 * the returned full snapshot as an agent-inferred memory.
 */

import { query, queryOne } from "../store/sqlite.js";
import { getNowDate, toSqliteUtc } from "../store/clock.js";
import { getPreferences, type MusicPreferenceRow } from "./events.js";
import { summarizeNotesSince, type SummaryNoteSignals } from "./notes.js";

export const TASTE_WINDOW_DAYS = 180;
export const TASTE_MAX_EVENTS = 5000;
const SKIP_SECONDS_MS = 15_000;
export const REPEAT_PLAYS_THRESHOLD = 2;

export interface TasteEvent {
  event_id: string;
  track_id: string;
  track_title: string | null;
  track_artist: string | null;
  event_type: string;
  position_ms: number | null;
  duration_ms: number | null;
  created_at: string;
}

export interface TasteStats {
  eventCount: number;
  eventTypes: Record<string, number>;
  loopTracks: { trackId: string; title: string; artist: string; plays: number }[];
  skipTracks: { trackId: string; title: string; artist: string; skips: number }[];
  likedCount: number;
  playedCount: number;
  completedCount: number;
  skippedCount: number;
}

/** Pure aggregation used by the live rolling context and unit tests. */
export function summarizeEvents(events: TasteEvent[], listLimit = 10): TasteStats {
  const trackAgg = new Map<string, { trackId: string; title: string; artist: string; plays: number }>();
  const skipAgg = new Map<string, { trackId: string; title: string; artist: string; skips: number }>();
  const eventTypes: Record<string, number> = {};

  for (const e of events) {
    eventTypes[e.event_type] = (eventTypes[e.event_type] ?? 0) + 1;
    const keyId = e.track_id || `${e.track_title}|${e.track_artist}`;
    if (e.event_type === "play_completed") {
      const cur = trackAgg.get(keyId) ?? {
        trackId: keyId,
        title: e.track_title ?? "未知歌曲",
        artist: e.track_artist ?? "",
        plays: 0,
      };
      cur.plays++;
      trackAgg.set(keyId, cur);
    }
    if (e.event_type === "skipped" && e.position_ms != null && e.position_ms < SKIP_SECONDS_MS) {
      const cur = skipAgg.get(keyId) ?? {
        trackId: keyId,
        title: e.track_title ?? "未知歌曲",
        artist: e.track_artist ?? "",
        skips: 0,
      };
      cur.skips++;
      skipAgg.set(keyId, cur);
    }
  }

  const loopTracks = [...trackAgg.values()]
    .filter((t) => t.plays >= REPEAT_PLAYS_THRESHOLD)
    .sort((a, b) => b.plays - a.plays || a.title.localeCompare(b.title))
    .slice(0, listLimit);
  const skipTracks = [...skipAgg.values()]
    .sort((a, b) => b.skips - a.skips || a.title.localeCompare(b.title))
    .slice(0, listLimit);

  return {
    eventCount: events.length,
    eventTypes,
    loopTracks,
    skipTracks,
    likedCount: eventTypes.liked ?? 0,
    playedCount: eventTypes.play_started ?? 0,
    completedCount: eventTypes.play_completed ?? 0,
    skippedCount: eventTypes.skipped ?? 0,
  };
}

/** Backwards-compatible pure-function name retained for existing callers/tests. */
export const summarizeSegment = summarizeEvents;

function artistView(rows: MusicPreferenceRow[], tendency: "positive" | "negative") {
  return rows
    .filter((row) => row.tendency === tendency)
    .slice(0, tendency === "positive" ? 8 : 5)
    .map((row) => ({
      artist: row.artist,
      score: row.score,
      status: row.status,
      likedCount: row.liked_count,
      completedCount: row.completed_count,
      skippedCount: row.skipped_count,
      totalEvents: row.total_events,
    }));
}

function joined(items: string[], empty = "（暂无可靠信号）"): string {
  return items.length > 0 ? items.join("、") : empty;
}

export interface TasteContext {
  generatedAt: string;
  userId: string;
  basis: "agent-inferred";
  authoritativeSource: "music_events+music_preferences";
  windowDays: number;
  totalEvents: number;
  analyzedEvents: number;
  windowEvents: number;
  truncated: boolean;
  eventTypes: Record<string, number>;
  preferences: {
    positive: ReturnType<typeof artistView>;
    negative: ReturnType<typeof artistView>;
  };
  repeatTracks: TasteStats["loopTracks"];
  quickSkipTracks: TasteStats["skipTracks"];
  notes: SummaryNoteSignals;
  summary: string;
  /** Compatibility for the old UI; the pending workflow no longer exists. */
  pending: null;
}

export function buildTasteContextText(input: {
  generatedAt: string;
  windowDays: number;
  totalEvents: number;
  analyzedEvents: number;
  truncated: boolean;
  stats: TasteStats;
  positive: ReturnType<typeof artistView>;
  negative: ReturnType<typeof artistView>;
  notes: SummaryNoteSignals;
}): string {
  const lines = [
    `[完整滚动音乐画像 · ${input.generatedAt.slice(0, 10)}]`,
    `数据口径：原始事件总量 ${input.totalEvents} 条；近 ${input.windowDays} 天分析 ${input.analyzedEvents} 条${input.truncated ? `（仅取最近 ${TASTE_MAX_EVENTS} 条）` : ""}`,
    `偏爱歌手（行为推断）：${joined(input.positive.map((p) => `${p.artist}(${p.score})`))}`,
  ];
  if (input.negative.length > 0) {
    lines.push(`较少主动播放（行为推断）：${joined(input.negative.map((p) => `${p.artist}(${p.score})`))}`);
  }
  if (input.stats.loopTracks.length > 0) {
    lines.push(`反复完整播放：${input.stats.loopTracks.map((t) => `《${t.title}》${t.artist ? `(${t.artist})` : ""}×${t.plays}`).join("、")}`);
  }
  if (input.stats.skipTracks.length > 0) {
    lines.push(`15秒内快切：${input.stats.skipTracks.map((t) => `《${t.title}》×${t.skips}`).join("、")}`);
  }
  lines.push(`播放开始 ${input.stats.playedCount} / 完整播完 ${input.stats.completedCount} / 跳过 ${input.stats.skippedCount} / 对话中明确喜欢 ${input.stats.likedCount}`);
  if (input.notes.count > 0) {
    lines.push(`近窗已授权/聚合手记 ${input.notes.count} 条；不得把未授权原文或行为推断改写成用户情绪。`);
  }
  lines.push("可信度边界：以上是听歌行为推断，不是用户明确表态；用户本轮或长期记忆中的明确喜恶优先。");
  return lines.join("\n");
}

/** Build a fresh, complete rolling snapshot without mutating any state. */
export function getTasteContext(userId: string): TasteContext {
  const now = getNowDate();
  const generatedAt = now.toISOString();
  const cutoffDate = new Date(now.getTime() - TASTE_WINDOW_DAYS * 86_400_000);
  const cutoff = toSqliteUtc(cutoffDate);
  const totalEvents = queryOne<{ count: number }>(
    "SELECT COUNT(*) count FROM music_events WHERE user_id = ?",
    [userId],
  )?.count ?? 0;
  const windowEvents = queryOne<{ count: number }>(
    "SELECT COUNT(*) count FROM music_events WHERE user_id = ? AND created_at >= ?",
    [userId, cutoff],
  )?.count ?? 0;
  const events = query<TasteEvent>(
    "SELECT event_id, track_id, track_title, track_artist, event_type, position_ms, duration_ms, created_at " +
      "FROM music_events WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    [userId, cutoff, TASTE_MAX_EVENTS],
  );
  const stats = summarizeEvents(events);
  const prefs = getPreferences(userId);
  const positive = artistView(prefs, "positive");
  const negative = artistView(prefs, "negative");
  const notes = summarizeNotesSince(userId, cutoffDate.toISOString());
  const summary = buildTasteContextText({
    generatedAt,
    windowDays: TASTE_WINDOW_DAYS,
    totalEvents,
    analyzedEvents: events.length,
    truncated: windowEvents > events.length,
    stats,
    positive,
    negative,
    notes,
  });

  return {
    generatedAt,
    userId,
    basis: "agent-inferred",
    authoritativeSource: "music_events+music_preferences",
    windowDays: TASTE_WINDOW_DAYS,
    totalEvents,
    analyzedEvents: events.length,
    windowEvents,
    truncated: windowEvents > events.length,
    eventTypes: stats.eventTypes,
    preferences: { positive, negative },
    repeatTracks: stats.loopTracks,
    quickSkipTracks: stats.skipTracks,
    notes,
    summary,
    pending: null,
  };
}
