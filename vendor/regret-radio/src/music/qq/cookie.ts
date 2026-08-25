/**
 * QQ 音乐 cookie 解析与登录画像归一（C4c-1）。纯函数、无 I/O、无模块级态，可单测。
 *
 * 与 gateway.cjs 的差异（有意）：原 `obj = obj || qqCookieObject()` 会回读模块级 `qqCookie`——
 * 此处一律要求显式传入 cookie 对象（由 service 层用 parseCookieString(live cookie) 提供），剥离副作用。
 * normalizeQQProfile 的 `hasCookie` 改为显式注入（原读模块级 `!!qqCookie`）。
 *
 * 行为保真（高危）：musicKey 含 p_skey 而 playbackKey 不含（取址授权判定依赖此差异）；
 * login_type=2（微信登录）取 wxuin；昵称多键回退 + URL 解码；VIP 数值/标志三路探测。
 */

import { parseCookieString, serializeCookieObject } from "../util/cookie.js";

type CookieObj = Record<string, any>;

/** 去非数字 + 去前导零；全零时回落原数字串。 */
export function normalizeQQUin(raw: unknown): string {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.replace(/^0+/, "") || digits;
}

/** 取登录 uin（login_type=2 微信登录优先 wxuin）。 */
export function qqCookieUin(obj: CookieObj): string {
  const raw =
    Number(obj.login_type) === 2
      ? obj.wxuin || obj.uin || obj.p_uin
      : obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin;
  return normalizeQQUin(raw);
}

/** 登录票据（含 p_skey 等多种）。 */
export function qqCookieMusicKey(obj: CookieObj): string {
  return (
    obj.qm_keyst ||
    obj.qqmusic_key ||
    obj.music_key ||
    obj.p_skey ||
    obj.skey ||
    obj.psrf_qqaccess_token ||
    obj.psrf_qqrefresh_token ||
    obj.wxrefresh_token ||
    obj.wxskey ||
    ""
  );
}

/** 播放授权票据（**不含 p_skey**——与 musicKey 的关键差异）。 */
export function qqCookiePlaybackKey(obj: CookieObj): string {
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.wxskey || "";
}

/** URL 解码（'+'→空格）；非法序列回落原串。 */
export function decodeQQCookieValue(value: unknown): string {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/g, "%20")).trim();
  } catch {
    return String(value || "").trim();
  }
}

/** 昵称：ptnick_<uin> / 补零 / 通用键 / 扫描 ptnick_*，逐一 URL 解码。 */
export function qqCookieNickname(obj: CookieObj, uinInput?: string): string {
  const uin = normalizeQQUin(uinInput || qqCookieUin(obj));
  const padded = uin ? "0" + uin : "";
  const keys = [
    uin && "ptnick_" + uin,
    padded && "ptnick_" + padded,
    "ptnick",
    "nick",
    "nickname",
    "qq_nickname",
  ].filter(Boolean) as string[];
  for (const key of keys) {
    if (obj[key]) {
      const nick = decodeQQCookieValue(obj[key]);
      if (nick) return nick;
    }
  }
  const ptnickKey = Object.keys(obj).find((key) => /^ptnick_/i.test(key) && obj[key]);
  return ptnickKey ? decodeQQCookieValue(obj[ptnickKey]) : "";
}

/** 头像：直采字段优先，否则按 uin 构造 qlogo。 */
export function qqCookieAvatar(obj: CookieObj, uinInput?: string): string {
  const direct = obj.qqmusic_avatar || obj.avatar || obj.avatarUrl || obj.headpic || "";
  if (direct) return decodeQQCookieValue(direct);
  const uin = normalizeQQUin(uinInput || qqCookieUin(obj));
  return uin ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100` : "";
}

/** 登录 cookie 文本归一：补全 uin（login_type=2 取 wxuin）+ 归一，回吐 `k=v; k=v`。 */
export function normalizeQQCookieInput(cookieText: string): string {
  const obj = parseCookieString(cookieText);
  if (Number(obj.login_type) === 2 && obj.wxuin && !obj.uin) obj.uin = obj.wxuin;
  if (!obj.uin && (obj.qqmusic_uin || obj.p_uin)) obj.uin = obj.qqmusic_uin || obj.p_uin;
  if (obj.uin) obj.uin = normalizeQQUin(obj.uin);
  return serializeCookieObject(obj);
}

export interface QQProfile {
  provider: "qq";
  loggedIn: boolean;
  preview: boolean;
  userId: string;
  nickname: string;
  avatar: string;
  vipType: number;
  hasCookie: boolean;
  playbackKeyReady: boolean;
  profileSource: string;
}

/**
 * QQ 登录画像归一。`hasCookie` 显式注入（原读模块级 qqCookie）。
 * body 为 profile 接口响应（可空，仅 cookie 时走兜底）；cookieObj 为已解析的 cookie 对象。
 */
export function normalizeQQProfile(body: any, cookieObj: CookieObj, hasCookie: boolean): QQProfile {
  const uin = qqCookieUin(cookieObj);
  const data = (body && (body.data || body.profile || body.creator || body.result)) || {};
  const creator = data.creator || data.user || data.profile || data || {};
  const vipInfo = data.vipInfo || data.vipinfo || data.vip || creator.vipInfo || creator.vipinfo || {};
  const profileNick = creator.nick || creator.nickname || creator.name || creator.hostname || creator.title || "";
  const profileAvatar = creator.headpic || creator.avatar || creator.avatarUrl || creator.logo || "";
  const cookieNick = qqCookieNickname(cookieObj, uin);
  const nick = profileNick || cookieNick || "";
  const avatar = profileAvatar || qqCookieAvatar(cookieObj, uin);
  let vipType =
    Number(
      cookieObj.vipType ||
        cookieObj.vip_type ||
        data.vipType ||
        data.vip_type ||
        data.viptype ||
        data.music_vip_level ||
        data.green_vip_level ||
        data.luxury_vip_level ||
        creator.vipType ||
        creator.vip_type ||
        creator.music_vip_level ||
        creator.green_vip_level ||
        creator.luxury_vip_level ||
        vipInfo.vipType ||
        vipInfo.vip_type ||
        vipInfo.music_vip_level ||
        vipInfo.green_vip_level ||
        vipInfo.luxury_vip_level ||
        0,
    ) || 0;
  if (!vipType) {
    const vipFlag =
      data.isVip || data.is_vip || data.vipFlag || data.vipflag || creator.isVip || creator.is_vip || vipInfo.isVip || vipInfo.is_vip || vipInfo.vipFlag;
    if (vipFlag === true || Number(vipFlag) > 0 || String(vipFlag || "").toLowerCase() === "true") vipType = 1;
  }
  return {
    provider: "qq",
    loggedIn: !!(uin && qqCookieMusicKey(cookieObj)),
    preview: false,
    userId: uin,
    nickname: nick || (uin ? "QQ " + uin : "QQ 音乐"),
    avatar,
    vipType,
    hasCookie,
    playbackKeyReady: !!qqCookiePlaybackKey(cookieObj),
    profileSource: profileNick || profileAvatar ? "qq-profile" : cookieNick || avatar ? "cookie" : "fallback",
  };
}
