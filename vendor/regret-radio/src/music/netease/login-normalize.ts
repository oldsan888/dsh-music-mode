/**
 * 网易云登录态 / VIP 归一（C4b）。把 login_status / user_account 的杂乱响应归一为统一画像。
 * 纯函数、无 I/O（网络拉取在 service 层的 getLoginInfo，留下一增量），可单测。
 *
 * 行为保真（高危）：VIP 探测同时看数值档位、布尔标志与「会员/黑胶/超级会员」文本三路，
 * 漏一路会误判会员等级 → 影响取址时 svip 音质候选过滤（见 quality + handleSongUrl）。
 * 消费 util/cookie（normalizeCookieHeader）与 util/format（normalizeApiCode/Message）。
 */

import { normalizeCookieHeader } from "../util/cookie.js";
import { normalizeApiCode, normalizeApiMessage } from "../util/format.js";

export interface NeteaseVip {
  vipType: number;
  vipLevel: "svip" | "vip" | "none";
  isVip: boolean;
  isSvip: boolean;
  vipLabel: string;
}

export interface NeteaseLoginInfo extends Partial<NeteaseVip> {
  loggedIn: boolean;
  userId?: unknown;
  nickname?: string;
  avatar?: string;
  hasCookie?: boolean;
}

/** 是否网易云 SVIP（取址时据此放行 svip 专属音质候选）。 */
export function hasNeteaseSvip(loginInfo: any): boolean {
  return !!(
    loginInfo &&
    loginInfo.loggedIn &&
    (loginInfo.vipLevel === "svip" || loginInfo.isSvip || Number(loginInfo.vipType || 0) >= 10)
  );
}

/** 在一组对象里按 keys 顺序取第一个「正数」（支持字符串数字），无则 0。 */
export function firstPositiveNumberFrom(objects: any[], keys: string[]): number {
  for (const obj of objects) {
    if (!obj || typeof obj !== "object") continue;
    for (const key of keys) {
      const value = Number(obj[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return 0;
}

/** 递归收集所有非空字符串（深度上限 4）。 */
export function collectStringValues(value: any, out: string[], depth: number): string[] {
  if (depth > 4 || value == null) return out;
  if (typeof value === "string") {
    if (value) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStringValues(item, out, depth + 1));
    return out;
  }
  if (typeof value === "object") {
    Object.keys(value).forEach((key) => collectStringValues(value[key], out, depth + 1));
  }
  return out;
}

/** 只在 vip 相关 key（vip/svip/member/level/label/type…）下收集字符串。 */
export function collectVipStringValues(value: any, out: string[], depth: number): string[] {
  if (depth > 4 || value == null) return out;
  if (Array.isArray(value)) {
    value.forEach((item) => collectVipStringValues(item, out, depth + 1));
    return out;
  }
  if (typeof value !== "object") return out;
  Object.keys(value).forEach((key) => {
    const child = value[key];
    if (/vip|svip|member|associator|privilege|right|level|package|label|title|type/i.test(key)) {
      collectStringValues(child, out, depth + 1);
    } else if (child && typeof child === "object") {
      collectVipStringValues(child, out, depth + 1);
    }
  });
  return out;
}

/** VIP 归一：数值档位 + 布尔标志 + 文本三路综合判定。 */
export function normalizeNeteaseVip(profile: any, account: any, extra: any): NeteaseVip {
  profile = profile || {};
  account = account || {};
  extra = extra || {};
  const vipInfo =
    profile.vipInfo || profile.vipinfo || account.vipInfo || account.vipinfo || extra.vipInfo || extra.vipinfo || {};
  const objects = [account, profile, vipInfo, extra];
  const vipType = firstPositiveNumberFrom(objects, [
    "vipType", "vip_type", "viptype", "musicVipType", "music_vip_type",
    "musicVipLevel", "music_vip_level", "redVipLevel", "red_vip_level",
    "blackVipLevel", "black_vip_level", "luxuryVipLevel", "luxury_vip_level",
    "svipType", "svip_type",
  ]);
  const text = collectVipStringValues({ account, profile, vipInfo, extra }, [], 0).join(" ").toLowerCase();
  const svipFlag =
    objects.some(
      (obj) =>
        obj &&
        (obj.isSvip === true ||
          obj.is_svip === true ||
          obj.svip === true ||
          Number(obj.isSvip || obj.is_svip || obj.svip || obj.svipType || obj.svip_type || 0) > 0),
    ) || /svip|supervip|super_vip|blackvip|black_vip|黑胶svip|超级会员/.test(text);
  const vipFlag =
    objects.some(
      (obj) =>
        obj &&
        (obj.isVip === true ||
          obj.is_vip === true ||
          obj.vip === true ||
          Number(obj.isVip || obj.is_vip || obj.vip || obj.vipFlag || obj.vipflag || 0) > 0),
    ) || /vip|黑胶|会员/.test(text);
  const isSvip = svipFlag || vipType >= 10;
  const isVip = isSvip || vipFlag || vipType > 0;
  const vipLevel: NeteaseVip["vipLevel"] = isSvip ? "svip" : isVip ? "vip" : "none";
  return {
    vipType,
    vipLevel,
    isVip,
    isSvip,
    vipLabel: vipLevel === "svip" ? "SVIP" : vipLevel === "vip" ? "VIP" : "无VIP",
  };
}

/** 登录画像归一：无 userId 即 loggedIn:false，否则 nickname/avatar + VIP。 */
export function normalizeLoginInfo(profile: any, account: any, extra?: any): NeteaseLoginInfo {
  profile = profile || {};
  account = account || {};
  const userId = profile.userId || profile.user_id || profile.id || account.userId || account.id || "";
  if (!(userId || userId === 0)) return { loggedIn: false };
  const vip = normalizeNeteaseVip(profile, account, extra);
  return {
    loggedIn: true,
    userId,
    nickname: profile.nickname || profile.userName || "网易云用户",
    avatar: profile.avatarUrl || profile.avatar || "",
    ...vip,
  };
}

/** 网易云鉴权失效判定（cookie 过期/未登录），命中时调用方清 cookie。 */
export function isNeteaseAuthInvalidPayload(payload: any): boolean {
  const code = normalizeApiCode(payload);
  if (code === 301 || code === 401) return true;
  const msg = normalizeApiMessage(payload);
  return /未登录|需要登录|请先登录|login/i.test(msg) && code >= 300;
}

/** 从登录响应多个可能位置抽取 cookie 头串（经 normalizeCookieHeader 归一）。 */
export function readCookieFromResponse(resp: any): string {
  const candidates = [
    resp && resp.cookie,
    resp && resp.body && resp.body.cookie,
    resp && resp.body && resp.body.data && resp.body.data.cookie,
    resp && resp.body && resp.body.data && resp.body.data.cookies,
  ];
  for (const candidate of candidates) {
    const cookie = normalizeCookieHeader(candidate);
    if (cookie) return cookie;
  }
  return "";
}
