/**
 * host 插件：托管 vendored regret-radio 后端 + serve 前端静态 + 反代 /api。
 *
 * 自 DSH 本体 @deepseek-ai/dsh-server-regret-visual 迁入（2026-08-19 独立插件化）：
 * - resolveVendorRoot() 从插件自身逐级上找 `vendor/regret-radio`（import.meta.url
 *   相对解析，lib 或 src 产物位置皆可）——独立包内天然成立，包内即含该资源。
 * - 含 E5 修复：makeApiProxy 转发上游响应头（SSE 必须的 content-type:
 *   text/event-stream 透传），否则浏览器 EventSource 拒绝解析 → relay 恒 timeout。
 * - 宿主类型（@deepseek-ai/dsh-host-webserver）由本地 shim 提供（src/typings）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { isAbsolute, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { request } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

/**
 * 解析 vendor 包根（`vendor/regret-radio`，即 vendored Regret-radio 音乐核心）。
 * 从本文件（编译产物 lib/server-visual.js 或源码 src）逐级向上找
 * `vendor/regret-radio/package.json`，不依赖机器绝对路径——独立插件包自含该
 * 资源，换机/分享即用。
 */
export function resolveVendorRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'vendor', 'regret-radio')
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('dsh-music-mode/server-visual: vendor/regret-radio not found (resolved from plugin location)')
}

const VENDOR_ROOT = resolveVendorRoot()

/** Regret-radio 前端静态根（public/ 即源码本体，无构建）——相对 vendor 解析。 */
export const DEFAULT_STAGE_ROOT = join(VENDOR_ROOT, 'public')

/** Regret-radio vendored 后端工作目录（含 src/server.ts，spawn cwd）。 */
export const DEFAULT_BACKEND_ROOT = VENDOR_ROOT

/** 托管后端监听端口。 */
export const DEFAULT_BACKEND_PORT = 8090

/** 插件配置。 */
export interface Config {
  /** Regret 前端 static 根（public/ 绝对路径）。 */
  stageRoot?: string
  /** Regret 后端目录（含 src/server.ts）。 */
  backendRoot?: string
  /** 托管后端端口。 */
  backendPort?: number
  /** 是否内部托管后端（默认 true）。false 时不 spawn，只 serve 前端+反代到指定端口）。 */
  hostBackend?: boolean
  /** 允许非本机浏览器访问音乐面板。公开发布默认关闭；启用时必须同时配置 accessToken。 */
  allowRemote?: boolean
  /** 远程访问 Bearer token（至少 32 字符）。不会注入页面；应由受信反向代理添加。 */
  accessToken?: string
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.bin': 'application/octet-stream',
}

/** 决策结果（纯数据，便于单测）。 */
export interface RegretDecision {
  status: 200 | 403 | 404
  path?: string
}

/**
 * 视觉引导（内联进 index.html，先于 app.js）：把 Regret 前端对 `/api/*` 的相对
 * 请求**改写**到 `/regret-visual/api/*`（插件反代面 → 托管后端）。后端未就绪时
 * 该反代返回空 JSON，前端优雅降级、console 干净。
 */
const VISUAL_BOOT_SCRIPT = `
<script>
(function () {
  try {
    var PREFIX = '/regret-visual/api';
    var apiRe = /^\\/api\\//;
    var rewrite = function (url) {
      if (typeof url === 'string' && apiRe.test(url)) return PREFIX + url.slice(4);
      return url;
    };
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var out = typeof input === 'string' ? rewrite(input) : (input && apiRe.test(input.url || '') ? { ...input, url: rewrite(input.url) } : input);
        return origFetch.call(this, out, init);
      };
    }
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () {
      var args = Array.prototype.slice.call(arguments);
      args[1] = rewrite(String(args[1] || ''));
      return origOpen.apply(this, args);
    };
    try { document.documentElement.classList.add('regret-visual-only'); } catch (e) {}
  } catch (e) {
    if (window.console) console.warn('regret visual boot failed', e);
  }
})();
</script>
`

/** 视觉引导注入：改写 /api → /regret-visual/api 并标记 visual-only。内联进 <head>。 */
export function injectVisualBoot(html: string): string {
  if (html.includes('<!-- regret-visual-boot -->')) return html
  const marker = '<!-- regret-visual-boot -->'
  const boot = `${marker}${VISUAL_BOOT_SCRIPT}`
  const headIdx = html.indexOf('<head>')
  if (headIdx !== -1) {
    return `${html.slice(0, headIdx + 6)}${boot}${html.slice(headIdx + 6)}`
  }
  return `${boot}${html}`
}

