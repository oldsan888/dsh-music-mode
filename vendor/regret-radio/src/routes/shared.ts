import type { FastifyReply } from "fastify";

/**
 * 统一的 JSON 响应封装：安全响应头（nosniff / no-referrer）+ 禁缓存 + charset。
 *
 * 网易云 / QQ / 天气 / dj-beatmap 等只读路由共用。此前 4 个路由各复制一份完全相同的
 * sendJson——改这套响应头得同步 4 处、极易漂移，故收敛到单一真相源。
 */
export function sendJson(reply: FastifyReply, data: unknown, status = 200): void {
  reply
    .code(status)
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "no-referrer")
    .header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
    .header("Pragma", "no-cache")
    .header("Expires", "0")
    .type("application/json; charset=utf-8")
    .send(data);
}
