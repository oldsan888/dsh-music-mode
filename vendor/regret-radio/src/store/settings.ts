import { queryOne, execute } from "./sqlite.js";
import { config } from "../config.js";

/** 助手的出厂默认名。persona 不再硬编码名字——运行时由 brain/prompt/compose.ts
 *  的【你的名字】动态段无条件注入（含默认名），前端 UI 兜底文案与此保持一致。 */
export const DEFAULT_ASSISTANT_NAME = "dube";

export type VoiceMode = "preset" | "clone" | "design";

/** 主动性旋钮（阶段5 §2 闸1）。默认 'off'——主动性是用户往上拧的，不推给他；'chatty' 留位不实现。 */
export type ProactivityLevel = "off" | "standard";

export interface UserSettings {
  assistant_name: string;
  voice_mode: VoiceMode;
  proactivity_level: ProactivityLevel;
  /** 全局静音到某时刻（UTC 文本，字典序可比 now）；null=未静音。 */
  proactive_muted_until: string | null;
}

interface SettingsRow {
  assistant_name: string | null;
  voice_mode: string | null;
  proactivity_level: string | null;
  proactive_muted_until: string | null;
}

/**
 * 读用户设置。缺省时回退：名字→dube，音色→.env 的 VOICE_MODE。
 * 主动性一律【正向白名单】归一：只有 'standard' 算开，NULL/未知值/漏配全落 'off'——
 * `!== 'off'` 是 fail-open（存量用户无此列时 undefined 会被判开启），方向必须与「宁静默」一致。
 */
export function getUserSettings(userId: string): UserSettings {
  const row = queryOne<SettingsRow>(
    `SELECT assistant_name, voice_mode, proactivity_level, proactive_muted_until
     FROM user_settings WHERE user_id = ?`,
    [userId],
  );
  return {
    assistant_name: row?.assistant_name?.trim() || DEFAULT_ASSISTANT_NAME,
    voice_mode: (row?.voice_mode as VoiceMode) || config.voice.mode,
    proactivity_level: row?.proactivity_level === "standard" ? "standard" : "off",
    proactive_muted_until: row?.proactive_muted_until || null,
  };
}

/** 增量写用户设置（只更新传入的字段；proactive_muted_until 传 null 表示显式清除静音）。 */
export function updateUserSettings(
  userId: string,
  patch: {
    assistant_name?: string;
    voice_mode?: VoiceMode;
    proactivity_level?: ProactivityLevel;
    proactive_muted_until?: string | null;
  },
): UserSettings {
  const current = getUserSettings(userId);
  const next: UserSettings = {
    assistant_name:
      patch.assistant_name !== undefined
        ? patch.assistant_name.trim() || DEFAULT_ASSISTANT_NAME
        : current.assistant_name,
    voice_mode: patch.voice_mode ?? current.voice_mode,
    proactivity_level: patch.proactivity_level ?? current.proactivity_level,
    proactive_muted_until:
      patch.proactive_muted_until !== undefined
        ? patch.proactive_muted_until
        : current.proactive_muted_until,
  };
  execute(
    `INSERT INTO user_settings (user_id, assistant_name, voice_mode, proactivity_level, proactive_muted_until, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       assistant_name = excluded.assistant_name,
       voice_mode = excluded.voice_mode,
       proactivity_level = excluded.proactivity_level,
       proactive_muted_until = excluded.proactive_muted_until,
       updated_at = excluded.updated_at`,
    [userId, next.assistant_name, next.voice_mode, next.proactivity_level, next.proactive_muted_until],
  );
  return next;
}
