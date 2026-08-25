/**
 * 宿主类型 shim：@deepseek-ai/dsh-tools（npm 发布的包在其依赖链缺失子包时无法
 * 作为 devDep 安装；此处仅声明插件用到的类型面，运行时解析到宿主进程内提供的
 * @deepseek-ai/dsh-tools 真实实现）。
 */
declare module '@deepseek-ai/dsh-tools' {
  /** 参数 schema：每个属性一个 skeleton 定义（宿主会编译为 JSON Schema）。 */
  export type ParameterSchemaSpec = Record<string, unknown>

  /** 工具定义对象的最小形状（宿主 defineTool 的返回值契约）。 */
  export interface ToolDefinition {
    readonly name: string
    readonly description: string
    readonly parameters: unknown
    readonly output?: unknown
    readonly execute: (args: unknown, exec: unknown) => unknown
  }

  export interface DefineToolOptions {
    name: string
    description: string
    parameters?: unknown
    output?: {
      schema?: unknown
      render?: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
    }
    execute: (args: unknown, exec: unknown) => unknown
  }

  /** 由宿主 @deepseek-ai/dsh-tools 提供（运行时解析）。 */
  export function defineTool(options: DefineToolOptions): ToolDefinition
}
