/**
 * 解析/格式化共享工具（§3.1）。纯函数，可单测。
 * parseJSONText：QQ 所有接口的 JSONP 去壳前置步骤（正则改动会让全部 QQ 解析失败——行为保真敏感）。
 * normalizeApiCode/Message：NCM 嵌套响应的 code/message 归一（netease 登录态/取址回退用）。
 */

/** 去掉 `callback(...)` JSONP 包裹后 JSON.parse。 */
export function parseJSONText(text: unknown): unknown {
  const raw = String(text || "").trim();
  const json = raw.replace(/^callback\(([\s\S]*)\);?$/, "$1");
  return JSON.parse(json);
}

/** 解码常见 HTML 实体（&#x.. / &#.. / &quot; / &amp; / &nbsp; 等）。 */
export function decodeHtmlEntities(text: unknown): string {
  return String(text || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
}

/** 从 NCM/嵌套 payload 取 code（body.code / body.body.code / status）。 */
export function normalizeApiCode(payload: unknown): number {
  const p = payload as Record<string, unknown> | null | undefined;
  const body = (p && ((p.body as Record<string, unknown>) || p)) as Record<string, unknown> | undefined;
  const nested = body && (body.body as Record<string, unknown> | undefined);
  return Number((body && body.code) || (nested && nested.code) || (p && p.status) || 0);
}

/** 从 NCM/嵌套 payload 取 message/msg/error。 */
export function normalizeApiMessage(payload: unknown): string {
  const p = payload as Record<string, unknown> | null | undefined;
  const body = (p && ((p.body as Record<string, unknown>) || p)) as Record<string, unknown> | undefined;
  const nested = body && (body.body as Record<string, unknown> | undefined);
  return (
    ((body && (body.message || body.msg || body.error)) as string) ||
    ((nested && (nested.message || nested.msg || nested.error)) as string) ||
    ""
  );
}
