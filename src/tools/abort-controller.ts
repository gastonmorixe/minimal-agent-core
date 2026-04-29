// Tool Abort Controller — Agent-4 P0 Fix
// Allows Ctrl-C to cancel a running tool without killing the REPL

export class ToolAbortController {
  private controller: AbortController | null = null
  private signalHandler: (() => void) | null = null

  /** Start watching for abort signals during tool execution */
  begin(): AbortSignal {
    this.controller = new AbortController()

    // Intercept SIGINT during tool execution
    this.signalHandler = () => {
      this.controller?.abort()
    }
    process.on("SIGINT", this.signalHandler)

    return this.controller.signal
  }

  /** Stop watching — restore normal SIGINT behavior */
  end(): void {
    if (this.signalHandler) {
      process.off("SIGINT", this.signalHandler)
      this.signalHandler = null
    }
    this.controller = null
  }

  /** Check if currently aborted */
  get aborted(): boolean {
    return this.controller?.signal.aborted ?? false
  }
}

// Usage in tools.ts executeTool:
// const abort = new ToolAbortController();
// const signal = abort.begin();
// try {
//   const proc = Bun.spawn([...], { signal });
//   ...
// } catch (e) {
//   if (signal.aborted) return { content: "Tool aborted by user", isError: false };
//   throw e;
// } finally {
//   abort.end();
// }
