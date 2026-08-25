/**
 * QQ 登录写（C4d-1）：cookie 登录 / 登出。行为保真下沉 gateway.cjs 的 /api/qq/login/cookie、/api/qq/logout。
 * cookie 写经 cookie-store（过渡委派 gateway）；登录态经 qq/service 的 getQQLoginInfo。依赖可注入，便于单测。
 */

import { getQQLoginInfo } from "./service.js";
import { cookieStore } from "../cookie-store.js";
import { parseCookieString } from "../util/cookie.js";
import { normalizeQQCookieInput, qqCookieUin, qqCookieMusicKey } from "./cookie.js";

export interface QQLoginDeps {
  setCookie: (c: string) => void;
  getQQLoginInfo: () => Promise<Record<string, any>>;
}

function resolveDeps(d?: Partial<QQLoginDeps>): QQLoginDeps {
  return {
    setCookie: d?.setCookie ?? cookieStore.setQQ,
    getQQLoginInfo: d?.getQQLoginInfo ?? getQQLoginInfo,
  };
}

export interface QQLoginResult {
  statusCode: number;
  payload: Record<string, any>;
}

/** 用 cookie 登录：校验 uin + musicKey → 归一写入 → 刷新登录态。 */
export async function qqLoginByCookie(raw: unknown, deps?: Partial<QQLoginDeps>): Promise<QQLoginResult> {
  const d = resolveDeps(deps);
  const normalized = normalizeQQCookieInput(String(raw || ""));
  const obj = parseCookieString(normalized);
  if (!qqCookieUin(obj) || !qqCookieMusicKey(obj)) {
    return { statusCode: 400, payload: { provider: "qq", loggedIn: false, error: "INVALID_QQ_COOKIE", message: "QQ cookie 缺少 uin 或有效登录票据" } };
  }
  d.setCookie(normalized);
  const info = await d.getQQLoginInfo();
  return { statusCode: 200, payload: { ...info, saved: true } };
}

/** 登出：清空 QQ cookie。 */
export function qqLogout(deps?: Partial<QQLoginDeps>): { provider: "qq"; ok: true; loggedIn: false } {
  resolveDeps(deps).setCookie("");
  return { provider: "qq", ok: true, loggedIn: false };
}
