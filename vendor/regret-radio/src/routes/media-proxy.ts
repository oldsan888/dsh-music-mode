import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import {
  isAllowedMediaProxyUrl,
  isSafeResolvedMediaProxyUrl,
  audioProxyHeadersFor,
  audioContentTypeForUrl,
} from "../music/proxy.js";
import { config } from "../config.js";
import { createLogger } from "../logger.js";

/**
 * 媒体代理路由（M2-C C2）：从 CJS 桥接 TS 化的第一块（安全边界优先）。
 * 用 Fastify 原生流（Readable.fromWeb(上游 web 流)）回传，不 hijack——
 * 因而保留 onResponse 的 http 日志（带 reqId），优于 C1 桥接的 hijack 路径。
 */

const log = createLogger("music");

/**
 * 连接期超时 fetch：只管「拿到响应头」这一步——AbortController 在 timeoutMs 后中止，
 * 但只要 fetch 的 Promise 一 resolve（响应头已到达）就立即 clearTimeout，之后 signal 不再触发。
 * 这是流式转发的关键设计（H1）：绝不能让超时 signal 在 body 流传输阶段触发——
 * 否则播放到一半的歌会被腰斩断流。禁止直接用 AbortSignal.timeout() 一把梭（那个 signal 在
 * body 读取期间仍然存活，一超时同样会中断正在传输的流）。
 */
async function fetchWithConnectTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, redirect: "error", signal: ac.signal });
  } finally {
    clearTimeout(timer); // 响应头已到达（或已抛错）——body 流阶段不再受此超时影响
  }
}

/** GET /api/audio?url= —— 音频代理（透传 Range，回 200/206）。 */
async function proxyAudio(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const target = (req.query as Record<string, string>)?.url;
  if (!target || !isAllowedMediaProxyUrl(target) || !(await isSafeResolvedMediaProxyUrl(target))) {
    return reply
      .code(400)
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .send({ error: "Invalid audio url" });
  }
  const range = (req.headers.range as string) || "";
  let up: Response;
  try {
    up = await fetchWithConnectTimeout(
      target,
      { headers: audioProxyHeadersFor(target, range) },
      config.music.audioProxyConnectTimeoutMs,
    );
  } catch (e) {
    log.warn("audio_upstream_failed", { host: hostOf(target), error: (e as Error).message });
    return reply.code(502).send({ error: "upstream fetch failed" });
  }
  reply.code(up.status);
  reply.header("Content-Type", audioContentTypeForUrl(target, up.headers.get("content-type")));
  reply.header("Accept-Ranges", "bytes");
  const cl = up.headers.get("content-length");
  if (cl) reply.header("Content-Length", cl);
  const cr = up.headers.get("content-range");
  if (cr) reply.header("Content-Range", cr);
  log.debug("audio_proxy", { host: hostOf(target), status: up.status, ranged: !!range });
  return reply.send(up.body ? Readable.fromWeb(up.body as Parameters<typeof Readable.fromWeb>[0]) : null);
}

/** GET /api/cover?url= —— 封面代理（CORS 友好，供 canvas 取像素）。 */
async function proxyCover(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const target = (req.query as Record<string, string>)?.url;
  if (!target || !isAllowedMediaProxyUrl(target) || !(await isSafeResolvedMediaProxyUrl(target))) {
    return reply
      .code(400)
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .send({ error: "Invalid cover url" });
  }
  let up: Response;
  try {
    up = await fetchWithConnectTimeout(
      target,
      { headers: { "User-Agent": config.music.userAgent, Referer: "https://music.163.com/" } },
      config.music.coverProxyConnectTimeoutMs,
    );
  } catch (e) {
    log.warn("cover_upstream_failed", { host: hostOf(target), error: (e as Error).message });
    return reply.code(502).send({ error: "upstream fetch failed" });
  }
  reply.code(up.status);
  reply.header("Content-Type", up.headers.get("content-type") || "image/jpeg");
  reply.header("Cross-Origin-Resource-Policy", "cross-origin");
  reply.header("Cache-Control", "public, max-age=86400");
  const cl = up.headers.get("content-length");
  if (cl) reply.header("Content-Length", cl);
  return reply.send(up.body ? Readable.fromWeb(up.body as Parameters<typeof Readable.fromWeb>[0]) : null);
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

/** 注册媒体代理路由。须在 app.listen 之前、且在桥接之外（桥接已移除 audio/cover）。 */
export function registerMediaProxy(app: FastifyInstance): void {
  app.get("/api/audio", proxyAudio);
  app.get("/api/cover", proxyCover);
  log.info("media_proxy_registered", { routes: 2, allowlist: config.music.mediaProxyAllowlist.length });
}
