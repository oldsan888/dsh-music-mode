/**
 * 可控时钟。
 *
 * 默认返回真实 UTC 时间，格式与 SQLite `datetime('now')` 一致
 * （`YYYY-MM-DD HH:MM:SS`）。测试与「100 天模拟」可以用 setNow() 覆盖，
 * 让 created_at / updated_at / last_accessed_at 反映模拟时间，
 * 从而真实地测试 recency 衰减、decay 归档等与时间相关的记忆行为。
 */

let override: string | null = null;

/** SQLite 风格的时间串：YYYY-MM-DD HH:MM:SS（UTC）。 */
export function toSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** 当前时刻（受 override 影响）。 */
export function getNow(): string {
  return override ?? toSqliteUtc(new Date());
}

/** 当前时刻的 Date 对象（受 override 影响）。 */
export function getNowDate(): Date {
  return override ? new Date(override.replace(" ", "T") + "Z") : new Date();
}

/** 覆盖时钟。传入 Date / SQLite 时间串 / null（恢复真实时间）。 */
export function setNow(when: Date | string | null): void {
  if (when === null) {
    override = null;
  } else if (when instanceof Date) {
    override = toSqliteUtc(when);
  } else {
    override = when;
  }
}

/** 把 SQLite 时间串解析为 Date（按 UTC）。 */
export function parseSqliteUtc(s: string): Date {
  return new Date(s.replace(" ", "T") + "Z");
}

/**
 * 【本地时段】标签：凌晨[0,5) 上午[5,12) 中午[12,14) 下午[14,18) 晚上[18,24)。
 * 存储统一 UTC，但「你上午/下午说过…」面向的是活在本地时区的用户与模型，故按本地小时归类。
 * 供「今日时间线」与 recall 出口标注时段，让 dube 能把同一天早些时候的处境/情绪与当下连起来。
 */
export function timeOfDayLabel(s: string): string {
  const str = String(s ?? "");
  const d = /^\d{4}-\d{2}-\d{2} /.test(str) ? parseSqliteUtc(str) : new Date(str);
  if (isNaN(d.getTime())) return "";
  const h = d.getHours(); // 本地小时（Date.getHours 按本地时区）
  if (h < 5) return "凌晨";
  if (h < 12) return "上午";
  if (h < 14) return "中午";
  if (h < 18) return "下午";
  return "晚上";
}

/**
 * 把存储层的 UTC 时间串（SQLite `YYYY-MM-DD HH:MM:SS` 或 ISO）转为【本地日期】YYYY-MM-DD。
 * 存储统一 UTC 是对的；但 prompt 注入（"最近的事"）、recall_memory 返回等出口面向的是
 * 活在本地时区的模型与用户——直接 slice(0,10) 会在 UTC+8 的每天 08:00 前差一天。
 */
export function toLocalDate(s: string): string {
  const str = String(s ?? "");
  const d = /^\d{4}-\d{2}-\d{2} /.test(str) ? parseSqliteUtc(str) : new Date(str);
  if (isNaN(d.getTime())) return str.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
