import { appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { config } from "./config.js";

/**
 * Scoped logger（ADR-8，零依赖，替换旧单开关 logger）。
 *
 * 设计要点（详见 plans/02-config-and-logging.md 第二部分）：
 * - 真·分级：silent < error < warn < info < debug < trace；主开关 LOG_LEVEL（别名 LOG）。
 * - 真·scoped：createLogger(scope) 绑定域；每域可经 LOG_<SCOPE> 单独调级（动态读 env）。
 * - reqId/turnId/userId 贯穿：child() 合并 ctx，runTurnStream 建子 logger 往下游透传。
 * - 统一截断脱敏（redactAndTruncate）：音频只记 bytes、向量只记 dim、长文本/数组截断、密钥脱敏。
 * - 真·按天滚动：每次写按当天日期算文件名（修旧版“文件名启动时算死”）；LOG_MAX_DAYS 清理。
 * - 结构化 JSON Lines：ts/level/scope/reqId/turnId/userId/msg/data/durationMs。
 * - 兼容 shim：保留旧 logger.info(category,event,data,ms) 等全部 API，渐进迁移不破坏现有调用。
 */

export const LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
} as const;

/** 可调用的日志级别（不含 silent，silent 仅作阈值） */
export type Level = "error" | "warn" | "info" | "debug" | "trace";
type LevelName = keyof typeof LEVELS;

export interface Ctx {
  reqId?: string;
  turnId?: string;
  userId?: string;
}

export interface LogRecord {
  ts: string;
  level: LevelName;
  scope: string;
  reqId?: string;
  turnId?: string;
  userId?: string;
  msg: string;
  data?: unknown;
  durationMs?: number;
}

export interface RedactOpts {
  maxStr: number;
  maxArr: number;
  maxDepth: number;
  /** 已小写化的脱敏字段名 */
  redactKeys: string[];
  audioBytesOnly: boolean;
}

/* ─────────── 纯函数：级别解析 ─────────── */

/** 把级别名解析为阈值；非法/空/原型链属性名一律返回 undefined。 */
function levelValue(name: string | undefined): number | undefined {
  if (!name) return undefined;
  return Object.prototype.hasOwnProperty.call(LEVELS, name) ? LEVELS[name as LevelName] : undefined;
}

/**
 * 解析某 scope 的有效阈值。LOG_<SCOPE> 动态优先于全局 config.log.level。
 * （域级覆盖须运行时即时生效，故此处按需读 env——这是 logger 作为基础设施的有意例外。）
 * 单域值仅在是合法级别名时生效；空串/拼错则回落全局基线（避免拼错反而把噪声调高）。
 */
export function resolveLevel(scope: string): number {
  const per = levelValue(process.env[`LOG_${scope.toUpperCase()}`]);
  if (per !== undefined) return per;
  return levelValue(config.log.level) ?? LEVELS.info;
}

/* ─────────── 纯函数：脱敏 + 截断 ─────────── */

function defaultRedactOpts(): RedactOpts {
  return {
    maxStr: config.log.maxStr,
    maxArr: config.log.maxArr,
    maxDepth: config.log.maxDepth,
    redactKeys: config.log.redactKeys,
    audioBytesOnly: config.log.audioBytesOnly,
  };
}

const AUDIO_KEY_RE = /(wav_b64|refaudiobase64|datauri|^audio$|pcm|^wav$)/;
const VECTOR_KEY_RE = /(embedding|vector)/;

