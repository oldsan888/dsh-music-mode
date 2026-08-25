import { ulid } from "ulid";
import { createLogger } from "../logger.js";

/**
 * 播放器在场通道 + 命令中继（plans/2026-07-07 阶段 B）。**本项目首个「后端主动推浏览器」**。
 *
 * 浏览器开页面时挂一条长连 SSE（GET /api/player/link）→ registerPlayer 登记「有能执行的播放器」。
 * 飞书这类无播放器的通道触发音乐动作时 → relayPlayerCommand 把命令推到该 SSE → 浏览器执行 →
 * POST /api/player/ack 回执 → 中继据 ACK 成/败/超时决定回给飞书用户的话。
 *
 * 命令形状 = { name, args }（与现有 SSE tool 事件同构）→ 浏览器直接复用 AI.dispatchTool 执行。
 * 本模块 **SSE/HTTP 无关**（push 注入）→ 可离线单测；HTTP 壳在 routes/player.ts。
 */

const log = createLogger("player");

export interface PlayerCommand {
  name: string;
  args: Record<string, unknown>;
}

export interface RelayResult {
  /** 是否送达并收到浏览器 ACK。 */
  delivered: boolean;
  /** delivered 时：浏览器执行成/败（dispatchTool 的 ok）。 */
  ok?: boolean;
  /** delivered 时：浏览器回执文案（dispatchTool 的 summary），喂给 dube 接地播报。 */
  result?: string;
  /** 未送达时的原因。 */
  reason?: "no_player" | "timeout" | "error";
}

/** 往某条 SSE 推一个事件（event 名 + JSON data）。 */
export type PushFn = (event: string, data: unknown) => void;

interface PlayerConn {
  id: string;
  push: PushFn;
}

// user_id → (connId → conn)：同一 user 多页面在场时广播、首个 ACK 胜出。
const players = new Map<string, Map<string, PlayerConn>>();
// command_id → 待 ACK 的 resolver + 超时定时器。
const pendingAcks = new Map<string, { resolve: (r: RelayResult) => void; timer: ReturnType<typeof setTimeout> }>();

/** 登记一个在场播放器（浏览器挂 SSE 时调）。返回注销函数（SSE 断开时调）。 */
export function registerPlayer(userId: string, push: PushFn): () => void {
  const id = ulid();
  let conns = players.get(userId);
  if (!conns) {
    conns = new Map();
    players.set(userId, conns);
  }
  conns.set(id, { id, push });
  log.info("player_online", { user_id: userId, conns: conns.size });
  return () => {
    const c = players.get(userId);
    if (c) {
      c.delete(id);
      if (c.size === 0) players.delete(userId);
      log.info("player_offline", { user_id: userId, conns: c.size });
    }
  };
}

/** 该用户是否有在场播放器。 */
export function hasPlayer(userId: string): boolean {
  const c = players.get(userId);
  return !!c && c.size > 0;
}

/** 到点提醒/主动搭话推给浏览器的载荷（notify 事件）。 */
export interface PlayerNotify {
  /** 展示给用户的文案（dube 口吻）。 */
  text: string;
  /** 关联的调度任务 id（可选，前端可去重/引用）。 */
  task_id?: string;
  /** 类型（'reminder' | 'proactive' 等），前端据此调整呈现/闸控。 */
  kind?: string;
  /** 主动发言日志 id（阶段5）：pushNotify 全连接广播，前端按它做页签内去重。 */
  log_id?: string;
}

/**
 * 往在场浏览器推一条【提醒】（notify 事件，无需 ACK、即发即忘）。返回是否至少送达一条连接。
 * 与 relayPlayerCommand（command，等 ACK）不同：提醒是单向展示（前端弹 toast + 面板气泡），不等回执。
 */
export function pushNotify(userId: string, payload: PlayerNotify): boolean {
  const conns = players.get(userId);
  if (!conns || conns.size === 0) return false;
  let pushed = 0;
  for (const conn of conns.values()) {
    try {
      conn.push("notify", payload);
      pushed++;
    } catch (e) {
      log.warn("notify_push_failed", { error: (e as Error).message });
    }
  }
  if (pushed > 0) log.info("notify_sent", { user_id: userId, task_id: payload.task_id, players: pushed });
  return pushed > 0;
}

/** 在场播放器连接数（调试/状态用）。 */
export function playerCount(userId: string): number {
  return players.get(userId)?.size ?? 0;
}

/**
 * 浏览器执行完命令后回 ACK。匹配到待处理命令 → resolve 中继 Promise，返回 true；无匹配 → false（已超时/未知）。
 */
export function receivePlayerAck(commandId: string, ok: boolean, result?: string): boolean {
  const pending = pendingAcks.get(commandId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingAcks.delete(commandId);
  pending.resolve({ delivered: true, ok, result });
  return true;
}

/**
 * 把命令中继给在场浏览器播放器，等 ACK（带超时兜底）。
 * - 无在场播放器 → 立即 { delivered:false, reason:'no_player' }。
 * - 有 → 生成 command_id，广播 SSE `command` 事件，挂待-ACK Promise；
 *   浏览器 ACK → { delivered:true, ok, result }；超时 → { delivered:false, reason:'timeout' }。
 */
export function relayPlayerCommand(
  userId: string,
  command: PlayerCommand,
  timeoutMs = 4000,
): Promise<RelayResult> {
  const conns = players.get(userId);
  if (!conns || conns.size === 0) {
    return Promise.resolve({ delivered: false, reason: "no_player" });
  }
  const commandId = `cmd_${ulid()}`;
  return new Promise<RelayResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingAcks.delete(commandId);
      log.info("relay_timeout", { user_id: userId, command_id: commandId, name: command.name });
      resolve({ delivered: false, reason: "timeout" });
    }, timeoutMs);
    pendingAcks.set(commandId, { resolve, timer });
    // 广播给该用户所有在场页面；首个 ACK 胜出（receivePlayerAck 只 resolve 一次、后续找不到 pending）。
    let pushed = 0;
    for (const conn of conns.values()) {
      try {
        conn.push("command", { command_id: commandId, name: command.name, args: command.args });
        pushed++;
      } catch (e) {
        log.warn("relay_push_failed", { error: (e as Error).message });
      }
    }
    // 极端：所有 push 都抛（连接已死）→ 当作未送达，别让飞书用户干等到超时。
    if (pushed === 0) {
      clearTimeout(timer);
      pendingAcks.delete(commandId);
      resolve({ delivered: false, reason: "error" });
      return;
    }
    log.info("relay_sent", { user_id: userId, command_id: commandId, name: command.name, players: pushed });
  });
}

/** 测试用：清空全部在场连接 + 待处理 ACK（vitest beforeEach 隔离）。 */
export function _resetPlayerLink(): void {
  for (const p of pendingAcks.values()) clearTimeout(p.timer);
  pendingAcks.clear();
  players.clear();
}
