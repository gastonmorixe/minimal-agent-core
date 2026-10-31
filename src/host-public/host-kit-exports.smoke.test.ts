/**
 * Smoke test for the S34 exports-gap `./host-kit/*` + `./testing/*` cluster
 * (Y4's share: the 8 sdk-adapters + build-agent-core, PluginLoader,
 * CommandRegistry, ModeManager + AutoAskController, Hooks, PluginStream,
 * SessionStore, BlobStore, FileTrackingStore, ToolFeedbackTracker,
 * auto-plugins, test-core, provider-fixture).
 *
 * Imports each new subpath by package name — the way an external consumer
 * installing core from git would, never a relative `src/...` path — and
 * asserts the symbols the brief named actually resolve through the package
 * `exports` map. Deeper behavior of each real module is already covered by
 * that module's own test file; this only confirms importability. The 5
 * engine PORT folds get their own correctness tests next to
 * `build-agent-core.ts` (not here).
 *
 * @module host-public/host-kit-exports.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { AutoAskController } from "@minimal-agent/core/host-kit/auto-ask"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { bootstrapUserPlugins, buildCloneArgs } from "@minimal-agent/core/host-kit/auto-plugins"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { BlobStore, loadBlobStoreConfig } from "@minimal-agent/core/host-kit/blob-store"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  buildAgentCore,
  openAgentCoreSession,
  toEffort,
} from "@minimal-agent/core/host-kit/build-agent-core"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  CommandRegistry,
  looksLikeCommand,
  parseCommandLine,
} from "@minimal-agent/core/host-kit/command-registry"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  DEFAULT_STREAK_THRESHOLD,
  ToolFeedbackTracker,
} from "@minimal-agent/core/host-kit/feedback-tracker"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { FileTrackingStore, isSafeSid } from "@minimal-agent/core/host-kit/file-tracking-store"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { Hooks } from "@minimal-agent/core/host-kit/hooks"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  createLifecyclePort,
  LifecyclePortAdapter,
} from "@minimal-agent/core/host-kit/lifecycle-port-adapter"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { MediaResolverAdapter } from "@minimal-agent/core/host-kit/media-resolver-adapter"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { ModeProviderAdapter } from "@minimal-agent/core/host-kit/mode-provider-adapter"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { ModeManager } from "@minimal-agent/core/host-kit/modes"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { PluginStream } from "@minimal-agent/core/host-kit/plugin-stream"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { PromptContributorAdapter } from "@minimal-agent/core/host-kit/prompt-contributor-adapter"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { SessionPersistenceAdapter } from "@minimal-agent/core/host-kit/session-persistence-adapter"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { SessionStore, shortHash } from "@minimal-agent/core/host-kit/session-store"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { ToolExecutorAdapter } from "@minimal-agent/core/host-kit/tool-executor-adapter"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { ToolRegistryAdapter } from "@minimal-agent/core/host-kit/tool-registry-adapter"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { registerTestProvider, testProviderUrl } from "@minimal-agent/core/testing/provider-fixture"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { buildTestCore, TEST_CORE_MODEL } from "@minimal-agent/core/testing/test-core"

describe("host-kit/* + testing/* exports (S34 Y4 cluster): every subpath resolves", () => {
  it("./host-kit/build-agent-core", () => {
    expect(typeof buildAgentCore).toBe("function")
    expect(typeof openAgentCoreSession).toBe("function")
    expect(toEffort("high")).toBe("high")
    expect(toEffort("not-a-real-effort")).toBeUndefined()
  })

  it("./host-kit/lifecycle-port-adapter", () => {
    expect(typeof LifecyclePortAdapter).toBe("function")
    expect(typeof createLifecyclePort).toBe("function")
    expect(createLifecyclePort(null)).toBeDefined()
  })

  it("./host-kit/media-resolver-adapter", () => {
    expect(typeof MediaResolverAdapter).toBe("function")
  })

  it("./host-kit/mode-provider-adapter", () => {
    expect(typeof ModeProviderAdapter).toBe("function")
  })

  it("./host-kit/prompt-contributor-adapter", () => {
    expect(typeof PromptContributorAdapter).toBe("function")
    expect(typeof PromptContributorAdapter.create).toBe("function")
  })

  it("./host-kit/session-persistence-adapter", () => {
    expect(typeof SessionPersistenceAdapter).toBe("function")
  })

  it("./host-kit/tool-executor-adapter", () => {
    expect(typeof ToolExecutorAdapter).toBe("function")
  })

  it("./host-kit/tool-registry-adapter", () => {
    expect(typeof ToolRegistryAdapter).toBe("function")
  })

  it("./host-kit/plugin-loader", () => {
    expect(typeof PluginLoader).toBe("function")
    expect(typeof PluginLoader.load).toBe("function")
  })

  it("./host-kit/command-registry (plus the folded slash-command parser)", () => {
    expect(typeof CommandRegistry).toBe("function")
    expect(parseCommandLine("/loop 5m")).toEqual({ name: "loop", argv: "5m" })
    expect(parseCommandLine("not a command")).toBeNull()
    expect(looksLikeCommand("/loop")).toBe(true)
    expect(looksLikeCommand("hello")).toBe(false)
  })

  it("./host-kit/modes", () => {
    expect(typeof ModeManager).toBe("function")
  })

  it("./host-kit/auto-ask", () => {
    expect(typeof AutoAskController).toBe("function")
  })

  it("./host-kit/hooks", () => {
    expect(typeof Hooks).toBe("function")
  })

  it("./host-kit/plugin-stream", () => {
    expect(typeof PluginStream).toBe("function")
  })

  it("./host-kit/session-store", () => {
    expect(typeof SessionStore).toBe("function")
    expect(typeof SessionStore.open).toBe("function")
    expect(shortHash("x")).toBe(shortHash("x"))
    expect(shortHash("x")).not.toBe(shortHash("y"))
  })

  it("./host-kit/blob-store", () => {
    expect(typeof BlobStore).toBe("function")
    expect(typeof loadBlobStoreConfig().config.enabled).toBe("boolean")
  })

  it("./host-kit/file-tracking-store", () => {
    expect(typeof FileTrackingStore).toBe("function")
    expect(isSafeSid("abc-123")).toBe(true)
    expect(isSafeSid("../escape")).toBe(false)
  })

  it("./host-kit/feedback-tracker", () => {
    expect(typeof ToolFeedbackTracker).toBe("function")
    expect(DEFAULT_STREAK_THRESHOLD).toBeGreaterThan(0)
  })

  it("./host-kit/auto-plugins", () => {
    expect(typeof bootstrapUserPlugins).toBe("function")
    expect(buildCloneArgs("https://example.com/repo.git", "/tmp/dest", false)).toContain(
      "https://example.com/repo.git",
    )
  })

  it("./testing/test-core", () => {
    expect(typeof buildTestCore).toBe("function")
    expect(typeof TEST_CORE_MODEL).toBe("string")
  })

  it("./testing/provider-fixture", () => {
    expect(typeof registerTestProvider).toBe("function")
    expect(testProviderUrl("my-test-prov")).toContain("my-test-prov")
  })
})
