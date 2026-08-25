import { config } from "../config.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * 媒体代理安全边界 + 头部构造（M2-C C2，从原项目 server.js 移植为 TS）。
 *
 * `/api/audio`（Range）与 `/api/cover`（CORS）需要把上游音频/封面 URL 取回中转，
 * 以绕过防盗链/跨域。这是对外发起请求的代理，必须严防 SSRF：
 *   ① 仅 http(s)；② 拒绝内网/环回/链路本地地址；③ host 命中白名单（F10，外置到 config）。
 * 纯函数，便于单测（白名单可注入）。
 */

/** 内网 / 环回 / 链路本地 / 私有网段 → 视为危险，拒绝代理（SSRF 防护）。 */
export function isPrivateHostname(hostname: string): boolean {
  const h = String(hostname || "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost")) return true;
  if (/^(0|10|127)\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (h === "::1" || h === "[::1]") return true;
  if (/^(fc|fd|fe8|fe9|fea|feb)/i.test(h.replace(/^\[/, ""))) return true;
  return false;
}

export function isPrivateIpAddress(value: string): boolean {
  const ip = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) return isPrivateHostname(ip) || ip.startsWith("100.64.") || ip.startsWith("198.18.");
  if (isIP(ip) === 6) return ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || /^fe[89ab]/.test(ip);
  return true;
}

/** URL allowlist plus DNS-result validation; callers must disable redirects so this result cannot be bypassed. */
export async function isSafeResolvedMediaProxyUrl(
  value: string,
  allowlist: string[] = config.music.mediaProxyAllowlist,
  resolver: typeof lookup = lookup,
): Promise<boolean> {
  if (!isAllowedMediaProxyUrl(value, allowlist)) return false;
  const host = new URL(value).hostname;
  if (isIP(host)) return !isPrivateIpAddress(host);
  try {
    const addresses = await resolver(host, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((entry) => !isPrivateIpAddress(entry.address));
  } catch { return false; }
}

/**
 * 判定 URL 是否允许被媒体代理取回。
 * host 须等于白名单某项或为其子域（等价原正则 `(^|\.)domain$`）。
 * @param allowlist 默认取 config.music.mediaProxyAllowlist（F10）；测试可注入。
 */
export function isAllowedMediaProxyUrl(
  value: string,
  allowlist: string[] = config.music.mediaProxyAllowlist,
): boolean {
  let u: URL;
  try {
    u = new URL(String(value || ""));
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  if (isPrivateHostname(host)) return false;
  return allowlist.some((d) => {
    const dom = d.toLowerCase();
    return host === dom || host.endsWith("." + dom);
  });
}

/** 上游音频请求头：UA + Referer（QQ 系换 y.qq.com）+ 透传 Range。 */
export function audioProxyHeadersFor(audioUrl: string, range?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": config.music.userAgent,
    Referer: "https://music.163.com/",
  };
  try {
    const host = new URL(audioUrl).hostname.toLowerCase();
    if (host.includes("qq.com") || host.includes("qpic.cn")) headers.Referer = "https://y.qq.com/";
  } catch {
    /* 非法 URL 在调用前已被 isAllowedMediaProxyUrl 拦截 */
  }
  if (range) headers.Range = range;
  return headers;
}

/** 按扩展名推断音频 Content-Type，回退上游类型。 */
export function audioContentTypeForUrl(audioUrl: string, upstreamType?: string | null): string {
  let pathname = "";
  try {
    pathname = new URL(audioUrl).pathname.toLowerCase();
  } catch {
    /* ignore */
  }
  if (/\.flac$/.test(pathname)) return "audio/flac";
  if (/\.mp3$/.test(pathname)) return "audio/mpeg";
  if (/\.(m4a|mp4)$/.test(pathname)) return "audio/mp4";
  if (/\.ogg$/.test(pathname)) return "audio/ogg";
  if (/\.wav$/.test(pathname)) return "audio/wav";
  return upstreamType || "audio/mpeg";
}
