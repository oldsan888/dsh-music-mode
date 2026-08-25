/**
 * 网易云 NCM 句柄 + live 登录 cookie 访问（C4b-2）。
 *
 * NCM（NeteaseCloudMusicApi）是 CJS 包，经 createRequire 引入；live cookie 经 legacy/gateway.cjs 的
 * getUserCookie 读取——桥接期 cookie 写入仍在 gateway（saveCookie / POST /api/login/cookie），TS 侧只读，
 * 单一真源不分裂。两处 require 解析到同一绝对路径 → Node require 缓存同一实例，cookie 状态一致。
 *
 * **懒加载**：不在模块顶层 require（否则 import 本模块即触发 gateway.cjs 顶层执行 + NCM 加载），
 * 改为首次调用时加载并缓存——使 service 单测（注入假 NCM）零副作用、不联网、不读 cookie 文件。
 */

import { createRequire } from "node:module";
import type { NeteaseLoginInfo } from "./login-normalize.js";

/** service 层依赖的 NCM 方法子集（只读检索 + 取址 + 播客读）。 */
export interface NeteaseApi {
  cloudsearch: (params: any) => Promise<any>;
  song_detail: (params: any) => Promise<any>;
  song_url_v1: (params: any) => Promise<any>;
  song_url: (params: any) => Promise<any>;
  lyric: (params: any) => Promise<any>;
  lyric_new: (params: any) => Promise<any>;
  logout: (params: any) => Promise<any>;
  login_qr_key: (params: any) => Promise<any>;
  login_qr_create: (params: any) => Promise<any>;
  login_qr_check: (params: any) => Promise<any>;
  comment_music: (params: any) => Promise<any>;
  artist_detail: (params: any) => Promise<any>;
  artist_songs: (params: any) => Promise<any>;
  artist_top_song: (params: any) => Promise<any>;
  playlist_track_all: (params: any) => Promise<any>;
  playlist_detail: (params: any) => Promise<any>;
  dj_hot: (params: any) => Promise<any>;
  dj_detail: (params: any) => Promise<any>;
  dj_program: (params: any) => Promise<any>;
  personalized: (params: any) => Promise<any>;
  recommend_resource: (params: any) => Promise<any>;
  recommend_songs: (params: any) => Promise<any>;
  // C6-3a 用户库 / 我的播客（登录态读）
  user_playlist: (params: any) => Promise<any>;
  song_like_check: (params: any) => Promise<any>;
  likelist: (params: any) => Promise<any>;
  dj_sublist: (params: any) => Promise<any>;
  user_audio: (params: any) => Promise<any>;
  dj_paygift: (params: any) => Promise<any>;
  sati_resource_sub_list: (params: any) => Promise<any>;
  record_recent_voice: (params: any) => Promise<any>;
  // C6-3b 账号写（NCM 导出名：like / playlist_create / playlist_tracks / playlist_track_add）
  like: (params: any) => Promise<any>;
  playlist_create: (params: any) => Promise<any>;
  playlist_tracks: (params: any) => Promise<any>;
  playlist_track_add: (params: any) => Promise<any>;
}

const requireCjs = createRequire(import.meta.url);

let cachedApi: NeteaseApi | null = null;
/** 取（缓存的）NCM 句柄。 */
export function neteaseApi(): NeteaseApi {
  if (!cachedApi) cachedApi = requireCjs("NeteaseCloudMusicApi") as NeteaseApi;
  return cachedApi;
}

interface GatewayBridge {
  getUserCookie?: () => string;
  getLoginInfo?: () => Promise<NeteaseLoginInfo>;
}

let cachedGateway: GatewayBridge | null = null;
function gatewayModule(): GatewayBridge {
  if (!cachedGateway) cachedGateway = requireCjs("../legacy/gateway.cjs") as GatewayBridge;
  return cachedGateway;
}

/** 读 live 网易云登录 cookie（未登录为空串）。 */
export function currentCookie(): string {
  try {
    const g = gatewayModule();
    return (g.getUserCookie && g.getUserCookie()) || "";
  } catch {
    return "";
  }
}

/**
 * 读 live 网易云登录态（取址 VIP 门控用）。经 gateway.cjs 的 getLoginInfo——
 * 其内部 login_status/user_account 拉取 + 鉴权失效时 `saveCookie('')` 写副作用一并留 CJS（单一真源，C4d 收敛）。
 */
export async function getLoginInfo(): Promise<NeteaseLoginInfo> {
  try {
    const g = gatewayModule();
    if (typeof g.getLoginInfo === "function") return await g.getLoginInfo();
  } catch {
    /* 桥接不可用时回落未登录 */
  }
  return { loggedIn: false };
}
