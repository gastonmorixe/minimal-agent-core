/**
 * Built-in tool text from `text.tools` providers (core-prompts decouple step
 * P1.6). With no provider, the definitions equal today's bytes (fixture
 * tools.json). A provider changes only the text it owns, and the key order
 * stays the same. End to end, a provider reaches the request tools array.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { BuiltinToolText, ToolTextProvider } from "../../plugin-api/src/types/tool-text.ts"
import { ToolRegistryAdapter } from "../adapters/tool-registry-adapter.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse } from "../client/types.ts"
import type { SendOptions, TransportFn } from "../llm/transport/types.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

import {
  BUILTIN_TOOL_NAMES,
  buildToolDefinitions,
  TOOL_DEFINITIONS,
  TOOL_SPECS,
} from "./tool-definitions.ts"

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "minimal-agent-plugins",
  "tests",
  "text-parity",
  "fixtures",
  "tools.json",
)
const hasFixture = existsSync(FIXTURE)

function fixtureJson(): string {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as { toolDefinitionsJson: string })
    .toolDefinitionsJson
}

function provider(texts: Record<string, BuiltinToolText>): ToolTextProvider {
  return { tools: Object.keys(texts), tool: (name) => texts[name] }
}

/** Replace the Bash description and its `command` param text in the old JSON. */
function expectedWithBashStub(): unknown[] {
  const want = JSON.parse(JSON.stringify(TOOL_DEFINITIONS)) as Array<Record<string, any>>
  want[0].description = "STUB bash"
  want[0].input_schema.properties.command.description = "STUB command"
  return want
}

/** Every key in document order, so a reorder shows up. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const out: string[] = []
  for (const [k, v] of Object.entries(value)) {
    out.push(`${prefix}${k}`)
    out.push(...keyPaths(v, `${prefix}${k}.`))
  }
  return out
}

describe("buildToolDefinitions", () => {
  it.skipIf(!hasFixture)("with no provider equals the fixture byte for byte", () => {
    expect(JSON.stringify(buildToolDefinitions(), null, 2)).toBe(fixtureJson())
    expect(JSON.stringify(TOOL_DEFINITIONS, null, 2)).toBe(fixtureJson())
  })

  it("exports the names and specs with no text", () => {
    expect(BUILTIN_TOOL_NAMES).toEqual(TOOL_DEFINITIONS.map((t) => t.name))
    expect(JSON.stringify(TOOL_SPECS)).not.toContain('"description":"')
  })

  it("a Bash provider changes only the Bash text, key order unchanged", () => {
    const bash = TOOL_DEFINITIONS[0]?.input_schema.properties as Record<
      string,
      { description: string }
    >
    const params = Object.fromEntries(Object.entries(bash).map(([k, v]) => [k, v.description]))
    const p = provider({
      Bash: { description: "STUB bash", params: { ...params, command: "STUB command" } },
    })
    const got = buildToolDefinitions([p])
    expect(got).toEqual(expectedWithBashStub() as typeof got)
    expect(keyPaths(got)).toEqual(keyPaths(TOOL_DEFINITIONS))
    expect(JSON.stringify(got.slice(1))).toBe(JSON.stringify(TOOL_DEFINITIONS.slice(1)))
  })

  it("a provider that omits a param keeps the fallback for that param", () => {
    const p = provider({ Bash: { description: "STUB bash", params: { command: "STUB command" } } })
    const got = buildToolDefinitions([p])
    expect(JSON.stringify(got, null, 2)).toBe(JSON.stringify(expectedWithBashStub(), null, 2))
  })

  it("the first provider that owns a tool wins", () => {
    const first = provider({ Bash: { description: "FIRST", params: {} } })
    const second = provider({ Bash: { description: "SECOND", params: {} } })
    expect(buildToolDefinitions([first, second])[0]?.description).toBe("FIRST")
  })
})

const auth: AuthResult = { type: "api-key", token: "test-token" }

/** A transport that records the tools of each request and ends the turn. */
function recordingTransport(seen: SendOptions["tools"][]): TransportFn {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    seen.push(opts.tools)
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

async function requestTools(
  extra: { toolTextProviders?: ToolTextProvider[] } = {},
): Promise<SendOptions["tools"]> {
  const seen: SendOptions["tools"][] = []
  const agent = await buildTestCore({ auth, sendFn: recordingTransport(seen), ...extra })
  const gen = agent.run("go")
  while (!(await gen.next()).done) {}
  return seen[0]
}

describe("tool text reaches the request tools array", () => {
  it("uses the core text with no provider", async () => {
    const tools = await requestTools()
    expect(JSON.stringify(tools)).toBe(JSON.stringify(TOOL_DEFINITIONS))
  })

  it("uses the provider text through buildTestCore", async () => {
    const p = provider({ Bash: { description: "STUB bash", params: { command: "STUB command" } } })
    const tools = await requestTools({ toolTextProviders: [p] })
    expect(JSON.stringify(tools)).toBe(JSON.stringify(expectedWithBashStub()))
  })

  it("the registry adapter reads the loader's providers", () => {
    const p = provider({ Read: { description: "STUB read", params: {} } })
    const loader = {
      getExtraTools: () => [],
      getToolAliases: () => new Map<string, string>(),
      hasTool: () => false,
      toolTextProviders: () => [p],
    } as unknown as PluginLoader
    const read = new ToolRegistryAdapter(loader).list().find((t) => t.name === "Read")
    expect(read?.description).toBe("STUB read")
  })
})