/** 保留旧名做兼容别名（单测沿用）。 */
export const injectApiStub: typeof injectVisualBoot = injectVisualBoot

/**
 * 纯函数解析：把 `/regret-visual/**` 请求解析为服务决策。
 * - `/regret-visual` 或 `/regret-visual/` → root/index.html
 * - root 下命中现有文件 → 该文件
 * - 其余 → root/index.html（SPA fallback）；index 缺失 → 404
 * - `..` 逃逸 root → 403
 */
export function resolveRegretTarget(rawPath: string, root: string): RegretDecision {
  let pathname: string | undefined
  try { pathname = decodeURIComponent(rawPath) } catch { return { status: 404 } }
  if (pathname === undefined) return { status: 404 }

  const rel = pathname === '/regret-visual' ? '/' : pathname.slice('/regret-visual'.length)
  const target = resolve(normalize(join(root, rel)))
  if (target !== root && !target.startsWith(root + sep)) return { status: 403 }

  const index = join(root, 'index.html')
  if (rel === '/' || pathname === '/regret-visual/index.html') {
    return existsSync(index) ? { status: 200, path: index } : { status: 404 }
  }
  if (existsSync(target)) return { status: 200, path: target }
  return existsSync(index) ? { status: 200, path: index } : { status: 404 }
}

/** 把决策写为 HTTP 响应。index.html 走视觉引导注入。 */
async function serveRegret(rawPath: string, res: ServerResponse, root: string): Promise<void> {
  const decision = resolveRegretTarget(rawPath, root)
  if (decision.status !== 200) { res.writeHead(decision.status); res.end(); return }
  const filePath = decision.path
  if (filePath === undefined) { res.writeHead(404); res.end(); return }
  try {
    let body = await readFile(filePath)
    const isIndex = extname(filePath) === '.html'
    if (isIndex) body = Buffer.from(injectVisualBoot(body.toString('utf8')), 'utf8')
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404); res.end()
  }
}

/**
 * 反代目标路径的纯计算：把原始 `req.url`（保留百分号编码、绝不解码）经前缀
 * 剥离映射到后端路径。`strip` 为空 = 原样转发；否则剥掉 strip 并在前面补 /api/。
 * 纯字符串操作，不经过 URL 解析，保证中文/特殊字符不会被提前解码。
 */
export function proxyTargetPath(raw: string, strip: string): string {
  if (strip.length > 0 && raw.startsWith(strip)) {
    return '/api/' + raw.slice(strip.length).replace(/^\//, '')
  }
  return raw
}

/**
 * 构造一个反代 handler：把请求转发到托管后端。
 * @param port - 后端端口。
 * @param strip - 请求路径要剥掉的固定前缀（空 = 原样转发）。
 * @returns (req, res) => void，GET/HEAD/POST/流式/SSE 透传。
 */
export function isLoopbackClient(req: Pick<IncomingMessage, 'socket'>): boolean {
  const raw = req.socket.remoteAddress ?? ''
  const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw
  return ip === '127.0.0.1' || ip === '::1'
}

function bearerMatches(req: IncomingMessage, token: string): boolean {
  if (token.length < 32) return false
  const value = req.headers.authorization ?? ''
  const supplied = value.startsWith('Bearer ') ? value.slice(7) : ''
  if (supplied.length !== token.length) return false
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
}

function isDirectLoopbackHttp(req: IncomingMessage): boolean {
  if (!isLoopbackClient(req)) return false
  const forwarded = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'via']
  if (forwarded.some((name) => req.headers[name] !== undefined)) return false
  const host = String(req.headers.host ?? '').toLowerCase()
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

/** 在宿主仍保留原始 socket 地址时完成授权，禁止把反代后的 loopback 当成身份。 */
export function authorizeOuterRequest(
  req: IncomingMessage,
  options: { allowRemote: boolean; accessToken: string },
): boolean {
  if (isDirectLoopbackHttp(req)) return true
  return options.allowRemote && bearerMatches(req, options.accessToken)
}

/** 浏览器写操作必须来自同源页面；阻断第三方网页对 localhost 的普通 CSRF。 */
export function isSameOriginMutation(req: IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true
  const site = String(req.headers['sec-fetch-site'] ?? '')
  if (site === 'same-origin') return true
  const origin = String(req.headers.origin ?? '')
  const host = String(req.headers.host ?? '')
  // Node 工具通道不携带浏览器 Fetch Metadata；它已被外层 loopback/Bearer 边界授权。
  if (!origin && !site) return true
  if (!origin || !host) return false
  try { return new URL(origin).host === host } catch { return false }
}

function makeApiProxy(
  port: number,
  strip = '',
  visualToken = '',
  auth: { allowRemote: boolean; accessToken: string } = { allowRemote: false, accessToken: '' },
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!authorizeOuterRequest(req, auth)) {
      res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end('{"error":"music mode is local-only"}')
      return
    }
    if (!isSameOriginMutation(req)) {
      res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end('{"error":"cross-origin mutation rejected"}')
      return
    }
    const targetPath = proxyTargetPath(req.url ?? '/', strip)
    const upstream = request({
      host: '127.0.0.1',
      port,
      path: targetPath,
      method: req.method,
      // 覆写而非信任来路 header：后端据此区分本人 iframe 与 DSH 根路径工具通道，
      // 强制执行 B 面原文 L2 Gate。
      headers: {
        ...req.headers,
        host: `127.0.0.1:${port}`,
        'x-regret-visual-channel': strip.length > 0 ? visualToken : '',
      },
    }, (up) => {
      // 转发上游响应头——只 `up.pipe(res)` 会丢掉 content-type，SSE 长连
      // （/api/player/link）因缺 `text/event-stream` MIME 被浏览器 EventSource
      // 拒绝解析（连接 pending、open 永不触发 → relay 恒 no ack；2026-08-19
      // 端到端最终根因）。过滤 hop-by-hop 头，避免重复转发 transfer-encoding 等。
      const hopByHop = [
        'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
        'te', 'trailer', 'transfer-encoding', 'upgrade',
      ]
      const head: Record<string, string | string[] | undefined> = {}
      for (const [k, v] of Object.entries(up.headers)) {
        if (!hopByHop.includes(k.toLowerCase())) head[k] = v as string | string[] | undefined
      }
      res.writeHead(up.statusCode ?? 200, head)
      up.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{}') }
      else res.end()
    })
    req.pipe(upstream)
  }
}

