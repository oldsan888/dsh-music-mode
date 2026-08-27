/**
 * host 插件：向 DSH agent 注册 17 个 music_* 动作 + music_get_state，
 * 经 server-visual 反代的命令注入端点驱动「音乐」tab 播放器。
 *
 * 自 DSH 本体 @deepseek-ai/dsh-tool-music（2026-08-19）迁入，独立插件化要点：
 * - `@deepseek-ai/dsh-tools` 的 defineTool 为 value import，但 npm 上该包依赖
 *   未发布的内部子包（@deepseek-ai/dsh-type-meta）→ 不能作为普通 devDep 安装；
 *   因此 host 构建将其 external（tsdown external），运行时解析到宿主 DSH 进程
 *   内宿主提供的 @deepseek-ai/dsh-tools（宿主 profile 的 node_modules 提供）。
 * - 本地类型 shim：src/typings/dsh-tools.d.ts（声明 defineTool / ParameterSchemaSpec 形态）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-music-mode/server-tool'

/** Services this plugin needs: the tool registry. */
export const inject = ['tools']

export interface Config {
  /**
   * Base URL of the DSH web server to reach the reverse-proxied command /
   * state endpoints. Defaults to the service port this host binds
   * (`127.0.0.1:3080`), overridable when DSH binds elsewhere.
   */
  baseUrl?: string
  /**
   * user_id sent with every command; defaults to 'default'. This MUST match the
   * player's SSE identity (default in ai-client.js ; a deployer may customize it
   * — see vendor/regret-radio/README.md "Deployer: player `user_id` is configurable").
   * Either keep both at the default or configure both to the same custom id the
   * deploying AI + user chose. A mismatch surfaces as `no_player`.
   */
  userId?: string
  /** Timeout per command relay (ms). Default 4000 (matches backend relay). */
  timeoutMs?: number
}

/** One registry entry: the action name the vendored backend relay accepts. */
interface ActionDef {
  /** The muser name sent to the backend (must be in its 17-command whitelist). */
  name: string
}

/** Shape of the snapshot returned by GET /api/player/state (browser = truth source). */
interface PlayerSnapshot {
  playing?: boolean
  now_playing?: { id?: string; name?: string; artist?: string; provider?: string } | null
  queue?: Array<string | { name?: string }>
}

/** The 17 whitelisted music actions (upstream tools-schema minus weather/rename). */
const ACTIONS: ActionDef[] = [
  { name: 'player_next' },
  { name: 'player_prev' },
  { name: 'player_toggle' },
  { name: 'player_pause' },
  { name: 'player_play' },
  { name: 'player_volume' },
  { name: 'set_play_mode' },
  { name: 'search_music' },
  { name: 'play_song' },
  { name: 'play_stage_index' },
  { name: 'queue_add_song' },
  { name: 'queue_add_index' },
  { name: 'play_queue_index' },
  { name: 'queue_remove' },
  { name: 'queue_clear' },
  { name: 'remove_current' },
  { name: 'rate_song' },
]

/** tool name (DSH-facing) derived from the backend action name. */
function toToolSuffix(actionName: string): string {
  if (actionName.startsWith('player_')) return actionName.slice('player_'.length)
  if (actionName.startsWith('queue_')) return `queue_${actionName.slice('queue_'.length)}`
  // play_song keeps its suffix so it does not collide with player_play → music_play.
  if (actionName === 'play_song') return 'play_song'
  return actionName.replace(/_music$/, '').replace(/_song$/, '').replace(/_index$/, 'index')
}

