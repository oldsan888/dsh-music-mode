/**
 * Unit tests for src/music/command-whitelist.ts — the 17-command whitelist plus
 * per-command arg-shape validation guarding the DSH command-injection endpoint
 * (design §4.1). Pure function tests: no DB, no network.
 */
import { describe, it, expect } from "vitest";
import {
  ALLOWED_COMMANDS,
  isAllowedCommand,
  validateCommandArgs,
} from "../src/music/command-whitelist.js";

/** The exact 17 music action tools migrated from upstream tools-schema. */
const EXPECTED = [
  "player_next",
  "player_prev",
  "player_toggle",
  "player_pause",
  "player_play",
  "player_volume",
  "set_play_mode",
  "search_music",
  "play_song",
  "play_stage_index",
  "queue_add_song",
  "queue_add_index",
  "play_queue_index",
  "queue_remove",
  "queue_clear",
  "remove_current",
  "rate_song",
];

describe("whitelist surface", () => {
  it("lists exactly the 17 music action tools, all unique", () => {
    const keys = Object.keys(ALLOWED_COMMANDS);
    expect(keys).toHaveLength(17);
    expect(new Set(keys).size).toBe(17);
    expect(keys.sort()).toEqual([...EXPECTED].sort());
  });

  it("excludes the stripped A-side / non-music tools", () => {
    expect(isAllowedCommand("show_weather")).toBe(false);
    expect(isAllowedCommand("set_assistant_name")).toBe(false);
  });

  it("isAllowedCommand truth table", () => {
    expect(isAllowedCommand("player_next")).toBe(true);
    expect(isAllowedCommand("play_song")).toBe(true);
    expect(isAllowedCommand("evil_tool")).toBe(false);
    expect(isAllowedCommand("")).toBe(false);
  });
});

describe("no-arg commands", () => {
  const noArgs = [
    "player_next",
    "player_prev",
    "player_toggle",
    "player_pause",
    "player_play",
    "queue_clear",
    "remove_current",
  ];

  it.each(noArgs)("%s accepts empty args", (name) => {
    expect(validateCommandArgs(name, {})).toEqual({});
  });

  it.each(noArgs)("%s drops stray unknown args", (name) => {
    expect(validateCommandArgs(name, { foo: "bar", n: 1 })).toEqual({});
  });
});

describe("set_play_mode", () => {
  it.each(["loop", "single", "shuffle"])("accepts mode=%s", (mode) => {
    expect(validateCommandArgs("set_play_mode", { mode })).toEqual({ mode });
  });

  it("rejects unknown mode", () => {
    expect(validateCommandArgs("set_play_mode", { mode: "bogus" })).toBeNull();
  });

  it("rejects missing mode", () => {
    expect(validateCommandArgs("set_play_mode", {})).toBeNull();
  });
});

describe("player_volume", () => {
  it("accepts delta in range", () => {
    expect(validateCommandArgs("player_volume", { delta: 0.1 })).toEqual({ delta: 0.1 });
    expect(validateCommandArgs("player_volume", { delta: -1 })).toEqual({ delta: -1 });
    expect(validateCommandArgs("player_volume", { delta: 1 })).toEqual({ delta: 1 });
  });

  it("accepts set in range", () => {
    expect(validateCommandArgs("player_volume", { set: 0.5 })).toEqual({ set: 0.5 });
    expect(validateCommandArgs("player_volume", { set: 0 })).toEqual({ set: 0 });
    expect(validateCommandArgs("player_volume", { set: 1 })).toEqual({ set: 1 });
  });

  it("accepts empty args (no-op, volume untouched)", () => {
    expect(validateCommandArgs("player_volume", {})).toEqual({});
  });

  it("rejects delta out of range", () => {
    expect(validateCommandArgs("player_volume", { delta: 1.5 })).toBeNull();
    expect(validateCommandArgs("player_volume", { delta: -1.5 })).toBeNull();
  });

  it("rejects set out of range", () => {
    expect(validateCommandArgs("player_volume", { set: -0.1 })).toBeNull();
    expect(validateCommandArgs("player_volume", { set: 1.1 })).toBeNull();
  });

  it("rejects non-number values", () => {
    expect(validateCommandArgs("player_volume", { delta: "0.5" })).toBeNull();
    expect(validateCommandArgs("player_volume", { set: NaN })).toBeNull();
  });

  it("rejects both delta and set (protocol: exactly one)", () => {
    expect(validateCommandArgs("player_volume", { delta: 0.1, set: 0.5 })).toBeNull();
  });
});

describe("query commands (search_music / play_song / queue_add_song)", () => {
  it.each(["search_music", "play_song", "queue_add_song"])(
    "%s accepts and trims a non-empty query",
    (name) => {
      expect(validateCommandArgs(name, { query: "  示例歌曲 示例歌手甲  " })).toEqual({
        query: "示例歌曲 示例歌手甲",
      });
    },
  );

  it.each(["search_music", "play_song", "queue_add_song"])(
    "%s rejects empty / whitespace / missing query",
    (name) => {
      expect(validateCommandArgs(name, { query: "" })).toBeNull();
      expect(validateCommandArgs(name, { query: "   " })).toBeNull();
      expect(validateCommandArgs(name, {})).toBeNull();
    },
  );

  it("rejects non-string query", () => {
    expect(validateCommandArgs("play_song", { query: 42 })).toBeNull();
  });
});

describe("index commands (play_stage_index / queue_add_index / play_queue_index / queue_remove)", () => {
  const names = [
    "play_stage_index",
    "queue_add_index",
    "play_queue_index",
    "queue_remove",
  ];

  it.each(names)("%s accepts positive integer index", (name) => {
    expect(validateCommandArgs(name, { index: 3 })).toEqual({ index: 3 });
  });

  it.each(names)("%s rejects index 0 / negative / float / string / missing", (name) => {
    expect(validateCommandArgs(name, { index: 0 })).toBeNull();
    expect(validateCommandArgs(name, { index: -1 })).toBeNull();
    expect(validateCommandArgs(name, { index: 1.5 })).toBeNull();
    expect(validateCommandArgs(name, { index: "2" })).toBeNull();
    expect(validateCommandArgs(name, {})).toBeNull();
  });
});

describe("rate_song", () => {
  it("accepts boolean liked", () => {
    expect(validateCommandArgs("rate_song", { liked: true })).toEqual({ liked: true });
    expect(validateCommandArgs("rate_song", { liked: false })).toEqual({ liked: false });
  });

  it("rejects non-boolean / missing liked", () => {
    expect(validateCommandArgs("rate_song", { liked: "yes" })).toBeNull();
    expect(validateCommandArgs("rate_song", { liked: 1 })).toBeNull();
    expect(validateCommandArgs("rate_song", {})).toBeNull();
  });
});

describe("unknown command / malformed input", () => {
  it("validateCommandArgs rejects unknown names, even with valid-looking args", () => {
    expect(validateCommandArgs("evil_tool", { query: "示例歌曲" })).toBeNull();
  });

  it("tolerates null / undefined / non-object args on known commands", () => {
    for (const name of EXPECTED) {
      const result = validateCommandArgs(name, null as unknown);
      // Must not throw; a cleaned object or null are both fine, never a throw.
      expect(result === null || typeof result === "object").toBe(true);
    }
  });

  it("never lets extra fields leak into the forwarded args", () => {
    const clean = validateCommandArgs("play_song", {
      query: "示例歌曲",
      ctor: "polluted",
      __proto__: { hacked: true },
    });
    expect(clean).toEqual({ query: "示例歌曲" });
  });
});
