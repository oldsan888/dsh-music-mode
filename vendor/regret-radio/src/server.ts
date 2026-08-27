/**
 * DSH music-only vendored Regret-radio backend (server entry).
 *
 * Slim variant of the upstream Regret-radio server (see README: this vendor is
 * a DSH-specialized fork; upstream A-side — LLM / memory / feishu / weather /
 * scheduler / proactivity / STT / TTS — is stripped; 阿呆 (the DSH agent) is
 * the brain).
 *
 * Kept from upstream:
 * - Fastify + multipart, reqId + http lifecycle logging, /health
 * - Music core: /api/music/events + preferences (taste), netease + qq routes,
 *   media proxy (audio/cover), beatmap + dj-beatmap, music gates, cookie store
 * - Player presence channel: /api/player/link (SSE) + /api/player/ack — the
 *   browser player mounts this, reused for music commands.
 *
 * Added (DSH-specific overlay, §4 of the design doc):
 * - POST /api/player/command  — local command injection (whitelist + arg shape
 *   check + loopback). DSH agent tools call this to drive the music-tab player.
 * - POST/GET /api/player/state — player snapshot channel: the browser player
 *   pushes its state here; DSH reads the latest snapshot (truth source = browser).
 */

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { ulid } from "ulid";
import { config, configSummary } from "./config.js";
import { isLoopbackAddress } from "./security/loopback.js";
import { canAccessDebugLog } from "./security/debug-log.js";
import { logger, createLogger, getLogFilePath } from "./logger.js";
import { httpRequestLogLevel } from "./http-log.js";
import { query } from "./store/sqlite.js";
import { registerMediaProxy } from "./routes/media-proxy.js";
import { registerBeatmap } from "./routes/beatmap.js";
import { registerNetease } from "./routes/netease.js";
import { registerDjBeatmap } from "./routes/dj-beatmap.js";
import { registerQQ } from "./routes/qq.js";
import { registerMusicSourceGates } from "./routes/music-gates.js";
import { registerPlayerLink } from "./routes/player.js";
import { initCookieStore } from "./music/cookie-store.js";
import { validateCommandArgs, isAllowedCommand } from "./music/command-whitelist.js";
import {
  relayPlayerCommand,
  type RelayResult,
} from "./integrations/player-link.js";

const app = Fastify({ logger: { level: config.server.logLevel } });
app.register(multipart, { limits: { fileSize: config.stt.uploadMaxBytes } });

// reqId 注入（ADR-8 保留）：每请求生成 ulid，回写响应头 X-Request-Id。
app.addHook("onRequest", (req, reply, done) => {
  const reqId = ulid();
  (req as any).reqId = reqId;
  reply.header("X-Request-Id", reqId);
  done();
});

// HTTP 请求生命周期日志（http 域，带 reqId；ADR-8 保留）。
app.addHook("onResponse", (req, reply, done) => {
  if (req.url !== "/health") {
    const level = httpRequestLogLevel(req.url, reply.statusCode);
    createLogger("http", { reqId: (req as any).reqId })[level](
      "request",
      { method: req.method, url: req.url, status: reply.statusCode },
      Math.round(reply.elapsedTime),
    );
  }
  done();
});

app.get("/health", async () => ({ ok: true }));

/* ─────────── Slim-player compatibility surface ─────────── */

/**
 * The vendored player still probes the former A-side runtime-config endpoint.
 * Return only public UI defaults: never serialize process configuration or secrets.
 */
app.get("/api/config", async () => ({
  assistant_name: "dube",
  capabilities: { weather_radio: false },
}));

/**
 * Weather radio belongs to the stripped A-side backend. A successful disabled
 * response lets the retained player UI degrade without noisy 404s or network calls.
 */
app.get("/api/weather/radio", async () => ({
  available: false,
  reason: "weather_radio_disabled",
  weather: null,
  radio: null,
}));

/* ─────────── Music taste / events（B 派：听歌口味，保留）─────────── */

