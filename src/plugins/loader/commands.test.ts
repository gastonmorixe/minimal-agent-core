/**
 * Correctness test for the S34 PORT fold #5: `CommandRegistry`'s own
 * dispatch entry point folds in `../../cli/slash-command-parse.ts`'s
 * `parseCommandLine` / `looksLikeCommand` so a caller never needs a
 * separate import of the parser. Constructs a real `CommandRegistry`
 * directly (not through `PluginLoader`, which is covered end to end by
 * `src/plugins/commands.test.ts`) and drives it with raw submitted text.
 *
 * @module plugins/loader/commands.test
 */

import { describe, expect, it } from "bun:test"

import { EventBus } from "../event-bus.ts"
import { Hooks } from "../hooks/hooks.ts"
import type { CommandContext, CommandResult, ResolvedCommand } from "../types.ts"

import { CommandRegistry, looksLikeCommand, parseCommandLine } from "./commands.ts"

function fakeCommand(
  name: string,
  invoke: (ctx: CommandContext) => Promise<CommandResult>,
): ResolvedCommand {
  return {
    spec: {
      name,
      summary: `the ${name} command`,
      handler: { type: "module", path: "./cmd.ts", export: "default" },
    },
    pluginId: "test-plugin",
    packageDir: "/tmp",
    entryAbsolute: "/tmp/cmd.ts",
    invoke,
  }
}

function newRegistry(commands: ResolvedCommand[]): CommandRegistry {
  return new CommandRegistry(commands, {
    timeoutMs: 1000,
    agent: undefined,
    eventBus: new EventBus(),
    hooksFacade: new Hooks(),
    logger: () => {},
  })
}

describe("CommandRegistry (S34 PORT fold #5: dispatch accepts raw text directly)", () => {
  it("re-exports the exact parseCommandLine / looksLikeCommand this registry folds in", () => {
    expect(parseCommandLine("/widget go")).toEqual({ name: "widget", argv: "go" })
    expect(looksLikeCommand("/widget")).toBe(true)
    expect(looksLikeCommand("plain text")).toBe(false)
  })

  it("isCommand: true only for syntactically-valid AND registered command text, without invoking the handler", async () => {
    let invoked = false
    const registry = newRegistry([
      fakeCommand("widget", async () => {
        invoked = true
        return { kind: "none" }
      }),
    ])
    expect(registry.isCommand("/widget do something")).toBe(true)
    expect(registry.isCommand("/unregistered")).toBe(false)
    expect(registry.isCommand("not a command")).toBe(false)
    expect(registry.isCommand("/usr/bin/env")).toBe(false)
    // isCommand is a pure check: it never runs the handler.
    expect(invoked).toBe(false)
  })

  it("dispatchCommand: end to end from raw text, no separate parser import needed by the caller", async () => {
    const registry = newRegistry([
      fakeCommand("widget", async (ctx) => ({ kind: "expand", prompt: `WIDGET:${ctx.argv}` })),
    ])
    const result = await registry.dispatchCommand("/widget turn it on")
    expect(result).toEqual({ kind: "expand", prompt: "WIDGET:turn it on" })
  })

  it("dispatchCommand: null for non-command text and for an unregistered command name (same contract as before the fold)", async () => {
    const registry = newRegistry([fakeCommand("widget", async () => ({ kind: "none" }))])
    expect(await registry.dispatchCommand("just a prompt")).toBeNull()
    expect(await registry.dispatchCommand("/usr/bin/env")).toBeNull()
    expect(await registry.dispatchCommand("/unknown-name")).toBeNull()
  })
})
