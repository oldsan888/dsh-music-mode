/**
 * Cookie 归一/解析共享工具（§3.1，netease+qq 共用）。纯函数、无 I/O、无模块级态，可单测。
 *
 * 注意（CJS 隐患规避）：原 gateway 的 saveCookie/saveQQCookie 含 fs 写 + 模块级可变 userCookie/qqCookie，
 * 那部分属"持久化"，留给 cookie-store（C4 注入 fs/路径），**此处只放纯归一逻辑**。
 */

const COOKIE_ATTRIBUTE_NAMES = new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "samesite",
  "secure",
  "httponly",
]);

function collectCookiePair(picked: Map<string, string>, key: string, value: unknown): void {
  const k = String(key || "").trim();
  if (!k || COOKIE_ATTRIBUTE_NAMES.has(k.toLowerCase())) return;
  if (value === null || value === undefined) return;
  picked.set(k, String(value).trim());
}

function collectCookieInput(input: unknown, picked: Map<string, string>): void {
  if (input === null || input === undefined) return;
  if (Array.isArray(input)) {
    input.forEach((item) => collectCookieInput(item, picked));
    return;
  }
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (obj.name && Object.prototype.hasOwnProperty.call(obj, "value")) {
      collectCookiePair(picked, String(obj.name), obj.value);
      return;
    }
    Object.keys(obj).forEach((key) => {
      const value = obj[key];
      if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) {
        collectCookiePair(picked, key, (value as { value: unknown }).value);
      } else if (typeof value !== "object") {
        collectCookiePair(picked, key, value);
      }
    });
    return;
  }
  String(input)
    .split(/\r?\n/)
    .forEach((line) => {
      line.split(";").forEach((part) => {
        const raw = String(part || "").trim();
        const idx = raw.indexOf("=");
        if (idx <= 0) return;
        collectCookiePair(picked, raw.slice(0, idx), raw.slice(idx + 1));
      });
    });
}

/** 把 字符串 / 数组 / 对象 / {name,value} 等形态的 cookie 输入归一为 `k=v; k=v` 头串（过滤属性名）。 */
export function normalizeCookieHeader(input: unknown): string {
  const picked = new Map<string, string>();
  collectCookieInput(input, picked);
  return Array.from(picked.entries())
    .filter(([key, value]) => key && value != null && String(value) !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

/** normalize 为空时的原样兜底（string 或全 string 数组 join）。 */
export function rawCookieFallback(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (Array.isArray(input) && input.every((item) => typeof item === "string")) {
    return (input as string[]).join("; ").trim();
  }
  return "";
}

/** `k=v; k=v` 串 → 对象（idx<=0 的片段跳过）。 */
export function parseCookieString(cookieText: string): Record<string, string> {
  const out: Record<string, string> = {};
  String(cookieText || "")
    .split(";")
    .forEach((part) => {
      const raw = String(part || "").trim();
      if (!raw) return;
      const idx = raw.indexOf("=");
      if (idx <= 0) return;
      const key = raw.slice(0, idx).trim();
      const value = raw.slice(idx + 1).trim();
      if (key) out[key] = value;
    });
  return out;
}

/** 对象 → `k=v; k=v` 串（过滤空值）。 */
export function serializeCookieObject(obj: Record<string, unknown>): string {
  return Object.keys(obj || {})
    .filter((k) => obj[k] != null && String(obj[k]) !== "")
    .map((k) => k + "=" + String(obj[k]))
    .join("; ");
}
