export interface PluginManifest {
  id: string
  name: string
  version: string
  capabilities: string[]
  permissions: string[]
}
export interface Plugin {
  manifest: PluginManifest
  activate(ctx: PluginContext): Promise<void>
  deactivate?(): Promise<void>
}
export interface PluginContext {
  config: Record<string, unknown>
  logger: any
  bus: EventBus
  host: PluginHostAPI
}
export interface PluginHostAPI {
  registerTool(t: any): void
  registerHook(e: string, h: Function): void
}
export interface EventBus {
  emit(e: string, p?: unknown): void
  on(e: string, h: (p: unknown) => void): () => void
}
