/**
 * 网易云登录写（C4d-1）：cookie 登录 / 登出。行为保真下沉 gateway.cjs 的 /api/login/cookie、/api/logout。
 * cookie 写经 cookie-store（过渡委派 gateway，单一真源）；登录态查询经 client 的 getLoginInfo 桥接。
 * 依赖可注入（cookie 存取 / getLoginInfo / NCM logout），便于单测不联网。
 */

import { neteaseApi, getLoginInfo as bridgeGetLoginInfo } from "./client.js";
import { normalizeLoginInfo, readCookieFromResponse, type NeteaseLoginInfo } from "./login-normalize.js";
import { cookieStore } from "../cookie-store.js";
import { normalizeCookieHeader, parseCookieString } from "../util/cookie.js";
import { createLogger } from "../../logger.js";

const log = createLogger("music");

export interface NeteaseLoginDeps {
  getCookie: () => string;
  setCookie: (c: string) => void;
  getLoginInfo: () => Promise<NeteaseLoginInfo>;
  logout: (params: any) => Promise<any>;
  qrKey: (params: any) => Promise<any>;
  qrCreate: (params: any) => Promise<any>;
  qrCheck: (params: any) => Promise<any>;
}

function resolveDeps(d?: Partial<NeteaseLoginDeps>): NeteaseLoginDeps {
  return {
    getCookie: d?.getCookie ?? cookieStore.getNetease,
    setCookie: d?.setCookie ?? cookieStore.setNetease,
    getLoginInfo: d?.getLoginInfo ?? bridgeGetLoginInfo,
    logout: d?.logout ?? ((p) => neteaseApi().logout(p)),
    qrKey: d?.qrKey ?? ((p) => neteaseApi().login_qr_key(p)),
    qrCreate: d?.qrCreate ?? ((p) => neteaseApi().login_qr_create(p)),
    qrCheck: d?.qrCheck ?? ((p) => neteaseApi().login_qr_check(p)),
  };
}

export interface LoginResult {
  statusCode: number;
  payload: Record<string, any>;
}

/** 用 cookie 登录：校验 MUSIC_U → 归一写入 → getLoginInfo 验证；无效则清 cookie 返回 400（不强制登录态）。 */
export async function loginByCookie(raw: unknown, deps?: Partial<NeteaseLoginDeps>): Promise<LoginResult> {
  const d = resolveDeps(deps);
  const normalized = normalizeCookieHeader(raw);
  const obj = parseCookieString(normalized);
  if (!obj.MUSIC_U) {
    return { statusCode: 400, payload: { loggedIn: false, error: "INVALID_NETEASE_COOKIE", message: "网易云 cookie 缺少 MUSIC_U" } };
  }
  d.setCookie(normalized);
  const info: Record<string, any> = await d.getLoginInfo();
  if (!info.loggedIn) {
    // 验证失败：清除无效 cookie，避免残留导致后续误判已登录（对齐原实现的登录流程：无效返回失败而非强制登录态）
    d.setCookie("");
    return {
      statusCode: 400,
      payload: { loggedIn: false, error: "NETEASE_COOKIE_INVALID", message: "网易云 cookie 无效或已过期，请重新复制 MUSIC_U 的值" },
    };
  }
  return { statusCode: 200, payload: { ...info, saved: true, hasCookie: !!d.getCookie() } };
}

/** 登出：尽力调 NCM logout（吞错）后清空 cookie。 */
export async function logout(deps?: Partial<NeteaseLoginDeps>): Promise<{ ok: true }> {
  const d = resolveDeps(deps);
  try {
    await d.logout({ cookie: d.getCookie() });
  } catch {
    /* best effort */
  }
  d.setCookie("");
  return { ok: true };
}

/** 扫码登录：取 unikey。 */
export async function qrKey(deps?: Partial<NeteaseLoginDeps>): Promise<{ key: unknown }> {
  const r = await resolveDeps(deps).qrKey({ timestamp: Date.now() });
  const key = r.body && r.body.data && r.body.data.unikey;
  return { key };
}

/** 扫码登录：由 unikey 生成二维码图（base64）与跳转 url。 */
export async function qrCreate(key: string, deps?: Partial<NeteaseLoginDeps>): Promise<{ img: unknown; url: unknown }> {
  const r = await resolveDeps(deps).qrCreate({ key, qrimg: true, timestamp: Date.now() });
  const d = r.body && r.body.data;
  return { img: d && d.qrimg, url: d && d.qrurl };
}

/**
 * 扫码登录：轮询状态（803=授权成功 / 802=待确认 / 801=等待扫码 / 800=过期）。
 * 803 时落 cookie（noCookie 首查拿不到则二次重试），刷新登录态，资料未就绪则 pendingProfile 兜底。
 */
export async function qrCheck(key: string, deps?: Partial<NeteaseLoginDeps>): Promise<Record<string, any>> {
  const d = resolveDeps(deps);
  let r = await d.qrCheck({ key, noCookie: true, timestamp: Date.now() });
  let body = r.body || {};
  let code = Number(body.code || r.code);
  let msg = body.message || r.message || "";
  let cookie = readCookieFromResponse(r);
  if (code === 803 && !cookie) {
    try {
      const retry = await d.qrCheck({ key, timestamp: Date.now() });
      const retryCookie = readCookieFromResponse(retry);
      if (retryCookie) {
        r = retry;
        body = retry.body || body;
        code = Number(body.code || retry.code || code);
        msg = body.message || retry.message || msg;
        cookie = retryCookie;
      }
    } catch (e) {
      log.warn("qr_cookie_retry_failed", { error: (e as Error).message });
    }
  }
  if (code === 803) {
    if (cookie) d.setCookie(cookie);
    let info: Record<string, any> = await d.getLoginInfo();
    if (!info.loggedIn) {
      const profile = body.profile || (body.data && body.data.profile) || {};
      info = normalizeLoginInfo(profile, body.account || (body.data && body.data.account), body.data || body);
    }
    if (!info.loggedIn && cookie) {
      info = {
        loggedIn: true,
        pendingProfile: true,
        nickname: body.nickname || (body.profile && body.profile.nickname) || "网易云用户",
        avatar: body.avatarUrl || (body.profile && body.profile.avatarUrl) || "",
        vipType: 0,
        vipLevel: "none",
        isVip: false,
        isSvip: false,
        vipLabel: "无VIP",
      };
    }
    return { code, message: msg, ...info, hasCookie: !!cookie };
  }
  return { code, message: msg, nickname: body.nickname, avatar: body.avatarUrl };
}

/** 登录态查询（经桥接 getLoginInfo）。 */
export async function loginStatus(deps?: Partial<NeteaseLoginDeps>): Promise<NeteaseLoginInfo> {
  return resolveDeps(deps).getLoginInfo();
}
