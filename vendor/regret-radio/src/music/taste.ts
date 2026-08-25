import { getPreferences } from "./events.js";

/**
 * 听歌行为画像 → 聊天 prompt 细水注入（2026-07-04 任务①）。
 *
 * music_events 经 aggregatePreferences 聚合出的歌手榜此前只有 Home AI（discover-ai）
 * 在消费，聊天 DJ 的 system prompt 里没有——而 tools-schema 的 search_music/play_song
 * 描述却让模型"从【用户音乐口味】里挑"。这里补上被引用的段落本体：
 * 正向 top 歌手 + 拉黑歌手各一行，量小（Mp 细水原则），选歌细节仍由 schema 承载。
 */

const MAX_LIKED = 8;
const MAX_DISLIKED = 4;

/** 组装口味行；无有效偏好返回 null（compose 不渲染空标题）。 */
export function buildMusicTasteLines(userId: string): string | null {
  const prefs = getPreferences(userId); // status != rejected，score DESC
  const liked = prefs
    .filter((p) => p.tendency === "positive")
    .slice(0, MAX_LIKED)
    .map((p) => p.artist);
  const disliked = prefs
    .filter((p) => p.tendency === "negative")
    .sort((a, b) => a.score - b.score) // 最反感的排前
    .slice(0, MAX_DISLIKED)
    .map((p) => p.artist);

  const lines: string[] = [];
  if (liked.length > 0) lines.push(`偏爱:${liked.join("、")}`);
  if (disliked.length > 0) lines.push(`不感冒(别主动放):${disliked.join("、")}`);
  return lines.length > 0 ? lines.join("\n") : null;
}
