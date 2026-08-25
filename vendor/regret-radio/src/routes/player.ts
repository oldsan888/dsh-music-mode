import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { sendJson } from "./shared.js";
import { createLogger } from "../logger.js";
import { registerPlayer, receivePlayerAck } from "../integrations/player-link.js";

/**
 * 播放器在场通道路由（plans/2026-07-07 阶段 B）：
 *  GET  /api/player/link?user_id= — 长连 SSE，浏览器开页面即挂上（后端主动推命令）；
 *  POST /api/player/ack           — 浏览器执行完命令后回执 { command_id, ok, result }。
 *
 * SSE 用手动可推 Readable（命令是事件驱动、非生成器序列）——与 /api/chat/stream 的
 * Readable.from(generator) 范式不同，这里后端随时 push。断连即注销、清心跳。
 */

const log = createLogger("player");

async function linkRoute(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  const userId = String((req.query as Record<string, string>)?.user_id ?? "").trim();
  if (!userId) return sendJson(reply, { error: "user_id required" }, 400);

  const stream = new Readable({ read() {} });
  const push = (event: string, data: unknown): void => {
    if (!stream.destroyed) stream.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  stream.push(": connected\n\n"); // 初始注释帧，尽快 flush 头
  const unregister = registerPlayer(userId, push);
  // 心跳保活（防代理/NAT idle 断连）。
  const hb = setInterval(() => {
    if (!stream.destroyed) stream.push(": ping\n\n");
  }, 25000);

  // response socket 真关闭时才清（不监听 req.raw 'close'，那个在 body 读完即触发）。
  reply.raw.on("close", () => {
    clearInterval(hb);
    unregister();
    if (!stream.destroyed) stream.destroy();
  });

  return reply
    .header("Content-Type", "text/event-stream; charset=utf-8")
    .header("Cache-Control", "no-cache, no-transform")
    .header("X-Accel-Buffering", "no")
    .header("Connection", "keep-alive")
    .send(stream);
}

async function ackRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const b = (req.body ?? {}) as { command_id?: string; ok?: boolean; result?: string };
  const commandId = typeof b.command_id === "string" ? b.command_id : "";
  if (!commandId) return sendJson(reply, { error: "command_id required" }, 400);
  const matched = receivePlayerAck(
    commandId,
    b.ok !== false,
    typeof b.result === "string" ? b.result : undefined,
  );
  sendJson(reply, { ok: true, matched });
}

/** 注册播放器在场通道路由。须在 app.listen 之前调用。 */
export function registerPlayerLink(app: FastifyInstance): void {
  app.get("/api/player/link", linkRoute);
  app.post("/api/player/ack", ackRoute);
  log.info("player_link_registered", { routes: 2 });
}
