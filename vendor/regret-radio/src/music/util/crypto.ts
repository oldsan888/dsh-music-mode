import { createHash } from "node:crypto";

/**
 * 音乐网关共享加密工具（§3.1）。纯函数、无 I/O，可单测。
 * 当前用于节拍缓存 key 哈希；C4 双源/登录会复用更多摘要。
 */

/** SHA-1 十六进制摘要（用于缓存文件名等非安全场景的稳定指纹）。 */
export function sha1Hex(input: string): string {
  return createHash("sha1").update(String(input)).digest("hex");
}
