/**
 * dsh-music-mode 聚合包根 apply —— 「音乐」tab client 行的 node 半。
 * 本体（空）：host 能力在 @oldsan888/dsh-music-mode/server-visual 与
 * /server-tool；client bundle 经 exports["./client"]（src/client）出货。
 */
import type { Context } from "@deepseek-ai/cordis";

export const name = "dsh-music-mode";

export function apply(_ctx: Context): void {
  // 根行仅作为 client entry 的挂载点（dsh.client 声明解析聚合包 manifest）。
}
