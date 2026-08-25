import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sideb-"));
process.env.SQLITE_PATH = path.join(testDir, "sideb.db");

const notes = await import("../src/music/notes.js");
const clock = await import("../src/store/clock.js");
const sqlite = await import("../src/store/sqlite.js");

before(() => {
  clock.setNow("2026-08-25 14:00:00");
  sqlite.getDb();
});

after(() => {
  clock.setNow(null);
  sqlite.closeDb();
  fs.rmSync(testDir, { recursive: true, force: true });
});

test("work_key removes version/feat noise and keeps the primary artist", () => {
  assert.equal(notes.makeWorkKey("示例歌曲（Live） feat. Someone", "示例歌手甲 / 示例歌手乙"), "示例歌曲|示例歌手甲");
});

test("note validation, private gate, sharing, and aggregate", () => {
  assert.throws(() => notes.createMusicNote({
    user_id: "u", track_id: "1", source: "hero", mood: "unknown",
  }), /invalid mood/);

  const privateNote = notes.createMusicNote({
    user_id: "u", track_id: "1", track_title: "示例歌曲", track_artist: "示例歌手甲",
    provider: "netease", source: "hero", mood: "miss", text: "测试听感",
  });
  const privateRead = notes.getMusicNotes({ userId: "u", includePrivate: false });
  assert.equal(privateRead.aggregate.count, 1);
  assert.equal(privateRead.items.length, 0);

  assert.equal(notes.shareMusicNote("u", privateNote.note_id), true);
  const sharedRead = notes.getMusicNotes({ userId: "u", includePrivate: false });
  assert.equal(sharedRead.items.length, 1);
  assert.equal(sharedRead.items[0].text, "测试听感");
});

test("three dismissals mute proactive prompts for 72 hours", () => {
  assert.equal(notes.canShowSideBHint("mute-user"), true);
  assert.equal(notes.dismissSideBPrompt("mute-user", "song|artist").mutedUntil, null);
  assert.equal(notes.wasSideBWorkDismissed("mute-user", "song|artist"), true);
  assert.equal(notes.dismissSideBPrompt("mute-user").mutedUntil, null);
  const third = notes.dismissSideBPrompt("mute-user");
  assert.equal(third.mutedUntil, "2026-08-28 14:00:00");
  assert.equal(notes.canShowSideBHint("mute-user"), false);
});

test("summary exposes only explicitly shared original text", () => {
  notes.createMusicNote({
    user_id: "summary", track_id: "private", track_title: "秘密", track_artist: "A",
    source: "hero", mood: "sad", text: "不能出库",
  });
  notes.createMusicNote({
    user_id: "summary", track_id: "shared", track_title: "分享", track_artist: "B",
    source: "agent", text: "可以出库", shared: true,
  });
  const result = notes.summarizeNotesSince("summary");
  assert.equal(result.count, 2);
  assert.deepEqual(result.shared.map((x) => x.text), ["可以出库"]);
});

test("prompt engine prioritizes a three-play loop and states only the fact", () => {
  for (let i = 0; i < 3; i++) {
    sqlite.execute(
      `INSERT INTO music_events(event_id,user_id,track_id,track_title,track_artist,event_type,created_at)
       VALUES(?,?,?,?,?,'play_completed',?)`,
      [`loop-${i}`, "prompt-user", "song", "循环歌", "歌手", `2026-08-25 13:0${i}:00`],
    );
  }
  const prompt = notes.getMusicNotePrompt("prompt-user", { trackId: "song" });
  assert.equal(prompt.kind, "loop");
  assert.equal(prompt.text, "你今天把它放了 3 遍。");
});

test("first_time never fires when the same work was completed before (hard rule: facts only)", () => {
  // 历史上（窗口外）听完过同一作品 → 今天再听完一次不许说「第一次」。
  sqlite.execute(
    `INSERT INTO music_events(event_id,user_id,track_id,track_title,track_artist,event_type,created_at)
     VALUES('ft-old','ft-user','song-a','老歌','歌手','play_completed','2026-07-01 10:00:00')`,
  );
  sqlite.execute(
    `INSERT INTO music_events(event_id,user_id,track_id,track_title,track_artist,event_type,created_at)
     VALUES('ft-new','ft-user','song-a','老歌','歌手','play_completed','2026-08-25 13:30:00')`,
  );
  const repeat = notes.getMusicNotePrompt("ft-user", { trackId: "song-a" });
  assert.notEqual(repeat.kind, "first_time");

  // 全新作品今天首次听完 → first_time 成立。
  sqlite.execute(
    `INSERT INTO music_events(event_id,user_id,track_id,track_title,track_artist,event_type,created_at)
     VALUES('ft-fresh','ft-user','song-b','新歌','歌手','play_completed','2026-08-25 13:40:00')`,
  );
  const fresh = notes.getMusicNotePrompt("ft-user", { trackId: "song-b" });
  assert.equal(fresh.kind, "first_time");
});

test("late_night requires a fresh anchor event (no '还在听' on stale history)", () => {
  // 存储统一 UTC，但「凌晨」按本地小时判定（与 timeOfDayLabel 同一约定）——
  // 这里动态换算「本地 02:00」对应的 UTC 时刻，测试不依赖机器时区。
  const localNight = new Date(2026, 7, 26, 2, 0, 0);
  clock.setNow(clock.toSqliteUtc(localNight));
  try {
    // 10 分钟前刚播完 → 「还在听」是事实。
    sqlite.execute(
      `INSERT INTO music_events(event_id,user_id,track_id,track_title,track_artist,event_type,created_at)
       VALUES('ln-fresh','ln-user','night-song','夜歌','歌手','play_completed',?)`,
      [clock.toSqliteUtc(new Date(localNight.getTime() - 10 * 60_000))],
    );
    assert.equal(notes.getMusicNotePrompt("ln-user", { trackId: "night-song" }).kind, "late_night");

    // 最近事件是三天前 → 凌晨打开面板不许说「还在听」。
    sqlite.execute(
      `INSERT INTO music_events(event_id,user_id,track_id,track_title,track_artist,event_type,created_at)
       VALUES('ln-stale','ln-stale-user','old-song','旧歌','歌手','play_completed',?)`,
      [clock.toSqliteUtc(new Date(localNight.getTime() - 3 * 86_400_000))],
    );
    assert.notEqual(notes.getMusicNotePrompt("ln-stale-user").kind, "late_night");
  } finally {
    clock.setNow("2026-08-25 14:00:00");
  }
});
