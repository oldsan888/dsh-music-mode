import type { Level } from "./logger.js";

/**
 * onResponse 请求日志的分级策略（ADR-8——日志本就是为「排障时信噪比高」而设）。
 *
 * 规则（纯函数，可单测）：
 *  - 5xx → error，4xx → warn：**失败一律 warn+，不管哪个端点，永不藏**；
 *  - 登录态轮询（空闲也每 ~24s 一发、通宵不停，占 http 日志 ~99%）成功时 → **trace**：
 *    排障 dube 行为常开 `LOG_LEVEL=debug`（看 system_prompt / turn_context / 记忆决策），
 *    这类纯基建轮询不该跟着刷屏 → 压到 debug 之下，连 debug 视图都清净；
 *    真要查登录态才 `LOG_HTTP=trace` 召回，信息不丢；
 *  - 高频只读、但**仅活跃播放/渲染时**触发的端点（封面 / 音频代理）成功时 → debug；
 *  - 其余成功请求 → info（对话 / turn / 工具动作 / feishu / player 等有意义的主线）。
 *
 * 只降「本次成功」的噪音，不降失败——所以封面 404、登录态 500 照样跳出来。
 * 精确匹配 path（去 query），避免 /api/coverage 之类被前缀误伤。
 */

/** 登录态轮询：空闲恒发、最刷屏 → 成功压到 trace，debug 视图也清净（真要查才 LOG_HTTP=trace）。 */
export const HTTP_TRACE_PATHS = new Set<string>([
  "/api/login/status", // 网易云登录态轮询（?t= 防缓存）
  "/api/qq/login/status", // QQ 登录态轮询
]);

/** 高频只读、但仅活跃播放/渲染时触发（非空闲噪音）→ 成功降 debug。 */
export const HTTP_QUIET_PATHS = new Set<string>([
  "/api/cover", // 封面图代理（同图多处渲染、高频）
  "/api/audio", // 音频流代理（播放期 Range 分段，极高频）
]);

export type HttpLogLevel = Extract<Level, "trace" | "debug" | "info" | "warn" | "error">;

export function httpRequestLogLevel(url: string, status: number): HttpLogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  const path = url.split("?")[0];
  if (HTTP_TRACE_PATHS.has(path)) return "trace"; // 登录态轮询：debug 也不刷屏
  return HTTP_QUIET_PATHS.has(path) ? "debug" : "info";
}
