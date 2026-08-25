/**
 * QQ 音乐 HTTP 客户端（C4c-2）。封装 musicu POST 与 fcg GET 两类请求。
 *
 * **反向 cookie 默认值（高危，逐字保真 gateway.cjs）**：
 *  - `musicRequest`：仅当 `opts.cookie` 为真才带 Cookie（**默认不带**）——song_detail/搜索匿名。
 *  - `getJSON`：除非 `opts.cookie === false` 才不带 Cookie（**默认带**）——登录态/歌单/评论需带。
 * 翻错任一方向都会让取址/歌单要么丢登录态、要么匿名接口被风控。
 *
 * live qqCookie 经 legacy/gateway.cjs 的 getQQCookie 读取（cookie 写仍在 gateway，留 C4d）。
 */

import { createRequire } from "node:module";
import { requestText } from "../util/http.js";
import { parseJSONText } from "../util/format.js";
import { config } from "../../config.js";

const QQ_MUSICU_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const QQ_SMARTBOX_URL = "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg";

function qqHeaders(): Record<string, string> {
  return { Referer: "https://y.qq.com/", "User-Agent": config.music.userAgent };
}

const requireCjs = createRequire(import.meta.url);
let cachedGateway: { getQQCookie?: () => string } | null = null;
function gatewayModule(): { getQQCookie?: () => string } {
  if (!cachedGateway) cachedGateway = requireCjs("../legacy/gateway.cjs") as { getQQCookie?: () => string };
  return cachedGateway;
}

/** 读 live QQ 登录 cookie（未登录为空串）。 */
export function currentQQCookie(): string {
  try {
    const g = gatewayModule();
    return (g.getQQCookie && g.getQQCookie()) || "";
  } catch {
    return "";
  }
}

export interface QQHttp {
  /** live qqCookie 串（service 据此派生 uin/票据）。 */
  cookie(): string;
  /** musicu.fcg POST：默认不带 cookie，`opts.cookie===true` 才带。 */
  musicRequest(payload: any, opts?: { cookie?: boolean }): Promise<any>;
  /** fcg GET：默认带 cookie，`opts.cookie===false` 才不带。 */
  getJSON(url: string, params: Record<string, any>, opts?: { cookie?: boolean; headers?: Record<string, string> }): Promise<any>;
}

async function musicRequest(payload: any, opts?: { cookie?: boolean }): Promise<any> {
  const options = opts || {};
  const body = JSON.stringify(payload);
  const cookie = currentQQCookie();
  const headers: Record<string, string | number> = {
    ...qqHeaders(),
    "Content-Type": "application/json;charset=UTF-8",
    "Content-Length": Buffer.byteLength(body),
  };
  if (options.cookie && cookie) headers.Cookie = cookie; // 默认不带
  const text = await requestText(QQ_MUSICU_URL, { method: "POST", headers }, body);
  return parseJSONText(text);
}

async function getJSON(url: string, params: Record<string, any>, opts?: { cookie?: boolean; headers?: Record<string, string> }): Promise<any> {
  const options = opts || {};
  const u = new URL(url);
  Object.keys(params || {}).forEach((k) => {
    if (params[k] != null) u.searchParams.set(k, String(params[k]));
  });
  const cookie = currentQQCookie();
  const headers: Record<string, string | number> = { ...qqHeaders(), ...(options.headers || {}) };
  if (options.cookie !== false && cookie) headers.Cookie = cookie; // 默认带
  const text = await requestText(u.toString(), { headers });
  return parseJSONText(text);
}

/** 默认 QQ HTTP 客户端（消费 live qqCookie）。service 可注入替身用于单测。 */
export const qqHttp: QQHttp = { cookie: currentQQCookie, musicRequest, getJSON };

export { QQ_MUSICU_URL, QQ_SMARTBOX_URL };
