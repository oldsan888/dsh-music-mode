import { ulid } from "ulid";
import { execute, query, queryOne, withTx } from "../store/sqlite.js";
import { readAppConfig, writeAppConfig } from "../store/app-config.js";
import { getNow, getNowDate, parseSqliteUtc, toLocalDate, toSqliteUtc } from "../store/clock.js";
import { aggregatePreferences, recordEvent, splitArtists } from "./events.js";

export const MUSIC_NOTE_MOODS = [
  "sad", "miss", "calm", "relief", "lift", "annoyed", "numb", "pure",
] as const;
export type MusicNoteMood = (typeof MUSIC_NOTE_MOODS)[number];
export const MUSIC_NOTE_SOURCES = ["hero", "hint", "agent"] as const;
export type MusicNoteSource = (typeof MUSIC_NOTE_SOURCES)[number];
const MOOD_SET = new Set<string>(MUSIC_NOTE_MOODS);
const SOURCE_SET = new Set<string>(MUSIC_NOTE_SOURCES);

export interface MusicNoteInput {
  user_id: string;
  track_id: string;
  track_title?: string;
  track_artist?: string;
  provider?: string;
  mood?: string | null;
  text?: string | null;
  prompt?: string | null;
  prompt_kind?: string | null;
  source: string;
  shared?: boolean;
}

export interface MusicNoteRow {
  note_id: string;
  user_id: string;
  track_id: string;
  track_title: string | null;
  track_artist: string | null;
  provider: string | null;
  work_key: string;
  mood: MusicNoteMood | null;
  text: string | null;
  prompt: string | null;
  prompt_kind: string | null;
  source: MusicNoteSource;
  shared_at: string | null;
  created_at: string;
}

export type ExplicitMusicPreference = "liked" | "disliked";

/**
 * One DSH-authored user statement can carry two truths: the verbatim B-side note and an
 * explicit preference. Persist them in one SQLite transaction so the UI cannot show the
 * quote while the taste profile still misses the preference (or vice versa).
 */
export function createMusicNoteWithPreference(
  input: MusicNoteInput,
  preference?: ExplicitMusicPreference,
): { note: MusicNoteRow; preferenceRecorded: ExplicitMusicPreference | null } {
  if (preference && input.source !== "agent") {
    throw new Error("explicit preference requires agent source");
  }
  return withTx(() => {
    const note = createMusicNote(input);
    if (preference) {
      recordEvent({
        user_id: note.user_id,
        track_id: note.track_id,
        track_title: note.track_title ?? undefined,
        track_artist: note.track_artist ?? undefined,
        event_type: preference === "liked" ? "liked" : "unliked",
        context: {
          provider: note.provider ?? "",
          source: "dsh_explicit_preference",
          note_id: note.note_id,
        },
      });
      aggregatePreferences(note.user_id);
    }
    return { note, preferenceRecorded: preference ?? null };
  });
}

