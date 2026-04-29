import type { ToolDefinition } from "../tools"

export interface SendParams {
  messages: unknown[]
  model?: string
  signal?: AbortSignal
}

export interface ToolUse {
  id: string
  name: string
  input: unknown
}

export interface Plugin {
  id: string
  capabilities?: string[]
}

export interface PluginEvent {
  type: string
  payload?: unknown
}

export type ToolHandler = (input: unknown) => Promise<unknown>

export interface StreamProvider {
  id: string
  name: string
  sendMessage(p: SendParams): AsyncGenerator<StreamEvent>
}

export interface StreamConsumer {
  onText(d: string): void
  onToolUse(t: ToolUse): void
  onComplete(r: Response): void
}

export interface PluginHost {
  register(p: Plugin): void
  emit(e: PluginEvent): void
  query(cap: string): Plugin[]
}

export interface ToolRegistry {
  register(t: ToolDefinition): void
  resolve(n: string): ToolHandler | undefined
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "error"; error: Error }