/** POST /api/music/events — 记录音乐行为事件（批量） */
app.post("/api/music/events", async (req) => {
  const { events } = req.body as { events: any[] };
  if (!Array.isArray(events) || events.length === 0) return { error: "events array required" };

  const { recordEvent, aggregatePreferences, isValidMusicEventType } = await import("./music/events.js");
  const results = [];
  for (const ev of events.slice(0, 50)) {
    if (!ev.user_id || !ev.track_id || !ev.event_type) continue;
    if (!isValidMusicEventType(String(ev.event_type))) continue;
    if (ev.provider && !ev.context) ev.context = { provider: ev.provider };
    results.push(recordEvent(ev));
  }
  if (results.length > 0 && events[0]?.user_id) {
    try { aggregatePreferences(events[0].user_id); }
    catch (e) { logger.warn("api", "aggregate_prefs_failed", { user_id: events[0].user_id, error: (e as Error).message }); }
  }
  return { recorded: results.length };
});

/* ─────────── 完整滚动口味画像（只读，无 checkpoint/pending）─────────── */

/** GET /api/music/taste-summary?user_id= — 从音乐事实源现场构建完整滚动画像。 */
app.get("/api/music/taste-summary", async (req) => {
  const q = req.query as any;
  if (!q?.user_id) return { error: "user_id required" };
  const { getTasteContext } = await import("./music/taste-summary.js");
  return getTasteContext(String(q.user_id));
});

/* ─────────── B 面：听感手记 ─────────── */

const isVisualNotesChannel = (req: FastifyRequest): boolean => {
  const expected = process.env.SIDE_B_VISUAL_TOKEN ?? "";
  const supplied = String(req.headers["x-regret-visual-channel"] ?? "");
  return expected.length >= 32 && supplied === expected;
};

