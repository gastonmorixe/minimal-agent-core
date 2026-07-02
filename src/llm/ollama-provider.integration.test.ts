/**
 * Host-level integration test for the discovered Ollama Cloud provider plugin.
 *
 * This drives the REAL composition path end to end with an injected transport
 * (no network): provider discovery → setup-context registration (the
 * `models:register` + `providers:register` seams) → model resolution →
 * `run()` validation + dispatch → the plugin's native NDJSON stream
 * translation. It proves the decoupled provider wires into the host through the
 * shared contexts alone, the same way the live agent boots it.
 *
 * It lives in `src/` (not `plugins/llm-ollama/`) on purpose: an integration
 * test that drives the host orchestrator must import `src/llm` + the discovery
 * loader, which a plugin-local test may not. The plugin's OWN unit tests
 * (`plugins/llm-ollama/ollama.test.ts`) stay free of any `src/` import.
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "@minimal-agent/plugin-api/llm/canonical-events"
import { userText } from "@minimal-agent/plugin-api/llm/canonical-messages"
import type { RunContext } from "@minimal-agent/plugin-api/llm/provider-auth"

import { resolveSiblingPluginRoots } from "../plugins/loader/helpers.ts"
import { siblingPluginPresent } from "../test-utils/sibling-repo.ts"

import type { CanonicalRequest } from "./canonical-request.ts"
import { clearModelRegistry, clearProviderRegistry, resolveModelForProvider } from "./index.ts"
import {
  activateDiscoveredProviders,
  buildProviderSetupContext,
  registerDiscoveredProviders,
} from "./provider-discovery.ts"
import { clearProviderPlugins } from "./provider-plugin.ts"
import { run } from "./run.ts"

// Wave G: the ollama provider migrated to the sibling ../minimal-agent-plugins
// repo. Discover from BOTH the embedded plugins dir and the sibling roots (the
// same resolution the bootstrap uses), so this integration test exercises the
// migrated provider.json from its new home.
const EMBEDDED_DIR = join(import.meta.dir, "../..")
const PLUGIN_ROOTS = [join(EMBEDDED_DIR, "plugins"), ...resolveSiblingPluginRoots(EMBEDDED_DIR)]

// The ollama provider now lives in the sibling ../minimal-agent-plugins repo.
// On a bare host checkout without that repo, discovery finds no ollama, so this
// integration test skips cleanly rather than failing. (Shared helper from
// src/test-utils/sibling-repo.ts.)
const HAVE_OLLAMA = siblingPluginPresent("ma-llm-ollama-plugin")

/** A canned Ollama `/api/chat` NDJSON response (thinking + content + usage). */
const OLLAMA_NDJSON = [
  {
    model: "deepseek-v4-flash",
    created_at: "t0",
    message: { role: "assistant", thinking: "reason" },
  },
  { model: "deepseek-v4-flash", message: { role: "assistant", content: "Hello" } },
  { model: "deepseek-v4-flash", message: { role: "assistant", content: " world" } },
  {
    model: "deepseek-v4-flash",
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 12,
    eval_count: 4,
  },
]
  .map((o) => JSON.stringify(o))
  .join("\n")

/** A NetworkClient stub that captures the request and replays canned NDJSON. */
function fakeNetworkClient(captured: { url?: string; body?: string; auth?: string }) {
  return {
    request(input: { url: string; body?: string | Uint8Array; headers?: Record<string, string> }) {
      captured.url = input.url
      captured.body = typeof input.body === "string" ? input.body : ""
      captured.auth = input.headers?.authorization
      const bytes = new TextEncoder().encode(OLLAMA_NDJSON)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        body,
        transport: { id: "fake" },
        text: () => Promise.resolve(""),
        json: () => Promise.resolve({}),
      })
    },
  }
}

async function collect(stream: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

describe.skipIf(!HAVE_OLLAMA)(
  "ollama provider integration (discovered plugin through host run())",
  () => {
    it("discovers + registers the plugin via the setup-context seams", async () => {
      clearModelRegistry()
      clearProviderRegistry()
      clearProviderPlugins()

      const ids = await registerDiscoveredProviders(PLUGIN_ROOTS)
      expect(ids).toContain("ollama")
      // Activate through the real ctx (models:register + providers:register).
      activateDiscoveredProviders(buildProviderSetupContext())

      // The model + adapter landed in the canonical registries via ctx alone.
      const model = resolveModelForProvider("deepseek-v4-flash", "ollama")
      expect(model.providerId).toBe("ollama")
      expect(model.surfaceId).toBe("custom")
      expect(model.capabilities.contextWindow).toBe(1_000_000)
      expect(model.capabilities.thinking.adaptive).toBe(true)

      clearProviderPlugins()
    })

    it("runs a request end-to-end: builds the native body, streams NDJSON back", async () => {
      clearModelRegistry()
      clearProviderRegistry()
      clearProviderPlugins()
      await registerDiscoveredProviders(PLUGIN_ROOTS)
      activateDiscoveredProviders(buildProviderSetupContext())

      const captured: { url?: string; body?: string; auth?: string } = {}
      const ctx: RunContext = {
        auth: { kind: "api-key", key: "ollama-test-key" },
        sessionId: "test-session",
        networkClient: fakeNetworkClient(captured),
      }

      const req: CanonicalRequest = {
        modelId: "deepseek-v4-flash",
        providerId: "ollama",
        messages: [userText("Hi")],
        thinking: { mode: "adaptive" },
        effort: "high",
      }

      const events = await collect(run(req, { context: ctx }))

      // Request reached the native Ollama endpoint with Bearer auth + native body.
      expect(captured.url).toBe("https://ollama.com/api/chat")
      expect(captured.auth).toBe("Bearer ollama-test-key")
      const body = JSON.parse(captured.body ?? "{}")
      expect(body.model).toBe("deepseek-v4-flash")
      expect(body.stream).toBe(true)
      // DeepSeek V4 advertises discrete reasoning levels, so an explicit
      // effort is forwarded on the native `think` field as the level string.
      expect(body.think).toBe("high")
      expect(body.messages).toEqual([{ role: "user", content: "Hi" }])

      // The NDJSON translated into canonical events: thinking → text → usage.
      const types = events.map((e) => e.type)
      expect(types[0]).toBe("message_start")
      expect(types).toContain("thinking_delta")
      expect(types).toContain("text_delta")
      expect(types.at(-1)).toBe("message_stop")

      const text = events
        .filter(
          (e): e is Extract<CanonicalEvent, { type: "text_delta" }> => e.type === "text_delta",
        )
        .map((e) => e.text)
        .join("")
      expect(text).toBe("Hello world")

      const delta = events.find((e) => e.type === "message_delta")
      expect(delta).toMatchObject({
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 4 },
      })

      clearProviderPlugins()
    })
  },
)
