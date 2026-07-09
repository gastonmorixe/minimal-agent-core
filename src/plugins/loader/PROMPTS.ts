/** Returns the error string for an invocation of an unregistered plugin tool name. */
export function unknownPluginToolResult(name: string): string {
  return `Unknown plugin tool: ${name}`
}

/** Returns the error string for a plugin tool handler that threw. */
export function pluginHandlerErrorResult(message: string): string {
  return `Handler error: ${message}`
}

/** Returns the error string for a plugin subprocess whose output exceeded the byte limit. */
export function subprocessOutputExceededResult(maxBytes: number, message: string): string {
  return `Error: Subprocess output exceeded maximum length of ${maxBytes} bytes. Details: ${message}`
}