/** POST /api/music/notes — 视觉通道写 hero/hint；根路径工具通道强制 agent + 已分享。 */
app.post("/api/music/notes", async (req, reply) => {
  const b = (req.body ?? {}) as any;
  const visual = isVisualNotesChannel(req);
  try {
    const { createMusicNoteWithPreference, resetSideBDismissStreak } = await import("./music/notes.js");
    const preference = b.preference === "liked" || b.preference === "disliked" ? b.preference : undefined;
    if (b.preference != null && !preference) throw new Error("invalid preference");
    const result = createMusicNoteWithPreference({
      ...b,
      source: visual && b.source === "hint" ? "hint" : visual ? "hero" : "agent",
      shared: visual ? false : true,
    }, visual ? undefined : preference);
    resetSideBDismissStreak(result.note.user_id);
    return reply.code(201).send({ note: result.note, preference_recorded: result.preferenceRecorded });
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

/** GET /api/music/notes — 私密原文仅视觉前缀通道可达；根路径强制 shared_at IS NOT NULL。 */
app.get("/api/music/notes", async (req, reply) => {
  const q = req.query as any;
  const userId = typeof q?.user_id === "string" ? q.user_id.trim() : "";
  if (!userId) return reply.code(400).send({ error: "user_id required" });
  const { getMusicNotes } = await import("./music/notes.js");
  return getMusicNotes({
    userId,
    workKey: typeof q.work_key === "string" ? q.work_key : undefined,
    trackId: typeof q.track_id === "string" ? q.track_id : undefined,
    limit: Number(q.limit),
    offset: Number(q.offset),
    includePrivate: isVisualNotesChannel(req) && String(q.all ?? "") === "1",
  });
});

/** 视觉通道提问。surface=hint 时服务端同时强制每日一次与静默窗口。 */
app.get("/api/music/notes/prompt", async (req, reply) => {
  if (!isVisualNotesChannel(req)) return reply.code(404).send({ error: "not found" });
  const q = req.query as any;
  const userId = typeof q?.user_id === "string" ? q.user_id.trim() : "";
  if (!userId) return reply.code(400).send({ error: "user_id required" });
  const { canShowSideBHint, getMusicNotePrompt, isSideBMuted, markSideBHintShown, wasSideBWorkDismissed } = await import("./music/notes.js");
  const hint = q.surface === "hint";
  if (isSideBMuted(userId) || (hint && !canShowSideBHint(userId))) return { kind: "none", muted: true };
  const prompt = getMusicNotePrompt(userId, {
    trackId: q.track_id, title: q.track_title, artist: q.track_artist, provider: q.provider,
  });
  if (prompt.track && wasSideBWorkDismissed(userId, prompt.track.work_key)) {
    return { kind: "none", dismissed: true, track: prompt.track };
  }
  if (hint && prompt.kind !== "none") markSideBHintShown(userId);
  return prompt;
});

app.post("/api/music/notes/dismiss", async (req, reply) => {
  if (!isVisualNotesChannel(req)) return reply.code(404).send({ error: "not found" });
  const b = (req.body ?? {}) as any;
  if (!b.user_id) return reply.code(400).send({ error: "user_id required" });
  const { dismissSideBPrompt } = await import("./music/notes.js");
  return dismissSideBPrompt(String(b.user_id), typeof b.work_key === "string" ? b.work_key : undefined);
});

app.post("/api/music/notes/share", async (req, reply) => {
  if (!isVisualNotesChannel(req)) return reply.code(404).send({ error: "not found" });
  const b = (req.body ?? {}) as any;
  if (!b.user_id || !b.note_id) return reply.code(400).send({ error: "user_id and note_id required" });
  const { shareMusicNote } = await import("./music/notes.js");
  return shareMusicNote(String(b.user_id), String(b.note_id)) ? { ok: true } : reply.code(404).send({ error: "not found" });
});

app.delete("/api/music/notes/:id", async (req, reply) => {
  if (!isVisualNotesChannel(req)) return reply.code(404).send({ error: "not found" });
  const p = req.params as any;
  const q = req.query as any;
  if (!q?.user_id) return reply.code(400).send({ error: "user_id required" });
  const { deleteMusicNote } = await import("./music/notes.js");
  return deleteMusicNote(String(q.user_id), String(p.id)) ? { ok: true } : reply.code(404).send({ error: "not found" });
});

/** GET /api/music/events?user_id=&limit= — 查询音乐事件历史 */
app.get("/api/music/events", async (req) => {
  const q = req.query as any;
  if (!q?.user_id) return { error: "user_id required" };
  const { getRecentEvents } = await import("./music/events.js");
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  return { items: getRecentEvents(q.user_id, limit) };
});

/** GET /api/music/preferences?user_id=&status= — 查询音乐偏好 */
app.get("/api/music/preferences", async (req) => {
  const q = req.query as any;
  if (!q?.user_id) return { error: "user_id required" };
  const { getPreferences } = await import("./music/events.js");
  return { items: getPreferences(q.user_id, q.status) };
});

/** POST /api/music/preferences/:id/confirm — 确认偏好 */
app.post("/api/music/preferences/:id/confirm", async (req) => {
  const p = req.params as any;
  const q = req.query as any;
  if (!q?.user_id) return { error: "user_id required" };
  const { confirmPreference } = await import("./music/events.js");
  const ok = confirmPreference(p.id, q.user_id);
  return ok ? { ok: true } : { error: "not found" };
});

/** POST /api/music/preferences/:id/reject — 拒绝偏好 */
app.post("/api/music/preferences/:id/reject", async (req) => {
  const p = req.params as any;
  const q = req.query as any;
  if (!q?.user_id) return { error: "user_id required" };
  const { rejectPreference } = await import("./music/events.js");
  const ok = rejectPreference(p.id, q.user_id);
  return ok ? { ok: true } : { error: "not found" };
});

/* ─────────── DSH-specific overlay（§4）─────────── */

// 17 个音乐动作工具白名单 + args 结构校验在 music/command-whitelist.ts（纯函数、可单测）。
// 阿呆只在白名单内调用，绝不原样透传任意 {name,args} 进播放器 dispatchTool。

/** 命令注入端点（仅本机可调）→ relayPlayerCommand → SSE → 音乐 tab 播放器。 */
app.post("/api/player/command", async (req, reply) => {
  if (!isLoopbackAddress(req.ip)) {
    return reply.code(403).send({ error: "loopback only" });
  }
  const b = (req.body ?? {}) as { user_id?: string; name?: string; args?: any };
  const userId = typeof b.user_id === "string" ? b.user_id.trim() : "";
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!userId) return reply.code(400).send({ error: "user_id required" });
  if (!isAllowedCommand(name)) return reply.code(400).send({ error: `command not allowed: ${name}` });
  const cleanArgs = validateCommandArgs(name, b.args ?? {});
  if (cleanArgs === null) return reply.code(400).send({ error: `invalid args for ${name}` });

  // 若无在场播放器 → 立即如实返回 no_player；有 → 等 ACK（4s 超时）。
  const relay: RelayResult = await relayPlayerCommand(userId, { name, args: cleanArgs });
  return relay;
});

// 播放器状态快照：浏览器播放器是唯一真相源（§4.3）。
// 浏览器 → 后端：POST /api/player/state（播放器状态变化时事件式上报）
const playerSnapshots = new Map<string, any>();

app.post("/api/player/state", async (req, reply) => {
  if (!isLoopbackAddress(req.ip)) {
    return reply.code(403).send({ error: "loopback only" });
  }
  const b = (req.body ?? {}) as { user_id?: string; snapshot?: any };
  const userId = typeof b.user_id === "string" ? b.user_id.trim() : "";
  if (!userId) return reply.code(400).send({ error: "user_id required" });
  if (!b.snapshot || typeof b.snapshot !== "object") {
    return reply.code(400).send({ error: "snapshot required" });
  }
  playerSnapshots.set(userId, { ...b.snapshot, ts: Date.now() });
  return { ok: true };
});

// 后端 → DSH：GET /api/player/state?user_id= 取最新快照（无则返回空闲态）。
app.get("/api/player/state", async (req) => {
  const q = req.query as any;
  const userId = typeof q?.user_id === "string" ? q.user_id.trim() : "";
  if (!userId) return { error: "user_id required" };
  const snap = playerSnapshots.get(userId);
  return snap ?? { playing: false, queue: [], now_playing: null, search_results: [], ts: 0 };
});

/* ─────────── 调试日志（白名单只读，保留便于排障）─────────── */
app.get("/api/debug/log", async (req, reply) => {
  if (!canAccessDebugLog(req.ip)) {
    return reply.code(404).send({ error: "not found" });
  }
  if (!config.log.toFile) {
    return reply.code(403).send({ error: "LOG_TO_FILE must be enabled" });
  }
  const logPath = getLogFilePath();
  if (!existsSync(logPath)) {
    return { lines: 0, entries: [] };
  }
  const content = readFileSync(logPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const entries = lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return { lines: entries.length, file: logPath, entries };
});

/* ─────────── boot：cookie 初始化 + 音乐路由注册 ─────────── */

// M2-C C6-2（ADR-5）：cookie 自持。须在任何音乐路由处理前（getLoginInfo 依赖 gateway 运行期 cookie）。
initCookieStore();
registerMusicSourceGates(app);
registerMediaProxy(app);
registerBeatmap(app);
registerNetease(app);
registerQQ(app);
registerDjBeatmap(app);
// 播放器在场通道（link/ack）+ 本机命令注入 + 状态快照都在本文件内注册（见上）。
registerPlayerLink(app);

app.listen({ port: config.server.port, host: config.server.host }).then(() => {
  const cfgLog = createLogger("config");
  cfgLog.info("listening", { host: config.server.host, port: config.server.port });
  cfgLog.info("loaded", configSummary());
});
