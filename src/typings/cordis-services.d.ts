/**
 * 宿主 services 类型 shim：把 dsh-music-mode 用到的 cordis 服务（webServer、
 * tools、locale、slots）注入到 cordis Context 的声明合并面。运行期这些服务由
 * 宿主 DSH 提供（cordis 服务注册表按名取用），此处仅供类型检查。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** host：webServer 服务（server-visual 托管路由用）。 */
    webServer: {
      register(opts: {
        kind: 'prefix' | 'exact'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }): () => void
      tapIndex?(fn: (html: string) => string): () => void
    }
    /** host：工具注册服务（server-tool 注册 music_* 用）。 */
    tools: {
      register(tool: unknown): unknown
    }
    /** client：locale 服务（音乐 tab 文案字典）。 */
    locale: {
      register(namespace: string, dictionaries: unknown): unknown
      bind(namespace: string): (key: string) => string
    }
    /** client：视图环插槽服务（音乐 tab 注册 conversation.view）。 */
    slots: {
      inject<K extends string>(name: K, register: () => unknown): unknown
      register(opts: {
        name: string
        id: string
        order: number
        locale?: string
        label: () => string
      }, component: unknown): unknown
    }
    effect(fn: () => unknown, label?: string): unknown
  }
}
