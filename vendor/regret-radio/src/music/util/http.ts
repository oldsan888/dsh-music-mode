/**
 * 通用 HTTP 取数（§3.1，QQ 子系统 HTTP 基座）。下沉自 legacy/gateway.cjs，行为逐字保真。
 * 用原生 http/https（非 fetch）：QQ 接口对 header/编码敏感，沿用原实现避免回归。
 */

import http from "node:http";
import https from "node:https";

export interface RequestTextOptions {
  method?: string;
  headers?: Record<string, string | number>;
}

/** GET/POST 取文本：10s 超时；状态码 >=400 抛错（携带 statusCode + body）。 */
export function requestText(targetUrl: string, opts?: RequestTextOptions, body?: string): Promise<string> {
  const options = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode || 0;
          if (status >= 400) {
            const err = new Error("HTTP " + status) as Error & { statusCode?: number; body?: string };
            err.statusCode = status;
            err.body = text;
            reject(err);
            return;
          }
          resolve(text);
        });
      },
    );
    req.setTimeout(10000, () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 取并 JSON.parse；解析失败抛 `Invalid JSON from <url>`（保留 cause）。 */
export async function requestJson(targetUrl: string, opts?: RequestTextOptions, body?: string): Promise<any> {
  const text = await requestText(targetUrl, opts, body);
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error("Invalid JSON from " + targetUrl) as Error & { cause?: unknown };
    err.cause = e;
    throw err;
  }
}
