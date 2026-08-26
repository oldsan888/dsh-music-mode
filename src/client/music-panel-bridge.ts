/**
 * 音乐面板（dube-panel）· 对话桥 —— Phase 2（dube-panel-chat-design.md §5）。
 *
 * 职责：从 DSH client 会话快照（snapshot.chat.legacy.nodes 的完整对话树）提取结构化
 * 事件（user/assistant/step{think,tool}，带 turnId、保序），增量推送给播放器 iframe
 * 内的 dube-panel（ai-overlay 的 AI.renderStructuredEvents 消费）。
 *
 * 铁律：全部在音乐插件自身（不改 DSH 源码）——数据来自宿主对话视图注入的 useSession
 * 快照（type-only shim），iframe 是 MusicTheaterView 的模块级单例。
 */

/** 结构化事件（与 dube-panel-chat-design.md §3.2 协议一致，工作区 Time-持久 JSON 结构）。 */
export interface DubePanelEvent {
  /** 回合标识：同一轮 user/assistant/step 共用（引擎 turn 号兜底 seq）。 */
  readonly turnId: string
  readonly kind: 'user' | 'assistant' | 'step'
  readonly text: string
  /** step 细分：think / tool（tool 由 ai-overlay 加 🔧 前缀）。 */
  readonly type?: 'think' | 'tool'
  /** 源节点 seq（增量去重/推进用）。 */
  readonly seq: number
}

/** 从会话快照对话树提取结构化事件。防御性读取：字段缺失/未知 kind 静默跳过。 */
export function extractDubeEvents(nodes: readonly unknown[] | undefined | null): DubePanelEvent[] {
  if (!Array.isArray(nodes)) return []
  const out: DubePanelEvent[] = []
  for (const node of nodes as ReadonlyArray<Record<string, unknown>>) {
    if (!node || typeof node !== 'object') continue
    const kind = node.kind
    const seq = Number(node.seq ?? 0) || 0
    const turn = Number(node.turn)
    const turnId = Number.isFinite(turn) && turn >= 0 ? `t${turn}` : `s${seq}`
    if (kind === 'user') {
      const text = flattenTextBlocks(node.content)
      if (text) out.push({ turnId, kind: 'user', text, seq })
    } else if (kind === 'assistant') {
      const blocks = Array.isArray(node.blocks) ? node.blocks as ReadonlyArray<Record<string, unknown>> : []
      let body = ''
      const steps: DubePanelEvent[] = []
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue
        if (b.kind === 'text' && typeof b.text === 'string') {
          body += (body ? '\n' : '') + b.text
        } else if (b.kind === 'reasoning' && typeof b.text === 'string') {
          steps.push({ turnId, kind: 'step', type: 'think', text: b.text, seq })
        } else if (b.kind === 'tool-call') {
          const name = typeof b.name === 'string' ? b.name : ''
          const args = typeof b.argsRaw === 'string' ? b.argsRaw : ''
          const label = name ? `${name}${args ? ' ' + args.slice(0, 200) : ''}` : 'tool'
          steps.push({ turnId, kind: 'step', type: 'tool', text: label, seq })
        }
      }
      // 步骤先于正文（与 renderStructuredEvents 装配一致：先 appendThinking 后 appendSentence）
      out.push(...steps)
      if (body) out.push({ turnId, kind: 'assistant', text: body, seq })
    }
    // 其他 kind（tool-result/context/steering/compaction 等）暂不进音乐面板。
  }
  return out
}

/** 从 ContentBlock[] 提取全部 text 块拼接（dsh-llm ContentBlock 以 type==='text' 携带 text）。 */
function flattenTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content as ReadonlyArray<Record<string, unknown>>) {
    if (!block || typeof block !== 'object') continue
    if ((block.type === 'text' || block.kind === 'text') && typeof block.text === 'string') {
      out += (out ? '\n' : '') + block.text
    }
  }
  return out
}

/** 找播放器单例 iframe（MusicTheaterView 注入，title='REGRET 音乐'，同源）。 */
export function findMusicFrame(): Window | null {
  // 优先走保活单例上找 iframe：宿主 div[data-music-theater] 内首个 iframe
  const host = document.querySelector<HTMLElement>('[data-music-theater]')
  const frame = host?.querySelector<HTMLIFrameElement>('iframe')
  const win = frame?.contentWindow ?? null
  if (win !== null) return win
  // 兜底：任何标题匹配的 iframe（单例不在树里时）
  const anyFrame = document.querySelector<HTMLIFrameElement>('iframe[title="REGRET 音乐"]')
  return anyFrame?.contentWindow ?? null
}

/** 把事件批量 postMessage 给 dube-panel（ai-overlay 监听消费）。 */
export function postDubeEvents(events: DubePanelEvent[]): boolean {
  if (events.length === 0) return false
  const win = findMusicFrame()
  if (win === null) return false
  win.postMessage({ type: 'dube-panel.events', payload: events }, '*')
  return true
}

/** Clear the iframe mirror before switching to another DSH session. */
export function resetDubePanel(): boolean {
  const win = findMusicFrame()
  if (win === null) return false
  win.postMessage({ type: 'dube-panel.reset' }, '*')
  return true
}

/** 增量推送器：记住已推送的最大 seq，只推新节点（避免整段重发）。 */
export function createDubePanelPusher(
  send: (events: DubePanelEvent[]) => boolean = postDubeEvents,
) {
  let lastSeq = 0
  return {
    /** 喂整棵（或新增）节点列表，只推 seq 大于上次的值，返回本次推送条数。 */
    push(nodes: readonly unknown[] | undefined | null): number {
      const all = extractDubeEvents(nodes)
      const fresh = all.filter((e) => e.seq > lastSeq)
      if (fresh.length === 0) return 0
      lastSeq = Math.max(...all.map((e) => e.seq))
      return send(fresh) ? fresh.length : 0
    },
    /** 会话切换时重置游标（避免把旧会话历史推给新 iframe）。 */
    reset(seq = 0): void {
      lastSeq = seq
    },
  }
}
