/**
 * 网易云播客只读 service（C4b-3）：搜索 / 热门 / 详情 / 节目列表。
 * 行为保真下沉 legacy/gateway.cjs 对应 handler；映射复用 netease/mappers 的 podcast 系列（已单测）。
 * NCM 可注入、cookie 默认 currentCookie()——可注入假 NCM 单测、不联网。
 *
 * 注：「我的播客」（podcast/my、my/items）C6-3a 已迁入本文件（fetchMyPodcastItems + handleMyPodcast/Items，登录态读）；
 * dj-beatmap（DSP 分析）仍走 dj-analyzer.cjs 桥接，故 /api/podcast/* 通配保留仅服务它，这里的只读路由为静态覆盖。
 */

import { neteaseApi, currentCookie, getLoginInfo as bridgeGetLoginInfo, type NeteaseApi } from "./client.js";
import {
  mapPodcastRadio,
  mapPodcastProgram,
  mapPodcastCollectionRadio,
  mapPodcastVoice,
  podcastCollectionMeta,
  firstArrayFrom,
} from "./mappers.js";
import type { NeteaseLoginInfo } from "./login-normalize.js";
import { createLogger } from "../../logger.js";

const log = createLogger("music");

/** 播客搜索（cloudsearch type=1009）。 */
export async function handlePodcastSearch(
  keywords: string,
  limit: number,
  api: NeteaseApi = neteaseApi(),
  cookie: string = currentCookie(),
): Promise<{ podcasts: ReturnType<typeof mapPodcastRadio>[]; total: number }> {
  const r = await api.cloudsearch({ keywords, type: 1009, limit, cookie, timestamp: Date.now() });
  const result = (r.body && r.body.result) || {};
  const raw = result.djRadios || result.djradios || result.radios || [];
  const podcasts = raw.map(mapPodcastRadio).filter((p: { id: unknown }) => p.id);
  return { podcasts, total: result.djRadiosCount || result.djradiosCount || podcasts.length };
}

/** 热门播客（dj_hot）。 */
export async function handlePodcastHot(
  limit: number,
  offset: number,
  api: NeteaseApi = neteaseApi(),
  cookie: string = currentCookie(),
): Promise<{ podcasts: ReturnType<typeof mapPodcastRadio>[]; more: boolean }> {
  const r = await api.dj_hot({ limit, offset, cookie, timestamp: Date.now() });
  const body = r.body || {};
  const raw = body.djRadios || body.djradios || body.radios || body.data || [];
  const podcasts = (Array.isArray(raw) ? raw : []).map(mapPodcastRadio).filter((p: { id: unknown }) => p.id);
  return { podcasts, more: !!body.hasMore };
}

/** 播客电台详情（dj_detail）。 */
export async function handlePodcastDetail(
  rid: string,
  api: NeteaseApi = neteaseApi(),
  cookie: string = currentCookie(),
): Promise<{ podcast: ReturnType<typeof mapPodcastRadio> }> {
  const r = await api.dj_detail({ rid, cookie, timestamp: Date.now() });
  const body = r.body || {};
  const radio = mapPodcastRadio(body.data || body.djRadio || body.radio || body);
  return { podcast: radio };
}

/** 播客节目列表（dj_program，倒序）。radio 取首条节目自带电台，缺失则兜底 {id:rid,rid}。 */
export async function handlePodcastPrograms(
  rid: string,
  limit: number,
  offset: number,
  api: NeteaseApi = neteaseApi(),
  cookie: string = currentCookie(),
): Promise<{ radio: any; programs: ReturnType<typeof mapPodcastProgram>[]; more: boolean; total: number }> {
  const r = await api.dj_program({ rid, limit, offset, asc: false, cookie, timestamp: Date.now() });
  const body = r.body || {};
  const raw = body.programs || (body.data && (body.data.list || body.data.programs)) || [];
  const radio = raw[0] && raw[0].radio ? mapPodcastRadio(raw[0].radio) : { id: rid, rid };
  const programs = (Array.isArray(raw) ? raw : [])
    .map((p: any) => mapPodcastProgram(p, radio))
    .filter((p) => p.id && p.name);
  return { radio, programs, more: !!body.more, total: body.count || programs.length };
}

// ---------- 我的播客（C6-3a，登录态读）----------

