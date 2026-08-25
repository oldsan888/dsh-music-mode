import { describe, expect, it } from "vitest";
import { canAccessDebugLog } from "../src/security/debug-log.js";

describe("debug-log access", () => {
  it("is disabled by default", () => {
    expect(canAccessDebugLog("127.0.0.1", false)).toBe(false);
  });

  it("allows only loopback when explicitly enabled", () => {
    expect(canAccessDebugLog("127.0.0.1", true)).toBe(true);
    expect(canAccessDebugLog("::1", true)).toBe(true);
    expect(canAccessDebugLog("192.168.1.20", true)).toBe(false);
  });
});
