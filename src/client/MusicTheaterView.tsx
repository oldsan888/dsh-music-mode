/**
 * 音乐·舞台视图：注册进 `conversation.view` 视图环的全屏页（**保活版**）。
 *
 * 承载 **完整 Regret-radio 应用**（「音乐」tab 就是它的完整界面）。
 *
 * 保活机制（解决"切 tab 音乐停了"）：`conversation.view` 切换 tab 时会卸载
 * 当前视图组件再挂载新视图。若 iframe 长在 React 树里，随卸载即销毁 → 播放归零。
 * 这里把 iframe 做成**模块级单例**，挂到**对话内容滚动区**（data-conversation-scroll，
 * 它是 ConversationRoot 的常驻滚动体，不随视图切换卸载）：切走时组件卸载但 host
 * 只隐藏（音乐继续），切回时复用并显示。
 *
 * 关键：host 只铺满**对话内容区**（absolute 于滚动容器内），绝不 `fixed` 全屏——
 * 顶部 tab 行与左侧列表都留在 host 之外，随时可切回「对话」。
 *
 * 后端由 host 半托管（spawn Regret server.ts + 反代），前端 `/api/*` 改写反代。
 */

import { useEffect } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { createDubePanelPusher, resetDubePanel } from './music-panel-bridge.ts'

/** 同源视觉 iframe 地址（host 半 serve 的 Regret 前端静态根）。 */
const VISUAL_URL = '/regret-visual/'

/** 保活单例：跨视图挂载/卸载存活的宿主 div（内含 iframe）。 */
let singletonHost: HTMLDivElement | null = null

/** 锚点：对话内容滚动区（常驻，不随视图切换卸载）。找它能保住播放又限定覆盖范围。 */
function findScrollport(): HTMLElement | null {
  return document.querySelector('[data-conversation-scroll]') as HTMLElement | null
}

/** 取（或创建）共享 iframe 宿主容器，挂到对话内容滚动区内部（常驻但只占内容区）。 */
function ensureHost(): HTMLDivElement {
  if (singletonHost !== null && singletonHost.isConnected) return singletonHost

  let host = singletonHost
  if (host === null) {
    host = document.createElement('div')
    host.dataset.musicTheater = ''
    const frame = document.createElement('iframe')
    frame.title = 'REGRET 音乐'
    frame.src = VISUAL_URL
    frame.allow = 'autoplay; clipboard-write'
    frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#0b0e1a'
    host.appendChild(frame)
    singletonHost = host
  }

  // host 铺满对话内容区但**让出输入框座席**：
  // 滚动区上由 ui-conversation 动态写入 --dsh-composer-height（输入框含
  // “进行中的目标”等的实际高度）→ bottom 用该变量，控制台永不被输入框挡，
  // 且输入框多行/增减时自适应（不写死百分比）。
  host.style.cssText = [
    'position: absolute',
    'top: 0',
    'left: 0',
    'right: 0',
    'bottom: var(--dsh-composer-height, 160px)',
    'overflow: hidden',
    'background: #0b0e1a',
    // 低于 composerSeat(7)：输入框仍浮在 host 之上；高于普通正文内容。
    'z-index: 5',
  ].join(';')

  const scrollport = findScrollport()
  if (scrollport !== null) {
    // 关键：让滚动区成为 host 的定位上下文（containing block）。
    // 若不加 relative，absolute host 会回溯到 AppFrame .frame（全宽），
    // 从而盖住左侧列表和顶部 tab —— 这正是之前"割裂"的根因。
    if (getComputedStyle(scrollport).position === 'static') {
      scrollport.style.position = 'relative'
    }
    if (host.parentElement !== scrollport) {
      scrollport.appendChild(host)
    }
  } else if (host.parentElement !== document.body) {
    // 无滚动区（空会话/hero）→ 兜底挂 body，但保持 content 定位不铺全屏也难，
    // 这种情况极少；至少不 fixed 全屏。
    host.style.position = 'static'
    host.style.width = '100%'
    host.style.height = '100%'
    document.body.appendChild(host)
  }
  return host
}

/** 视图卸载时切走：隐藏宿主（iframe 保留、音乐继续），不销毁。 */
function hideHost(): void {
  if (singletonHost !== null) {
    singletonHost.style.display = 'none'
  }
}

/**
 * 视图每次挂载时重新校正锚点：确保 host 挂在正确的对话内容滚动区、且滚动区是
 * 定位上下文（absolute containing block）。切 tab 期间滚动区节点可能被 React
 * 重建（relative 丢失），此处在显示前重挂/重定位。
 */
function reAnchor(): void {
  const host = singletonHost
  if (host === null) return
  const scrollport = findScrollport()
  if (scrollport === null) return
  if (getComputedStyle(scrollport).position === 'static') {
    scrollport.style.position = 'relative'
  }
  if (host.parentElement !== scrollport) {
    scrollport.appendChild(host)
  }
}

/** Full props: the standard session view ring share + the music-mode locale seat. */
export type MusicTheaterViewProps = ConvViewProps & PropsLocale<'music-mode'>

/* —— Phase 2 对话桥（dube-panel-chat-design.md §5）：模块级单例，保活跨视图挂载 —— */
const dubePanelPusher = createDubePanelPusher() // 单例游标：增量跨挂载一致，绝不整段重发
let dubePanelLastNodes: readonly unknown[] | null = null
let dubePanelLastSessionId: string | null = null
let dubePanelReadyBound = false
/** iframe 内 ai-overlay 就绪后请求回放：把最近会话节点补推一次（防首帧丢事件）。 */
function ensureDubePanelReadyListener(): void {
  if (dubePanelReadyBound) return
  dubePanelReadyBound = true
  window.addEventListener('message', (ev) => {
    const data = (ev as MessageEvent<{ type?: string }>).data
    if (data && data.type === 'dube-panel.ready') {
      // A ready message means the iframe document was freshly loaded and its DOM is empty.
      // Reset the parent-side cursor so the complete current conversation is replayed.
      dubePanelPusher.reset()
      dubePanelPusher.push(dubePanelLastNodes ?? [])
    }
  })
}

/** 对话内容区舞台组件：复用保活 iframe，挂载显示、卸载隐藏（音乐不断）。 */
export function MusicTheaterView({ sessionId, useSession }: MusicTheaterViewProps) {
  // Phase 2：订阅会话快照 .chat（完整对话树），变化时增量推给 dube-panel。
  const chat = useSession?.((s: any) => (s && s.chat) ?? null)
  useEffect(() => {
    ensureHost()
    reAnchor()
    const host = ensureHost()
    host.style.display = 'block'
    ensureDubePanelReadyListener()
    pushAndHold(String(sessionId), chat)
    return () => {
      // 切走：隐藏而非移除，保 iframe/播放存活。
      hideHost()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    pushAndHold(String(sessionId), chat)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, chat])
  // 组件渲染时自身 return null：真正可见的是常驻滚动区里的 host。
  return null
}

/** 取最新节点 + 保持游标有序地推送（顺序敏感，见 music-panel-bridge）。 */
function pushAndHold(sessionId: string, chat: any): void {
  if (dubePanelLastSessionId !== sessionId) {
    dubePanelLastSessionId = sessionId
    dubePanelLastNodes = null
    dubePanelPusher.reset()
    resetDubePanel()
  }
  const nodes = (chat && (chat.legacy?.nodes ?? chat.nodes?.values?.())) ?? null
  if (Array.isArray(nodes)) {
    dubePanelLastNodes = nodes
    dubePanelPusher.push(nodes)
  }
}
