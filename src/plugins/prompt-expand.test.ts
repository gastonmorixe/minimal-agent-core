/**
 * Tests of the one core render point (step 14, design 50 §2). A stub
 * template provider uppercases each `%%X%%` token, so a test sees which text
 * core rendered. Core knows no syntax: only the stub reads the tokens.
 */

import { afterEach, describe, expect, it } from "bun:test"

import { createSyntheticTextResolver } from "../agent/synthetic-text.ts"
import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import {
  clearSystemPromptBase,
  getPromptExpander,
  setSystemPromptBase,
} from "../llm/system-prompt-base-registry.ts"
import { placedHookContext, splitHookContextPlaced } from "../sdk/hook-context.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import { buildToolDefinitions } from "../tools/tool-definitions.ts"

import { expandSchemaDescriptions, pluginToolDefinitionFromTrigger } from "./loader/helpers.ts"
import {
  createPromptExpander,
  DEFAULT_PROMPT_EXPANDER,
  expandPluginText,
  isPromptTemplateText,
} from "./prompt-expand.ts"
import {
  collectSystemPromptParts,
  createSystemPromptBaseHolder,
  registerSystemPromptBase,
  resolveBaseIdentity,
} from "./system-prompt-base.ts"
import type { PromptExpandContext, PromptTemplateProvider } from "./types.ts"

const TOKEN = /%%([A-Za-z]+)%%/g

/** A stub engine: `%%x%%` becomes `X`, or the var value when `ctx.vars` has `x`. */
function upperStub(calls: PromptExpandContext[] = []): PromptTemplateProvider {
  return {
    render: () => "",
    expand(text, ctx) {
      if (ctx !== undefined) calls.push(ctx)
      return text.replace(TOKEN, (_m, name: string) => {
        const v = ctx?.vars[name]
        return v === undefined ? name.toUpperCase() : String(v)
      })
    },
  }
}

function throwingStub(): PromptTemplateProvider {
  return {
    render: () => "",
    expand() {
      throw new Error("bad token")
    },
  }
}

function sink() {
  const events: LogEvent[] = []
  return { events, diagnostics: createDiagnostics({ emit: (e: LogEvent) => events.push(e) }) }
}

const HOME = "/home/agent"

function stubExpander(calls?: PromptExpandContext[]) {
  const provider = upperStub(calls)
  return createPromptExpander({
    templateProvider: () => provider,
    sideband: () => NO_SIDEBAND,
    agentHome: () => HOME,
  })
}

describe("createPromptExpander", () => {
  it("renders static text with the engine and passes agentHome, the sideband API and the source", () => {
    const calls: PromptExpandContext[] = []
    const expand = stubExpander(calls)
    expect(expand("a %%tag%% b %%agentHome%%", { source: "s1" })).toBe(`a TAG b ${HOME}`)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.vars).toEqual({ agentHome: HOME })
    expect(calls[0]?.sideband).toBe(NO_SIDEBAND)
    expect(calls[0]?.source).toBe("s1")
    expect(calls[0]?.strict).toBeUndefined()
  })

  it("renders a PromptTemplateText with its vars and the strict flag", () => {
    const calls: PromptExpandContext[] = []
    const expand = stubExpander(calls)
    expect(expand({ template: "n=%%n%%", vars: { n: 3 } }, { vars: { n: 1 } })).toBe("n=3")
    expect(calls[0]?.strict).toBe(true)
    expect(calls[0]?.vars).toEqual({ agentHome: HOME, n: 3 })
  })

  it("with no template provider, fills only agentHome (the old core rule)", () => {
    const expand = createPromptExpander({
      templateProvider: () => undefined,
      agentHome: () => HOME,
    })
    expect(expand("%%agentHome%%/x %%tag%%")).toBe(`${HOME}/x %%tag%%`)
    // A PromptTemplateText gets the same rule: its other vars and its call
    // tokens are NOT rendered. A load must have the provider (it is a
    // required plugin; the loader sends `prompt.no_template_provider`).
    expect(expand({ template: "%%agentHome%% %%n%% %%sideband:tag x%%", vars: { n: 2 } })).toBe(
      `${HOME} %%n%% %%sideband:tag x%%`,
    )
    expect(DEFAULT_PROMPT_EXPANDER("plain text")).toBe("plain text")
  })

  it("fails open: the raw text goes out and one prompt.template_failed per source", () => {
    const { events, diagnostics } = sink()
    const provider = throwingStub()
    const expand = createPromptExpander({ templateProvider: () => provider, diagnostics })
    expect(expand("raw %%x%%", { source: "a" })).toBe("raw %%x%%")
    expect(expand("raw again", { source: "a" })).toBe("raw again")
    expect(expand({ template: "t" }, { source: "b" })).toBe("t")
    const failed = events.filter((e) => e.source === "prompt.template_failed")
    expect(failed).toHaveLength(2)
    expect(failed.map((e) => (e.structuredData as { source?: string }).source)).toEqual(["a", "b"])
  })

  it("expandPluginText: a string is data and a PromptTemplateText is rendered", () => {
    const expand = stubExpander()
    expect(expandPluginText("plain %%x%%", expand)).toBe("plain %%x%%")
    expect(expandPluginText({ template: "t %%x%%" }, expand)).toBe("t X")
    expect(expandPluginText(42, expand)).toBeUndefined()
    expect(isPromptTemplateText({ template: "a" })).toBe(true)
    expect(isPromptTemplateText({ text: "a" })).toBe(false)
  })
})

