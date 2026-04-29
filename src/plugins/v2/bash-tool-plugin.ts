import type { Plugin } from "./plugin-sdk"
export const BashPlugin: Plugin = {
  manifest: {
    id: "core.bash",
    name: "Bash",
    version: "1.0.0",
    capabilities: ["tool"],
    permissions: ["process:exec"],
  },
  async activate(ctx) {
    const shell = process.env.SHELL || "/bin/bash"
    ctx.host.registerTool({
      name: "Bash",
      execute: async (input: any) => {
        const p = Bun.spawn([shell, "-c", input.command], { stdout: "pipe", stderr: "pipe" })
        return { text: await new Response(p.stdout).text(), exitCode: await p.exited }
      },
    })
  },
}