/** Shared HTTP POST to the command-injection endpoint. */
async function postCommand(
  baseUrl: string,
  userId: string,
  actionName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/player/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: userId, name: actionName, args }),
      signal: controller.signal,
    })
    const text = await res.text()
    let body: unknown
    try { body = JSON.parse(text) } catch { body = text }
    if (!res.ok) {
      const err = (body as { error?: string } | undefined)?.error ?? res.statusText
      throw new Error(`music: ${actionName} rejected (${res.status}): ${err}`)
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

/** Shared HTTP GET for the player state snapshot. */
async function getState(
  baseUrl: string,
  userId: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/$/, '')}/api/player/state?user_id=${encodeURIComponent(userId)}`,
      { signal: controller.signal },
    )
    const text = await res.text()
    let body: unknown
    try { body = JSON.parse(text) } catch { body = text }
    if (!res.ok) throw new Error(`music_get_state rejected (${res.status}): ${text}`)
    return body
  } finally {
    clearTimeout(timer)
  }
}

/** Neutral relay-note shaping: only delivered&&ok claims success (design §4.2). */
function relayText(result: unknown, fallback: string): string {
  if (result === null || typeof result !== 'object') return fallback
  const relay = result as { delivered?: boolean; ok?: boolean; reason?: string; result?: string }
  if (relay.delivered === true && relay.ok === true) {
    return relay.result && relay.result.trim() ? relay.result : `已在播放器${fallback}`
  }
  if (relay.delivered === true && relay.ok === false) {
    return `播放器收到指令但没执行成功：${relay.result ?? '未知原因'}。如实告知，别假装成功了。`
  }
  const why = relay.reason === 'no_player'
    ? '音乐 tab 播放器没开着'
    : relay.reason === 'timeout'
      ? '播放器没响应（页面可能卡了）'
      : '连不上'
  return `${why}——如实告诉用户先打开音乐 tab 我才能放，别假装成功了。`
}

export function apply(ctx: Context, config: Config = {}): void {
  const baseUrl = config.baseUrl ?? 'http://127.0.0.1:3080'
  const userId = config.userId?.trim() || 'default'
  const timeoutMs = config.timeoutMs ?? 4000

  const run = async (actionName: string, args: Record<string, unknown>): Promise<unknown> => {
    return postCommand(baseUrl, userId, actionName, args, timeoutMs)
  }

  // ── 17 action tools ────────────────────────────────────────────────────
  for (const def of ACTIONS) {
    const toolName = `music_${toToolSuffix(def.name)}`
    const desc = MUSIC_TOOL_DESCRIPTIONS[def.name] ?? { description: `音乐：${def.name}` }
    ctx.tools.register(defineTool({
      name: toolName,
      description: desc.description,
      parameters: desc.parameters ?? {},
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_args, value) => [{
          type: 'text',
          text: String((value as unknown as { __text?: string } | null | undefined)?.__text ?? JSON.stringify(value)),
        }],
      },
      async execute(args, exec) {
        void exec
        const result = await run(def.name, args as Record<string, unknown>)
        const text = relayText(result, `${def.name} 指令已发出`)
        return { ok: true, __text: text }
      },
    }))
  }

  // ── music_get_state ────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'music_get_state',
    description:
      '查看音乐 tab 播放器的当前状态：正在放的歌、播放/暂停、队列、最近搜索结果。'
      + '被问「现在放什么/在放啥/队列里有什么/刚放的叫什么」时调用。'
      + '返回播放器快照（唯一真相源=浏览器播放器）；无快照则返回空闲态。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{
        type: 'text',
        text: String((value as unknown as { __text?: string } | null | undefined)?.__text ?? JSON.stringify(value)),
      }],
    },
    async execute(_args, exec) {
      void exec
      const state = await getState(baseUrl, userId, timeoutMs)
      const s = state as PlayerSnapshot
      const now = s?.now_playing
        ? `《${s.now_playing.name ?? '未知'}》${s.now_playing.artist ? ` - ${s.now_playing.artist}` : ''}`
        : '当前没有在放的歌'
      const queue = Array.isArray(s?.queue) && s.queue.length > 0
        ? `队列（${s.queue.length} 首）：${s.queue
          .slice(0, 5).map((q: string | { name?: string }, i: number) => {
            const label = typeof q === 'string' ? q : (q?.name ?? '')
            return `${i + 1}. ${label}`
          }).join('；')}`
        : '队列为空'
      const playing = s?.playing === true ? '播放中' : '未播放'
      const text = `${now}（${playing}）；${queue}`
      return {
        ok: true,
        now_playing: s?.now_playing ?? null,
        playing: s?.playing === true,
        queue_length: s?.queue?.length ?? 0,
        __text: text,
      }
    },
  }))

  // ── music_taste_summary：音乐事实源的完整滚动画像（只读）─────────────────
  ctx.tools.register(defineTool({
    name: 'music_taste_summary',
    description:
      '只读获取音乐数据库中的完整滚动口味画像（原始事件总量、近180天事件分布、歌手倾向、'
      + '反复完整播放、15秒内快切、已授权手记聚合）。涉及音乐推荐、询问用户音乐品味、解释近期听歌习惯，'
      + '或准备写入/刷新长期音乐记忆时，必须先调用本工具获取实时权威数据。工具无参数、无副作用，'
      + '不生成 pending、不推进 checkpoint、不消费任何状态。返回内容是 agent-inferred 行为推断；'
      + '用户当前或长期记忆中的明确喜恶永远优先。若写长期记忆，可用 scope=music、key=music-taste，'
      + '但必须保留 basis=agent-inferred，且以本工具返回的完整滚动快照整体更新。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{
        type: 'text',
        text: String((value as unknown as { __text?: string } | null | undefined)?.__text ?? JSON.stringify(value)),
      }],
    },
    async execute(_args, exec) {
      void exec
      const root = baseUrl.replace(/\/$/, '')
      const timeout = timeoutMs * 2
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const res = await fetch(`${root}/api/music/taste-summary?user_id=${encodeURIComponent(userId)}`, {
          signal: controller.signal,
        })
        const text = await res.text()
        let body: any
        try { body = JSON.parse(text) } catch { body = text }
        if (!res.ok) throw new Error(`music_taste_summary rejected (${res.status}): ${text}`)
        const summary = typeof body?.summary === 'string' ? body.summary : '（暂无音乐行为可供分析）'
        return {
          ...body,
          ok: true,
          __text: `${summary}\n数据源：music_events + music_preferences（实时只读）；长期记忆仅作缓存，明确喜恶优先。`,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }))

  // ── B 面手记：用户原话写入 / 已授权原文读取 ─────────────────────────────
  ctx.tools.register(defineTool({
    name: 'music_note_write',
    description:
      '仅当用户明确表达对某首歌或此刻听歌的感受时，把用户原话写入「B 面」。'
      + '禁止把播完、循环、跳过等行为推断改写成用户感受；禁止替用户解释情绪。'
      + 'text 必须保留用户原话或只做最小的口语整理。track_id 不填时使用当前播放歌曲。'
      + '如果用户原话明确表达“喜欢/很喜欢/爱听”或“不喜欢/难听/不爱听”，必须同时填写 preference；'
      + '本工具会原子记录明确喜恶，无需再调用 music_rate_song。仅有播放行为或含糊情绪时禁止填写 preference。'
      + '经本工具写入代表用户已亲口对 DSH 分享，原文会被标记为已授权。',
    parameters: {
      text: { type: 'string', description: '用户原话，必填，最多 500 字。不得代写或扩写。' },
      mood: { type: 'string', enum: ['sad', 'miss', 'calm', 'relief', 'lift', 'annoyed', 'numb', 'pure'], description: '仅在用户明确表达且可直接对应时填写。' },
      preference: { type: 'string', enum: ['liked', 'disliked'], description: '仅在用户明确说喜欢或不喜欢这首歌时填写；liked=明确喜欢，disliked=明确不喜欢。' },
      track_id: { type: 'string', description: '曲目 id；省略时取当前播放。' },
      track_title: { type: 'string', description: '已知曲名；省略时取当前播放。' },
      track_artist: { type: 'string', description: '已知歌手；省略时取当前播放。' },
      provider: { type: 'string', description: 'netease / qq / local；省略时取当前播放。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: String((value as any)?.__text ?? JSON.stringify(value)) }],
    },
    async execute(args, exec) {
      void exec
      const a = args as Record<string, unknown>
      const text = typeof a.text === 'string' ? a.text.trim() : ''
      if (!text) throw new Error('music_note_write: text required')
      let track = {
        id: typeof a.track_id === 'string' ? a.track_id.trim() : '',
        name: typeof a.track_title === 'string' ? a.track_title.trim() : '',
        artist: typeof a.track_artist === 'string' ? a.track_artist.trim() : '',
        provider: typeof a.provider === 'string' ? a.provider.trim() : '',
      }
      if (!track.id) {
        const state = await getState(baseUrl, userId, timeoutMs) as PlayerSnapshot
        const now = state?.now_playing
        if (!now?.id) throw new Error('music_note_write: 当前没有可锚定的播放曲目，请先让用户明确是哪首歌')
        track = { id: now.id, name: now.name ?? '', artist: now.artist ?? '', provider: now.provider ?? '' }
      }
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/music/notes`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          user_id: userId, track_id: track.id, track_title: track.name,
          track_artist: track.artist, provider: track.provider, text,
          mood: typeof a.mood === 'string' ? a.mood : undefined,
          preference: a.preference === 'liked' || a.preference === 'disliked' ? a.preference : undefined,
        }),
      })
      const body = await res.json() as any
      if (!res.ok) throw new Error(`music_note_write rejected (${res.status}): ${body?.error ?? res.statusText}`)
      const preference = a.preference === 'liked' || a.preference === 'disliked' ? a.preference : ''
      if (preference && body?.preference_recorded !== preference) {
        throw new Error('music_note_write: explicit preference was not persisted')
      }
      const preferenceText = preference === 'liked' ? '，并记录为用户明确喜欢'
        : preference === 'disliked' ? '，并记录为用户明确不喜欢' : ''
      return {
        ok: true,
        note_id: body?.note?.note_id,
        shared: true,
        preference: preference || undefined,
        __text: `已把用户原话写在《${track.name || '这首歌'}》的 B 面${preferenceText}。`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'music_notes_read',
    description:
      '读取「B 面」听感手记的 L1 聚合，以及用户已逐条授权给 DSH 的原文。'
      + '未授权原文在服务端结构性不可达；不得据行为或聚合数据替用户解释情绪。',
    parameters: {
      work_key: { type: 'string', description: '可选，按跨源作品键筛选。' },
      track_id: { type: 'string', description: '可选，按精确曲目 id 筛选。' },
      limit: { type: 'integer', description: '返回已授权原文条数，1-100，默认 30。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: String((value as any)?.__text ?? JSON.stringify(value)) }],
    },
    async execute(args, exec) {
      void exec
      const a = args as Record<string, unknown>
      const qs = new URLSearchParams({ user_id: userId, limit: String(Math.min(Math.max(Number(a.limit) || 30, 1), 100)) })
      if (typeof a.work_key === 'string' && a.work_key.trim()) qs.set('work_key', a.work_key.trim())
      else if (typeof a.track_id === 'string' && a.track_id.trim()) qs.set('track_id', a.track_id.trim())
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/music/notes?${qs}`)
      const body = await res.json() as any
      if (!res.ok) throw new Error(`music_notes_read rejected (${res.status}): ${body?.error ?? res.statusText}`)
      return {
        ok: true, aggregate: body.aggregate, items: body.items,
        __text: `B 面共 ${body?.aggregate?.count ?? 0} 条；可读取的已授权原文 ${body?.items?.length ?? 0} 条。\n${JSON.stringify(body)}`,
      }
    },
  }))
}

/** Model-facing descriptions (semantics borrowed from upstream tools-schema, adapted to DSH). */
const MUSIC_TOOL_DESCRIPTIONS: Record<string, { description: string; parameters?: ParameterSchemaSpec }> = {
  player_next: {
    description: '切到队列里的下一首歌。用户说「下一首」「换一首」「跳过」时调用。',
    parameters: {},
  },
  player_prev: {
    description: '切到队列里的上一首歌。用户说「上一首」「回到刚才那首」时调用。',
    parameters: {},
  },
  player_toggle: {
    description: '暂停或继续当前播放（切换状态）。「暂停」「停一下」「继续」「接着放」时调用。',
    parameters: {},
  },
  player_pause: {
    description: '暂停播放（幂等：已暂停就什么都不做，绝不会反向变成播放）。「暂停」「停一下」时调用。',
    parameters: {},
  },
  player_play: {
    description: '继续/开始播放（幂等：已在播就什么都不做）。「继续」「接着放」时调用。',
    parameters: {},
  },
  player_volume: {
    description: '调整音量。delta 是相对变化（-1~1，如 0.1 = +10%），set 是绝对值（0~1）。「大点声」「小点」用 delta，「调到一半」用 set。两个参数只传一个。',
    parameters: {
      delta: { type: 'number', description: '相对变化量，如 0.1 / -0.15。范围 -1 到 1。' },
      set: { type: 'number', description: '绝对音量，0 到 1。' },
    },
  },
  set_play_mode: {
    description: '设置播放模式。「单曲循环/循环这首」→single；「随机/随便放/打乱」→shuffle；「顺序/正常播」→loop。',
    parameters: {
      mode: { type: 'string', enum: ['loop', 'single', 'shuffle'], description: 'loop=顺序循环, single=单曲循环, shuffle=随机。' },
    },
  },
  search_music: {
    description: '搜索歌曲并展示到音乐 tab 的右侧动态舞台（不立即播放）。「搜示例歌手」「推荐几首慵懒的歌」等调用。query 必须具体（歌名或歌手，可「歌名 歌手」），禁止用风格/心情描述词。',
    parameters: {
      query: { type: 'string', description: '具体歌名或单个歌手名，或「歌名 歌手」。拿不准歌名就只搜歌手名，禁止编造歌名。' },
    },
  },
  play_song: {
    description: '搜索后直接播放第一首匹配（后端真选定，不失手）。「放首示例歌曲」「来首示例歌手」「想听 X」「帮我放 X」都调用。结果会带回实际选中的歌，播报以它为准。',
    parameters: {
      query: { type: 'string', description: '具体歌名或单个歌手名，或「歌名 歌手」。拿不准歌名就只搜歌手名，禁止编造歌名。' },
    },
  },
  play_stage_index: {
    description: '直接播放右侧搜索结果池第 N 首（1-based）。「播放右边的第三首」时调用。注意：若搜索池已变，序号可能对不上——优先用 play_song 带歌名。',
    parameters: {
      index: { type: 'integer', description: '1-based 索引。' },
    },
  },
  queue_add_song: {
    description: '搜索后把第一首匹配加入播放队列（不立即播放）。「把示例歌曲加到队列」时调用。当前没在播时，入队会自动从第一首开始播放。',
    parameters: {
      query: { type: 'string', description: '歌名或「歌名 歌手」。别编造歌名。' },
    },
  },
  queue_add_index: {
    description: '把右侧搜索结果池第 N 首加入队列（不立即播放）。「把第五首加到队列」时调用。当前没在播时入队会自动开始播放。',
    parameters: {
      index: { type: 'integer', description: '1-based 索引。' },
    },
  },
  play_queue_index: {
    description: '播放队列里的第 N 首（1-based）。「听队列里的第三首」时调用。区分：右侧结果池第 N 首用 play_stage_index。',
    parameters: {
      index: { type: 'integer', description: '队列中的 1-based 序号。' },
    },
  },
  queue_remove: {
    description: '从队列移除第 N 首（1-based）。移除当前在播的用 remove_current。',
    parameters: {
      index: { type: 'integer', description: '队列中的 1-based 序号。' },
    },
  },
  queue_clear: {
    description: '清空整个播放队列并停止播放。「清空队列」「把队列清了」时调用。',
    parameters: {},
  },
  remove_current: {
    description: '移除当前正在播放的这首歌并自动切到下一首。用户嫌弃当前这首时调用：「这首不好听」「难听换掉」。',
    parameters: {},
  },
  rate_song: {
    description: '只记录用户对当前曲目的明确好恶，不保存 B 面原话。若用户同时说出了值得保留的听感原话，应改用 music_note_write 并填写 preference，禁止两个工具重复记录同一次表达。',
    parameters: {
      liked: { type: 'boolean', description: 'true=喜欢，false=不喜欢。' },
    },
  },
}
