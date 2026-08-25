/**
 * 宿主类型 shim：@deepseek-ai/dsh-host-webserver —— 仅声明 webServer 服务注入面
 * （运行期由宿主 DSH 的 webServer 插件提供，插件只在 cordis 服务注册表里按名取用）。
 */
declare module '@deepseek-ai/dsh-host-webserver' {
  import type { IncomingMessage, ServerResponse } from 'node:http'

  export interface WebServer {
    register(options: {
      kind: 'prefix' | 'exact'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
    tapIndex?(fn: (html: string) => string): () => void
  }

  export {}
}
