import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeEvents,
  buildTasteContextText,
  TASTE_WINDOW_DAYS,
  type TasteEvent,
} from "../src/music/taste-summary.js";

function ev(partial: {
  event_type: string;
  track_id: string;
  track_title?: string;
  track_artist?: string;
  position_ms?: number | null;
}): TasteEvent {
  return {
    event_id: `mevt_${partial.track_id}_${partial.event_type}`,
    track_id: partial.track_id,
    track_title: partial.track_title ?? null,
    track_artist: partial.track_artist ?? null,
    event_type: partial.event_type,
    position_ms: partial.position_ms ?? null,
    duration_ms: null,
    created_at: "2026-08-25 00:00:00",
  };
}

test("rolling taste aggregation counts events and separates repeat from like", () => {
  const stats = summarizeEvents([
    ev({ event_type: "play_started", track_id: "a", track_title: "示例歌曲", track_artist: "示例歌手甲" }),
    ev({ event_type: "play_completed", track_id: "a", track_title: "示例歌曲", track_artist: "示例歌手甲" }),
    ev({ event_type: "play_completed", track_id: "a", track_title: "示例歌曲", track_artist: "示例歌手甲" }),
    ev({ event_type: "liked", track_id: "a", track_title: "示例歌曲", track_artist: "示例歌手甲" }),
    ev({ event_type: "play_completed", track_id: "b", track_title: "只听一遍" }),
  ]);

  assert.equal(stats.eventCount, 5);
  assert.deepEqual(stats.eventTypes, { play_started: 1, play_completed: 3, liked: 1 });
  assert.deepEqual(stats.loopTracks, [{ trackId: "a", title: "示例歌曲", artist: "示例歌手甲", plays: 2 }]);
  assert.equal(stats.likedCount, 1);
  assert.equal(stats.completedCount, 3);
});

test("rolling taste aggregation only treats skips before 15 seconds as quick skips", () => {
  const stats = summarizeEvents([
    ev({ event_type: "skipped", track_id: "fast", track_title: "秒切", position_ms: 8_000 }),
    ev({ event_type: "skipped", track_id: "fast", track_title: "秒切", position_ms: 12_000 }),
    ev({ event_type: "skipped", track_id: "slow", track_title: "听过再切", position_ms: 90_000 }),
  ]);

  assert.equal(stats.skippedCount, 3);
  assert.deepEqual(stats.skipTracks, [{ trackId: "fast", title: "秒切", artist: "", skips: 2 }]);
});

test("rolling taste text states full scope and inference boundary", () => {
  const stats = summarizeEvents([
    ev({ event_type: "play_started", track_id: "a", track_title: "示例歌曲", track_artist: "示例歌手甲" }),
    ev({ event_type: "play_completed", track_id: "a", track_title: "示例歌曲", track_artist: "示例歌手甲" }),
    ev({ event_type: "play_completed", track_id: "a", track_title: "示例歌曲", track_artist: "示例歌手甲" }),
  ]);
  const text = buildTasteContextText({
    generatedAt: "2026-08-25T12:00:00.000Z",
    windowDays: TASTE_WINDOW_DAYS,
    totalEvents: 208,
    analyzedEvents: 208,
    truncated: false,
    stats,
    positive: [{ artist: "示例歌手甲", score: 8, status: "inferred", likedCount: 0, completedCount: 5, skippedCount: 2, totalEvents: 14 }],
    negative: [],
    notes: { count: 0, moodDist: {}, lateNightCount: 0, shared: [] },
  });

  assert.match(text, /完整滚动音乐画像/);
  assert.match(text, /原始事件总量 208 条/);
  assert.match(text, /近 180 天分析 208 条/);
  assert.match(text, /偏爱歌手（行为推断）：示例歌手甲\(8\)/);
  assert.match(text, /用户本轮或长期记忆中的明确喜恶优先/);
});
