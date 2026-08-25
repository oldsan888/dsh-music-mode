/**
 * 「音乐」tab（client bundle 入口）—— 自 DSH 本体
 * @deepseek-ai/dsh-client-ui-music-mode（2026-08-19）迁入。
 * 向 `conversation.view` 视图环注册 `music-theater` 视图标签（跟 ui-trajectory
 * 同构）。host 半为空占位（聚合包根 apply，src/index.ts）。
 * 依赖：locale（ck 文案）、slots、conversation（宿主 web 提供，type-only 引入）。
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by ui-conversation)
// must be in the program for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MusicTheaterView } from './MusicTheaterView.tsx'
import { en, NS, zh } from './locales.ts'

/** Required services: the conversation slot and the locale service. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the music-mode view tab.
 * The registration rides the slot service's effect wrapper, so plugin unload
 * removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-music-mode: dictionaries')

  const t = ctx.locale.bind(NS)

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'music-theater',
    order: 20,
    locale: NS,
    label: () => t('view.music'),
  }, MusicTheaterView))
}