/**
 * 取「我的播客」某集合条目。collect=订阅电台(dj_sublist) / created=创建(user_audio) / paid=付费(dj_paygift) /
 * liked=喜欢的声音（sati_resource_sub_list 空则回退 record_recent_voice）。逐字沿用 legacy fetchMyPodcastItems。
 */
export async function fetchMyPodcastItems(
  key: string,
  info: NeteaseLoginInfo,
  limit: number,
  offset: number,
  api: NeteaseApi = neteaseApi(),
  cookie: string = currentCookie(),
): Promise<{ itemType: string; items: any[] }> {
  const lim = Math.max(8, Math.min(60, Number(limit) || 30));
  const off = Math.max(0, Number(offset) || 0);
  if (key === "collect") {
    const r = await api.dj_sublist({ limit: lim, offset: off, cookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ["djRadios", "djradios", "radios", "data"]);
    return { itemType: "radio", items: raw.map((x: any) => mapPodcastCollectionRadio(x, key)).filter((x) => x.id) };
  }
  if (key === "created") {
    const r = await api.user_audio({ uid: info.userId, cookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ["data", "djRadios", "djradios", "radios"]);
    return { itemType: "radio", items: raw.map((x: any) => mapPodcastCollectionRadio(x, key)).filter((x) => x.id) };
  }
  if (key === "paid") {
    const r = await api.dj_paygift({ limit: lim, offset: off, cookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ["data", "djRadios", "djradios", "radios"]);
    return { itemType: "radio", items: raw.map((x: any) => mapPodcastCollectionRadio(x, key)).filter((x) => x.id) };
  }
  if (key === "liked") {
    let raw: any[] = [];
    try {
      const sati = await api.sati_resource_sub_list({ cookie, timestamp: Date.now() });
      raw = firstArrayFrom(sati.body, ["data", "resources", "list"]);
    } catch (e) {
      log.warn("my_podcast_liked_sati_failed", { error: (e as Error).message });
    }
    if (!raw.length) {
      try {
        const recent = await api.record_recent_voice({ limit: lim, cookie, timestamp: Date.now() });
        raw = firstArrayFrom(recent.body, ["data", "list", "resources"]);
      } catch (e) {
        log.warn("my_podcast_liked_recent_failed", { error: (e as Error).message });
      }
    }
    return { itemType: "voice", items: raw.map(mapPodcastVoice).filter((x) => x.id && x.name) };
  }
  return { itemType: "radio", items: [] };
}

/** 我的播客首页：collect/created/liked 三源 Promise.all 组装为集合 meta，单源失败回空 meta 不拖垮。 */
export async function handleMyPodcast(
  api: NeteaseApi = neteaseApi(),
  getLoginInfoFn: () => Promise<NeteaseLoginInfo> = bridgeGetLoginInfo,
  cookie: string = currentCookie(),
): Promise<{ loggedIn: boolean; collections: any[] }> {
  const info = await getLoginInfoFn();
  if (!info.loggedIn || !info.userId) {
    return { loggedIn: false, collections: ["collect", "created", "liked"].map((k) => podcastCollectionMeta(k, [])) };
  }
  const keys = ["collect", "created", "liked"];
  const collections = await Promise.all(
    keys.map(async (key) => {
      try {
        const data = await fetchMyPodcastItems(key, info, 12, 0, api, cookie);
        return podcastCollectionMeta(key, data.items || []);
      } catch (e) {
        log.warn("my_podcast_failed", { key, error: (e as Error).message });
        return podcastCollectionMeta(key, []);
      }
    }),
  );
  return { loggedIn: true, collections };
}

/** 我的播客某集合条目列表（my/items?key=&limit=&offset=）。 */
export async function handleMyPodcastItems(
  key: string,
  limit: number,
  offset: number,
  api: NeteaseApi = neteaseApi(),
  getLoginInfoFn: () => Promise<NeteaseLoginInfo> = bridgeGetLoginInfo,
  cookie: string = currentCookie(),
): Promise<Record<string, any>> {
  const info = await getLoginInfoFn();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, items: [] };
  const data = await fetchMyPodcastItems(key, info, limit, offset, api, cookie);
  // podcastCollectionMeta 已含 key（值同传入 key），不再显式列以免 TS2783 覆盖告警。
  return { loggedIn: true, ...podcastCollectionMeta(key, data.items || []), itemType: data.itemType, items: data.items || [] };
}