/** Host plugin body：托管 Regret 后端 + serve 前端 + /api 反代。 */
export function apply(ctx: Context, config: Config = {}): void {
  const stageRaw = config.stageRoot
  const stageRoot = stageRaw === undefined
    ? DEFAULT_STAGE_ROOT
    : isAbsolute(stageRaw) ? stageRaw : resolve(stageRaw)
  const backendRaw = config.backendRoot
  const backendRoot = backendRaw === undefined
    ? DEFAULT_BACKEND_ROOT
    : isAbsolute(backendRaw) ? backendRaw : resolve(backendRaw)
  const backendPort = config.backendPort ?? DEFAULT_BACKEND_PORT
  const hostBackend = config.hostBackend ?? true
  const allowRemote = config.allowRemote === true
  const accessToken = config.accessToken?.trim() ?? ''
  if (allowRemote && accessToken.length < 32) {
    throw new Error('dsh-music-mode/server-visual: allowRemote requires accessToken with at least 32 characters')
  }
  const outerAuth = { allowRemote, accessToken }
  // 本人 iframe 私密通道的进程内随机令牌。浏览器看不到；只由反代写入、后端比对。
  const visualChannelToken = randomBytes(24).toString('hex')

  let child: ChildProcess | null = null

  // 托管后端单进程：DSH 启动拉起、DSH 回收 kill。
  // 运行器：vendored 后端是 TS 源，用 tsx 跑（处理 .js→.ts specifier 映射）。
  // pnpm 布局下 tsx 不 hoist 到顶层（monorepo 内顶层可见，独立安装则不然），
  // 不能依赖 `node --import tsx/esm` 从 cwd 解析——先从本插件包的可见依赖层
  // 解析出 tsx/esm 的绝对路径，显式传给 node --import（任何安装布局通用）。
  if (hostBackend) {
    let tsxLoader = 'tsx/esm'
    try {
      // import.meta.url 在 pnpm 安装下落在符号链接外壳（逻辑路径），直接
      // createRequire 向上找不到 .pnpm/<pkg>@v/node_modules 里的 tsx——先用
      // realpath 取物理位置（真实 vendored 目录），resolve 才能命中包内依赖层。
      // 且 Windows 下 `node --import` 只接受 file:// URL（盘符路径会报
      // ERR_UNSUPPORTED_ESM_URL_SCHEME），resolve 成功即转 file URL。
      const self = realpathSync(fileURLToPath(import.meta.url))
      const resolved = createRequire(self).resolve('tsx/esm')
      tsxLoader = resolved.startsWith('file:') || /^[a-zA-Z]:[\\/]/.test(resolved)
        ? pathToFileURL(resolved).href
        : resolved
    } catch {
      // 退化回裸 specifier（monorepo / tsx 顶层可见场景仍可用）。
    }
    // 运行时数据根：把 DB/日志/cookie/beatmap 从 .pnpm 安装点（pnpm store 目录，
    // 写不可靠）重定向到用户可写目录（默认 DSH home 下的 dsh-music/）。
    const dshBase = process.env.DSH_HOME || process.env.USERPROFILE || process.cwd()
    const dataRoot = join(dshBase, 'dsh-music', 'data')
    child = spawn(process.execPath, ['--import', tsxLoader, 'src/server.ts'], {
      cwd: backendRoot,
      env: {
        ...process.env,
        PORT: String(backendPort),
        DATA_DIR: join(dataRoot, 'data'),
        SQLITE_PATH: join(dataRoot, 'regret-radio.db'),
        LOG_DIR: join(dataRoot, 'logs'),
        NETEASE_COOKIE_FILE: join(dataRoot, '.cookie'),
        QQ_COOKIE_FILE: join(dataRoot, '.qq-cookie'),
        BEAT_CACHE_DIR: join(dataRoot, 'beatmaps'),
        SIDE_B_VISUAL_TOKEN: visualChannelToken,
      },
      // 后端子进程管道化（而非 ignore）：把启动期 stdout/stderr/退出码带回宿主日志，
      // 便于排查 spawn 后即崩的场景（正常运行时行量不大，仅截断首段）。
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout?.on('data', (d: Buffer) => ctx.logger.info('backend-out', String(d).slice(0, 400)))
    child.stderr?.on('data', (d: Buffer) => ctx.logger.warn('backend-err', String(d).slice(0, 600)))
    child.on('exit', (code, sig) => ctx.logger.warn(`dsh-music-mode/server-visual: backend exited code=${code} sig=${sig ?? ''}`))
    child.on('error', (err) => ctx.logger.warn(`dsh-music-mode/server-visual: backend spawn failed ${err.message}`))
    child.unref?.()
  }

  ctx.inject(['webServer'], (httpCtx) => {
    // 注册前缀路由 + 媒体/播放的根路径精确反代；effect 回调返回合并 disposer。
    httpCtx.effect(() => {
      // 前端改写面：/regret-visual/api/** → 后端 /api/**（必须剥掉前缀再转发）
      const off1 = httpCtx.webServer.register({
        kind: 'prefix',
        path: '/regret-visual/api',
        handler: makeApiProxy(backendPort, '/regret-visual/api', visualChannelToken, outerAuth),
      })
      // 前端硬编码的绝对路径（不走 fetch 改写）：音频/封面代理 + 播放器 SSE 在场通道
      // 都直打 DSH 根 /api，精确注册这几条转发到托管后端。新增的 DSH 命令注入端点
      // （/api/player/command）与状态快照端点（/api/player/state）同样走根路径反代，
      // 供 DSH 侧音乐工具经同源调用（loopback 保护在 vendored 后端内）。
      const exactPaths = [
        '/api/audio', '/api/cover', '/api/player/link', '/api/player/command', '/api/player/state',
        // 完整滚动音乐画像：只读 GET；无 checkpoint/pending/consume 状态机。
        '/api/music/taste-summary',
        // 播放器行为埋点 + 画像“最近发生”。写操作仍受 loopback 与 same-origin 双重边界保护。
        '/api/music/events',
        // B 面根路径最小暴露：GET 只回 shared 原文，POST 强制 source=agent + shared。
        '/api/music/notes',
      ]
      const offsExact = exactPaths.map(p => httpCtx.webServer.register({
        kind: 'exact',
        path: p,
        handler: makeApiProxy(backendPort, '', visualChannelToken, outerAuth),
      }))
      // 前端静态承载
      const offStatic = httpCtx.webServer.register({
        kind: 'prefix',
        path: '/regret-visual',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          if (!authorizeOuterRequest(req, outerAuth)) {
            res.writeHead(403, { 'cache-control': 'no-store' }); res.end(); return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405); res.end(); return
          }
          const rawPath = new URL(req.url ?? '/', 'http://x').pathname
          return serveRegret(rawPath, res, stageRoot)
        },
      })
      return () => {
        off1(); offStatic()
        offsExact.forEach(o => o())
        // 回收：DSH 进程退出时停托管后端。
        if (child) { try { child.kill() } catch { /* ignore */ } child = null }
      }
    }, 'dsh-music-mode/server-visual: routes + backend cleanup')
  })
}