/** base64（或 dataURI）字符串估算字节数 */
function base64Bytes(s: string): number {
  const b64 = s.includes(",") ? s.slice(s.indexOf(",") + 1) : s;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/**
 * 统一截断脱敏，防日志爆炸 / 防 PII 泄漏。不修改入参。
 * - 音频字段（wav_b64/refAudioBase64/dataUri/audio…）只记 { bytes }。
 * - 向量字段（embedding/vector）只记 { dim }。
 * - 脱敏字段（redactKeys 命中，大小写不敏感）→ "***"。
 * - 长字符串截断到 maxStr + "…(+N)"；数组超 maxArr 截尾 + "…(+N more)"；递归深度上限 maxDepth。
 */
export function redactAndTruncate(data: unknown, opts: RedactOpts = defaultRedactOpts()): unknown {
  return walk(data, opts, 0);
}

function walk(value: unknown, opts: RedactOpts, depth: number): unknown {
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === "string") {
    const s = value as string;
    return s.length > opts.maxStr ? `${s.slice(0, opts.maxStr)}…(+${s.length - opts.maxStr})` : s;
  }
  if (t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "function" || t === "symbol") return `[${t}]`;

  if (Array.isArray(value)) {
    if (depth >= opts.maxDepth) return "[Array]";
    if (value.length > opts.maxArr) {
      const head = value.slice(0, opts.maxArr).map((v) => walk(v, opts, depth + 1));
      return [...head, `…(+${value.length - opts.maxArr} more)`];
    }
    return value.map((v) => walk(v, opts, depth + 1));
  }

  if (t === "object") {
    if (depth >= opts.maxDepth) return "[Object]";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      if (opts.audioBytesOnly && AUDIO_KEY_RE.test(lk) && typeof v === "string") {
        out[k] = { bytes: base64Bytes(v) };
      } else if (opts.redactKeys.some((rk) => lk.includes(rk))) {
        // 子串匹配：变体 key（session_cookie / x-api_key / authorization_header）一并脱敏（宁可多脱）
        out[k] = "***";
      } else if (VECTOR_KEY_RE.test(lk) && Array.isArray(v)) {
        // 向量一律只记维度（不受 maxArr 限制），与文档不变式一致
        out[k] = { dim: v.length };
      } else {
        out[k] = walk(v, opts, depth + 1);
      }
    }
    return out;
  }

  return String(value);
}

/* ─────────── 纯函数：文件名 / 格式化 ─────────── */

/** 本地日期 YYYY-MM-DD——按天滚动用【本地时区】。此前用 toISOString()（UTC）：
 *  UTC+8 下每天 08:00 前的日志都落进"昨天"的文件（真机实锤 07-04 白天仍写 07-03.jsonl）。 */
