import { describe, expect, it } from "vitest";
import { getCookieRow, secureStoredCookies, setCookieRow } from "../src/music/cookie-store.js";

function fakeDb(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  const db = {
    prepare(sql: string) {
      if (sql.startsWith("SELECT")) return { get: (provider: string) => rows.has(provider) ? { cookie: rows.get(provider) } : undefined };
      if (sql.startsWith("DELETE")) return { run: (provider: string) => rows.delete(provider) };
      return { run: (provider: string, cookie: string) => rows.set(provider, cookie) };
    },
  };
  return { db: db as any, rows };
}

describe("music cookie storage", () => {
  it("persists encrypted material and restores the original cookie", () => {
    const { db, rows } = fakeDb();
    setCookieRow("netease", "MUSIC_U=private-session", db);
    expect(rows.get("netease")).toMatch(/^enc:v1:/);
    expect(rows.get("netease")).not.toContain("private-session");
    expect(getCookieRow("netease", db)).toBe("MUSIC_U=private-session");
  });

  it("upgrades legacy plaintext rows before the gateway can restore them", () => {
    const { db, rows } = fakeDb({ qq: "uin=123; qm_keyst=private" });
    expect(getCookieRow("qq", db)).toBe("");
    secureStoredCookies(db);
    expect(rows.get("qq")).toMatch(/^enc:v1:/);
    expect(getCookieRow("qq", db)).toBe("uin=123; qm_keyst=private");
  });
});
