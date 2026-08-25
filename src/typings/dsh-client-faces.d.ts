/**
 * 宿主 client 类型 shim：本插件对 @deepseek-ai/dsh-client-* 仅做 **type-only**
 * 引用（运行时由宿主 web 提供服务，经 cordis context 取用）。这些包未作为
 * 依赖安装（npm 无完整发布），此处声明它们导出的类型面，使 typecheck 通过。
 */
declare module '@deepseek-ai/dsh-client-locale/client' {
  // 只为向 cordis Context 合并 ctx.locale；具体类型见 src/typings/cordis-services.d.ts
  export {}
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  /** 会话视图环共享 props（宽松近似；运行期结构由宿主对话视图提供）。
   *  Phase 2：useSession(selector) 订阅会话快照（snapshot 含 .chat 完整对话 / .views 各视图快照），
   *  sessionId 为当前会话 id —— 供 music-panel 桥把真实对话转发到 dube-panel（dube-panel-chat-design.md §5）。 */
  export interface ConvViewProps {
    /** 订阅当前会话快照；selector 取快照子集，变化触发重渲。 */
    useSession?: <T>(selector: (snapshot: any) => T) => T
    /** 当前会话 id。 */
    sessionId?: string
    /** 加载更早历史（返回是否新增）。 */
    loadOlder?: () => Promise<boolean>
    [key: string]: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** 本地化 props 座席（宽松近似）。 */
  export interface PropsLocale<N extends string = string> {
    [key: string]: unknown
  }
  /** 各包的本地化字典 key 集（供 locale 强类型合并）。 */
  export interface LocaleNamespaceMap {
    [namespace: string]: unknown
  }
}