function localDay(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 按天滚动文件名：<dir>/regret-radio-YYYY-MM-DD.jsonl（本地日期） */
export function logFileName(date: Date, dir: string): string {
  return join(dir, `regret-radio-${localDay(date)}.jsonl`);
}

const COLOR: Record<LevelName, string> = {
  silent: "",
  error: "\x1b[31m",
  warn: "\x1b[33m",
  info: "\x1b[36m",
  debug: "\x1b[90m",
  trace: "\x1b[90m",
};
const RESET = "\x1b[0m";

/** pretty 控制台单行（不含颜色，便于测试）：HH:mm:ss.SSS LEVEL [scope] msg (123ms) {data} */
export function formatLine(rec: LogRecord): string {
  const time = rec.ts.slice(11, 23); // HH:mm:ss.SSS
  const dur = rec.durationMs !== undefined ? ` (${Math.round(rec.durationMs)}ms)` : "";
  const ids = [rec.reqId, rec.turnId].filter(Boolean).join("/");
  const idStr = ids ? ` <${ids}>` : "";
  const data = rec.data !== undefined ? ` ${JSON.stringify(rec.data)}` : "";
  return `${time} ${rec.level.toUpperCase().padEnd(5)} [${rec.scope}]${idStr} ${rec.msg}${dur}${data}`;
}

/* ─────────── 输出（sink，可替换以便测试） ─────────── */

type Sink = (rec: LogRecord) => void;

function resolvedLogDir(): string {
  const dir = config.log.dir;
  return isAbsolute(dir) ? dir : join(process.cwd(), dir);
}

// 记录上次“确保目录 + 跑清理”的日期；跨天即重做，使保留策略在长进程里每天生效（而非仅启动一次）。
let lastEnsuredDay = "";

/** 清理超过 LOG_MAX_DAYS 的历史 .jsonl。每天滚动时调用一次。 */
function cleanupOldLogs(dir: string): void {
  if (config.log.maxDays <= 0) return; // 0/负数视为“不清理”，避免误删当天甚至全部
  try {
    const cutoff = Date.now() - config.log.maxDays * 24 * 3600 * 1000;
    for (const f of readdirSync(dir)) {
      const m = /^(?:regret-radio|regretio)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      if (new Date(`${m[1]}T00:00:00.000Z`).getTime() < cutoff) {
        try {
          unlinkSync(join(dir, f));
        } catch {
          /* 单个删除失败忽略 */
        }
      }
    }
  } catch {
    /* 目录不存在等忽略 */
  }
}

function defaultSink(rec: LogRecord): void {
  // 控制台
  if (config.log.format === "json") {
    const line = JSON.stringify(rec);
    if (rec.level === "error") console.error(line);
    else if (rec.level === "warn") console.warn(line);
    else console.log(line);
  } else {
    const line = COLOR[rec.level] + formatLine(rec) + RESET;
    if (rec.level === "error") console.error(line);
    else if (rec.level === "warn") console.warn(line);
    else console.log(line);
  }

  // 文件（JSON Lines，真·按天滚动）
  if (config.log.toFile) {
    const dir = resolvedLogDir();
    const day = localDay();
    try {
      // 跨天（或首次）重新确保目录存在并跑保留清理——修“长进程保留无界 / 目录被删后不恢复”。
      if (day !== lastEnsuredDay) {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        cleanupOldLogs(dir);
        lastEnsuredDay = day;
      }
      appendFileSync(logFileName(new Date(), dir), JSON.stringify(rec) + "\n");
    } catch {
      // 日志落盘失败绝不影响主流程
    }
  }
}

let sink: Sink = defaultSink;

/** 替换输出 sink（测试用：捕获记录） */
export function setSink(s: Sink): void {
  sink = s;
}
/** 恢复默认 sink（控制台 + 文件） */
export function resetSink(): void {
  sink = defaultSink;
}

/* ─────────── createLogger ─────────── */

export interface ScopedLogger {
  readonly scope: string;
  error(msg: string, data?: unknown, durationMs?: number): void;
  warn(msg: string, data?: unknown, durationMs?: number): void;
  info(msg: string, data?: unknown, durationMs?: number): void;
  debug(msg: string, data?: unknown, durationMs?: number): void;
  trace(msg: string, data?: unknown, durationMs?: number): void;
  child(extra: Ctx): ScopedLogger;
}

export function createLogger(scope: string, ctx: Ctx = {}): ScopedLogger {
  function emit(level: Level, msg: string, data?: unknown, durationMs?: number): void {
    if (LEVELS[level] > resolveLevel(scope)) return;
    const rec: LogRecord = { ts: new Date().toISOString(), level, scope, msg };
    if (ctx.reqId !== undefined) rec.reqId = ctx.reqId;
    if (ctx.turnId !== undefined) rec.turnId = ctx.turnId;
    if (ctx.userId !== undefined) rec.userId = ctx.userId;
    if (data !== undefined) rec.data = redactAndTruncate(data);
    if (durationMs !== undefined) rec.durationMs = durationMs;
    sink(rec);
  }
  return {
    scope,
    error: (m, d, t) => emit("error", m, d, t),
    warn: (m, d, t) => emit("warn", m, d, t),
    info: (m, d, t) => emit("info", m, d, t),
    debug: (m, d, t) => emit("debug", m, d, t),
    trace: (m, d, t) => emit("trace", m, d, t),
    child: (extra) => createLogger(scope, { ...ctx, ...extra }),
  };
}

/* ─────────── 便捷 logger：createLogger 的懒包装（按 category 建 child logger） ─────────── */

export const logger = {
  info: (category: string, event: string, data?: unknown, duration_ms?: number) =>
    createLogger(category).info(event, data, duration_ms),
  warn: (category: string, event: string, data?: unknown) =>
    createLogger(category).warn(event, data),
  error: (category: string, event: string, data?: unknown) =>
    createLogger(category).error(event, data),
  debug: (category: string, event: string, data?: unknown, duration_ms?: number) =>
    createLogger(category).debug(event, data, duration_ms),

  userMessage: (user_id: string, content: string) =>
    createLogger("chat", { userId: user_id }).info("user_message", { content }),
  assistantResponse: (user_id: string, content: string, duration_ms: number) =>
    createLogger("chat", { userId: user_id }).info("assistant_response", { content }, duration_ms),
  extraction: (
    user_id: string,
    result: { should_write: boolean; reason: string; candidates: number },
    duration_ms: number,
  ) => createLogger("memory", { userId: user_id }).info("extraction_result", result, duration_ms),
  gateDecision: (user_id: string, action: string, reason: string, candidate_count: number) =>
    createLogger("memory", { userId: user_id }).info("decision", { action, reason, candidate_count }),
  memoryWrite: (
    user_id: string,
    memory_type: string,
    key: string | null,
    content: string,
    status: string,
  ) => createLogger("memory", { userId: user_id }).info("write", { memory_type, key, content, status }),
  fastPath: (user_id: string, rules: string[], written: number) =>
    createLogger("memory", { userId: user_id }).info("fast_path", { rules, written }),
  toolCall: (user_id: string, name: string, args: Record<string, unknown>) =>
    createLogger("tool", { userId: user_id }).info("tool_call", { name, args }),
  apiRequest: (method: string, url: string, status: number, duration_ms: number) =>
    createLogger("http").info("request", { method, url, status }, duration_ms),
};

/** 获取今日日志文件路径（按天滚动；供 /api/debug/log 读取） */
export function getLogFilePath(): string {
  return logFileName(new Date(), resolvedLogDir());
}
