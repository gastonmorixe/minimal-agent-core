export function unknownPluginToolResult(name: string): string {
  return `Unknown plugin tool: ${name}`
}

export function pluginHandlerErrorResult(message: string): string {
  return `Handler error: ${message}`
}

export function subprocessOutputExceededResult(maxBytes: number, message: string): string {
  return `Error: Subprocess output exceeded maximum length of ${maxBytes} bytes. Details: ${message}`
}
