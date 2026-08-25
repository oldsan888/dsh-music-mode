import { isAbsolute, join } from "node:path";

/**
 * 音乐网关共享文件/路径工具（§3.1）。纯函数、无 I/O，可单测。
 */

/**
 * 把任意字符串净化为安全的文件名片段（防路径穿越/非法字符）：
 * 仅保留 [a-z0-9_.-]，其余折叠为 `_`，去首尾 `_`，截断到 maxLen。
 */
export function safeFilenameComponent(raw: string, maxLen = 64): string {
  return String(raw || "")
    .replace(/[^a-z0-9_.-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLen);
}

/** 相对路径按 cwd 解析为绝对路径；绝对路径原样返回。 */
export function resolveUnderCwd(dir: string): string {
  return isAbsolute(dir) ? dir : join(process.cwd(), dir);
}