export function normalizeWorkTitle(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[（(\[][\s\S]*?[）)\]]/g, " ")
    .replace(/\s+(?:feat\.?|ft\.?)\s+.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeWorkArtist(raw: string): string {
  return (splitArtists(raw)[0] ?? String(raw ?? ""))
    .toLowerCase().replace(/\s+/g, " ").trim();
}

export function makeWorkKey(title: string, artist: string): string {
  return `${normalizeWorkTitle(title)}|${normalizeWorkArtist(artist)}`;
}

function cleanRequired(value: unknown, name: string): string {
  const out = typeof value === "string" ? value.trim() : "";
  if (!out) throw new Error(`${name} required`);
  return out;
}

export function createMusicNote(input: MusicNoteInput): MusicNoteRow {
  const userId = cleanRequired(input.user_id, "user_id");
  const trackId = cleanRequired(input.track_id, "track_id");
  const title = String(input.track_title ?? "").trim();
  const artist = String(input.track_artist ?? "").trim();
  const mood = input.mood == null ? "" : String(input.mood).trim();
  const text = input.text == null ? "" : String(input.text).trim();
  const source = String(input.source ?? "").trim();
  if (!mood && !text) throw new Error("mood or text required");
  if (mood && !MOOD_SET.has(mood)) throw new Error("invalid mood");
  if (!SOURCE_SET.has(source)) throw new Error("invalid source");
  if ([...text].length > 500) throw new Error("text exceeds 500 characters");

  const noteId = `mnote_${ulid()}`;
  const now = getNow();
  const sharedAt = input.shared ? now : null;
  execute(
    `INSERT INTO music_notes
     (note_id,user_id,track_id,track_title,track_artist,provider,work_key,mood,text,prompt,prompt_kind,source,shared_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [noteId, userId, trackId, title || null, artist || null, String(input.provider ?? "").trim() || null,
      makeWorkKey(title, artist), mood || null, text || null, input.prompt || null,
      input.prompt_kind || null, source, sharedAt, now],
  );
  return queryOne<MusicNoteRow>("SELECT * FROM music_notes WHERE note_id = ?", [noteId])!;
}

export interface MusicNotesQuery {
  userId: string;
  workKey?: string;
  trackId?: string;
  limit?: number;
  offset?: number;
  includePrivate?: boolean;
}

export function getMusicNotes(opts: MusicNotesQuery): { items: MusicNoteRow[]; aggregate: NoteAggregate } {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const where = ["user_id = ?"];
  const params: unknown[] = [opts.userId];
  if (opts.workKey) { where.push("work_key = ?"); params.push(opts.workKey); }
  else if (opts.trackId) { where.push("track_id = ?"); params.push(opts.trackId); }
  if (!opts.includePrivate) where.push("shared_at IS NOT NULL");
  const items = query<MusicNoteRow>(
    `SELECT * FROM music_notes WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { items, aggregate: getMusicNoteAggregate(opts.userId, opts.workKey) };
}

export interface NoteAggregate {
  count: number;
  moodDist: Record<string, number>;
  byHour: Record<string, number>;
  topWorks: Array<{ work_key: string; title: string; artist: string; count: number }>;
}

/** L1 聚合不含原文，可安全供根路径工具读取。 */
export function getMusicNoteAggregate(userId: string, workKey?: string): NoteAggregate {
  const extra = workKey ? " AND work_key = ?" : "";
  const params = workKey ? [userId, workKey] : [userId];
  const count = queryOne<{ c: number }>(`SELECT COUNT(*) c FROM music_notes WHERE user_id = ?${extra}`, params)?.c ?? 0;
  const moodRows = query<{ mood: string; c: number }>(
    `SELECT mood, COUNT(*) c FROM music_notes WHERE user_id = ?${extra} AND mood IS NOT NULL GROUP BY mood`, params,
  );
  const hourRows = query<{ hour: string; c: number }>(
    `SELECT strftime('%H', created_at, 'localtime') hour, COUNT(*) c FROM music_notes WHERE user_id = ?${extra} GROUP BY hour`, params,
  );
  const topWorks = query<{ work_key: string; title: string; artist: string; count: number }>(
    `SELECT work_key, COALESCE(MAX(track_title),'') title, COALESCE(MAX(track_artist),'') artist, COUNT(*) count
     FROM music_notes WHERE user_id = ? GROUP BY work_key ORDER BY count DESC, MAX(created_at) DESC LIMIT 5`, [userId],
  );
  return {
    count,
    moodDist: Object.fromEntries(moodRows.map((r) => [r.mood, r.c])),
    byHour: Object.fromEntries(hourRows.map((r) => [r.hour, r.c])),
    topWorks,
  };
}

export function shareMusicNote(userId: string, noteId: string): boolean {
  return execute("UPDATE music_notes SET shared_at = ? WHERE note_id = ? AND user_id = ?", [getNow(), noteId, userId]).changes > 0;
}

export function deleteMusicNote(userId: string, noteId: string): boolean {
  return execute("DELETE FROM music_notes WHERE note_id = ? AND user_id = ?", [noteId, userId]).changes > 0;
}

export type PromptKind = "revisit_note" | "loop" | "late_night" | "skip_burst" | "first_time" | "none";
export interface MusicNotePrompt {
  kind: PromptKind;
  text?: string;
  track?: { track_id: string; track_title: string; track_artist: string; provider?: string; work_key: string };
}

interface EventTrackRow { track_id: string; track_title: string | null; track_artist: string | null; context?: string; created_at: string }
function eventProvider(row: EventTrackRow): string {
  try { return String(JSON.parse(row.context || "{}").provider || ""); } catch { return ""; }
}
function trackAnchor(row: EventTrackRow) {
  const title = row.track_title ?? "未知歌曲";
  const artist = row.track_artist ?? "";
  return { track_id: row.track_id, track_title: title, track_artist: artist, provider: eventProvider(row), work_key: makeWorkKey(title, artist) };
}

/** 纯规则提问：只陈述行为事实或提问，绝不推断用户情绪。 */
export function getMusicNotePrompt(userId: string, input: { trackId?: string; title?: string; artist?: string; provider?: string } = {}): MusicNotePrompt {
  let row: EventTrackRow | undefined;
  if (input.trackId) {
    row = queryOne<EventTrackRow>(
      "SELECT track_id,track_title,track_artist,context,created_at FROM music_events WHERE user_id=? AND track_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      [userId, input.trackId],
    ) ?? { track_id: input.trackId, track_title: input.title ?? null, track_artist: input.artist ?? null, context: JSON.stringify({ provider: input.provider }), created_at: getNow() };
  } else {
    row = queryOne<EventTrackRow>(
      "SELECT track_id,track_title,track_artist,context,created_at FROM music_events WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", [userId],
    );
  }
  if (!row) return { kind: "none" };
  const track = trackAnchor(row);
  const today = toLocalDate(getNow());
  const latestNote = queryOne<MusicNoteRow>("SELECT * FROM music_notes WHERE user_id=? AND work_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1", [userId, track.work_key]);
  if (latestNote && toLocalDate(latestNote.created_at) === today) return { kind: "none", track };

  const now = getNowDate();
  if (latestNote) {
    const months = Math.floor((now.getTime() - parseSqliteUtc(latestNote.created_at).getTime()) / (30 * 86_400_000));
    if (months >= 3) {
      const quote = latestNote.text ? `那天你写：“${latestNote.text}”。` : "那天你留过一个心情戳。";
      return { kind: "revisit_note", text: `上次听它是 ${months} 个月前。${quote}今天呢？`, track };
    }
  }
  const cutoff = toSqliteUtc(new Date(now.getTime() - 86_400_000));
  const loops = queryOne<{ c: number }>(
    "SELECT COUNT(*) c FROM music_events WHERE user_id=? AND track_id=? AND event_type='play_completed' AND created_at>=?", [userId, track.track_id, cutoff],
  )?.c ?? 0;
  if (loops >= 3) return { kind: "loop", text: `你今天把它放了 ${loops} 遍。`, track };
  const hour = now.getHours();
  // 「还在听」必须是事实：锚点事件要新鲜（≤30 分钟）。凌晨打开面板但最近事件是
  // 几天前的，不构成「还在听」（§2.2 硬规则：只陈述事实）。
  const anchorAgeMs = now.getTime() - parseSqliteUtc(row.created_at).getTime();
  if (hour < 5 && anchorAgeMs <= 30 * 60_000) {
    return { kind: "late_night", text: `${String(hour).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}，还在听。`, track };
  }
  const skips = queryOne<{ c: number }>(
    "SELECT COUNT(DISTINCT track_id) c FROM music_events WHERE user_id=? AND event_type='skipped' AND position_ms<15000 AND created_at>=?", [userId, cutoff],
  )?.c ?? 0;
  if (skips >= 3) return { kind: "skip_burst", text: `今晚你切掉了 ${skips} 首。在找什么？`, track };
  const completes = queryOne<{ c: number }>(
    "SELECT COUNT(*) c FROM music_events WHERE user_id=? AND track_id=? AND event_type='play_completed' AND created_at>=?", [userId, track.track_id, cutoff],
  )?.c ?? 0;
  if (completes >= 1 && !hasPriorWorkCompletion(userId, track.work_key, cutoff)) {
    return { kind: "first_time", text: "第一次听完它。", track };
  }
  return { kind: "none", text: "此刻这首，想说点什么？", track };
}

/**
 * 24h 窗口之前是否完整听完过同一作品（work_key 口径，跨源归并）。
 * first_time 只有在历史零完成时才是事实——「听完过 50 次、今天又听完一次」
 * 不许说成「第一次」（§2.2 硬规则）。
 */
function hasPriorWorkCompletion(userId: string, workKey: string, cutoff: string): boolean {
  const pairs = query<{ track_title: string | null; track_artist: string | null }>(
    "SELECT DISTINCT track_title, track_artist FROM music_events WHERE user_id=? AND event_type='play_completed' AND created_at<?",
    [userId, cutoff],
  );
  return pairs.some((p) => makeWorkKey(p.track_title ?? "", p.track_artist ?? "") === workKey);
}

const muteKey = (userId: string) => `side-b:mute-until:${userId}`;
const streakKey = (userId: string) => `side-b:dismiss-streak:${userId}`;
const hintDayKey = (userId: string) => `side-b:hint-day:${userId}`;
const dismissedKey = (userId: string, workKey: string) => `side-b:dismissed:${userId}:${workKey}`;

export function isSideBMuted(userId: string): boolean {
  const until = readAppConfig(muteKey(userId));
  return !!until && until > getNow();
}

export function canShowSideBHint(userId: string): boolean {
  return !isSideBMuted(userId) && readAppConfig(hintDayKey(userId)) !== toLocalDate(getNow());
}

export function markSideBHintShown(userId: string): void {
  writeAppConfig(hintDayKey(userId), toLocalDate(getNow()));
}

export function wasSideBWorkDismissed(userId: string, workKey: string): boolean {
  const at = readAppConfig(dismissedKey(userId, workKey));
  if (!at) return false;
  return getNowDate().getTime() - parseSqliteUtc(at).getTime() < 86_400_000;
}

export function dismissSideBPrompt(userId: string, workKey?: string): { streak: number; mutedUntil: string | null } {
  if (workKey) writeAppConfig(dismissedKey(userId, workKey), getNow());
  const streak = Math.max(0, parseInt(readAppConfig(streakKey(userId)) || "0", 10) || 0) + 1;
  writeAppConfig(streakKey(userId), String(streak >= 3 ? 0 : streak));
  if (streak < 3) return { streak, mutedUntil: null };
  const until = toSqliteUtc(new Date(getNowDate().getTime() + 72 * 3_600_000));
  writeAppConfig(muteKey(userId), until);
  return { streak: 0, mutedUntil: until };
}

export function resetSideBDismissStreak(userId: string): void {
  writeAppConfig(streakKey(userId), "0");
}

export interface SummaryNoteSignals {
  count: number;
  moodDist: Record<string, number>;
  lateNightCount: number;
  shared: Array<{ title: string; created_at: string; text: string }>;
}

export function summarizeNotesSince(userId: string, sinceIso?: string): SummaryNoteSignals {
  const since = sinceIso ? toSqliteUtc(new Date(sinceIso)) : "1970-01-01 00:00:00";
  const rows = query<MusicNoteRow>("SELECT * FROM music_notes WHERE user_id=? AND created_at>? ORDER BY created_at ASC", [userId, since]);
  const moodDist: Record<string, number> = {};
  let lateNightCount = 0;
  for (const row of rows) {
    if (row.mood) moodDist[row.mood] = (moodDist[row.mood] || 0) + 1;
    const h = parseSqliteUtc(row.created_at).getHours();
    if (h < 5) lateNightCount++;
  }
  return {
    count: rows.length,
    moodDist,
    lateNightCount,
    shared: rows.filter((r) => r.shared_at && r.text).slice(-3).map((r) => ({ title: r.track_title || "未知歌曲", created_at: r.created_at, text: r.text! })),
  };
}