describe("call sites render static text and leave plugin strings unchanged", () => {
  afterEach(() => clearSystemPromptBase())

  it("S1 and S2: system prompt parts and identity are rendered", () => {
    const holder = createSystemPromptBaseHolder()
    registerSystemPromptBase(holder, "base", {
      slots: ["instructions"],
      identity: () => "I am %%who%%",
      instructionParts: () => [{ slot: "instructions", text: "home=%%agentHome%% %%tag%%" }],
    })
    holder.expand = stubExpander()
    expect(collectSystemPromptParts(holder, { agentHome: "/ctx" }).get("instructions")).toBe(
      "home=/ctx TAG",
    )
    expect(resolveBaseIdentity(holder, { authKind: "api-key", modelId: "m" })).toBe("I am WHO")
  })

  it("S1 and S2: with no expander on the holder, the text is unchanged", () => {
    const holder = createSystemPromptBaseHolder()
    registerSystemPromptBase(holder, "base", {
      slots: ["instructions"],
      identity: () => "I am %%who%%",
      instructionParts: () => [{ slot: "instructions", text: "%%tag%%" }],
    })
    expect(collectSystemPromptParts(holder, { agentHome: "/ctx" }).get("instructions")).toBe(
      "%%tag%%",
    )
    expect(resolveBaseIdentity(holder, { authKind: "api-key", modelId: "m" })).toBe("I am %%who%%")
  })

  it("S5: built-in tool description and param text are rendered, key order kept", () => {
    const providers = [
      {
        tools: ["Read"],
        tool: (name: string) =>
          name === "Read"
            ? { description: "Read %%x%%", params: { file_path: "p %%y%%" } }
            : undefined,
      },
    ]
    const plain = buildToolDefinitions(providers)
    const rendered = buildToolDefinitions(providers, stubExpander())
    const read = rendered.find((t) => t.name === "Read")
    expect(read?.description).toBe("Read X")
    const props = read?.input_schema.properties as Record<string, Record<string, unknown>>
    expect(props.file_path?.description).toBe("p Y")
    expect(Object.keys(props.file_path ?? {})[0]).toBe("description")
    const plainRead = plain.find((t) => t.name === "Read")
    expect(plainRead?.description).toBe("Read %%x%%")
    expect(JSON.stringify(rendered.map((t) => Object.keys(t)))).toBe(
      JSON.stringify(plain.map((t) => Object.keys(t))),
    )
  })

  it("S6: plugin tool description and schema descriptions are rendered, data keys are not", () => {
    const tool = {
      name: "T",
      description: "Use %%x%%",
      input_schema: {
        type: "object",
        description: "obj %%y%%",
        properties: {
          a: { type: "string", description: "a %%z%%", default: "%%keep%%" },
          b: { type: "array", items: { type: "string", description: "item %%w%%" } },
          c: { type: "string", enum: ["%%keep%%"] },
        },
      },
    }
    const expand = stubExpander()
    const def = pluginToolDefinitionFromTrigger(tool, expand)
    expect(def.description).toBe("Use X")
    const schema = def.input_schema as {
      description: string
      properties: Record<string, Record<string, unknown>>
    }
    expect(schema.description).toBe("obj Y")
    expect(schema.properties.a?.description).toBe("a Z")
    expect(schema.properties.a?.default).toBe("%%keep%%")
    const items = schema.properties.b?.items as { description: string } | undefined
    expect(items?.description).toBe("item W")
    expect(schema.properties.c?.enum).toEqual(["%%keep%%"])
    // Memoized per tool object and expander; the input is not mutated.
    expect(pluginToolDefinitionFromTrigger(tool, expand)).toBe(def)
    expect(tool.description).toBe("Use %%x%%")
    // No expander: the same text.
    expect(pluginToolDefinitionFromTrigger(tool).description).toBe("Use %%x%%")
  })

  it("expandSchemaDescriptions returns the same object when nothing changes", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } }
    expect(expandSchemaDescriptions(schema, (t) => t)).toBe(schema)
  })

  it("S7: a hook text is data; a template entry is rendered with its vars", () => {
    setSystemPromptBase({ entries: [], expand: stubExpander() })
    expect(getPromptExpander()).toBeDefined()
    const entries = [
      "plain %%x%%",
      { text: "obj %%x%%" },
      { text: "tpl %%x%% r=%%round%%", template: true as const, vars: { round: 2 } },
      { text: "before %%x%%", template: true as const, position: "before" as const },
    ]
    expect(placedHookContext(entries).map((p) => p.text)).toEqual([
      "plain %%x%%",
      "obj %%x%%",
      "tpl X r=2",
      "before X",
    ])
    const split = splitHookContextPlaced(entries)
    expect(split.before.map((p) => p.text)).toEqual(["before X"])
  })

  it("S8: a synthetic string is data; a PromptTemplateText is rendered with the facts as vars", () => {
    const { diagnostics } = sink()
    const expand = stubExpander()
    const resolver = createSyntheticTextResolver(
      [
        {
          kinds: ["continue.max_tokens", "assistant.placeholder"],
          text: (kind) =>
            kind === "continue.max_tokens"
              ? "plain %%x%%"
              : { template: "n=%%n%% %%x%%", vars: { x: "v" } },
        },
      ],
      diagnostics,
      () => NO_SIDEBAND,
      () => expand,
    )
    expect(resolver.resolve("continue.max_tokens", {})).toBe("plain %%x%%")
    expect(resolver.resolve("assistant.placeholder", { n: 5 })).toBe("n=5 v")
  })
})
