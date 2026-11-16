/**
 * Text fixture providers for core tests.
 *
 * Core owns no model-facing text. The 3 real text plugins of the sibling
 * plugins repo own it: ma-turn-recovery-plugin and ma-core-tools-plugin
 * (synthetic kinds and built-in tool text), ma-base-prompt-plugin (identity
 * and the base system slots). A core test that checks today's English bytes
 * through the core path gets the text from these providers, never from a
 * core fallback.
 *
 * The providers are imported from the sibling checkout by a computed path at
 * module load (top-level await), so tsc does not walk into the plugins tree,
 * and a missing checkout does not break the import. Tests guard with
 * `describe.skipIf(!textFixturesPresent())`. The skip reason is printed once by
 * `sibling-repo.ts` (and `MA_REQUIRE_PLUGINS=1` makes it fail instead).
 *
 * @module test-utils/text-fixture-providers
 */

import { join } from "node:path"

import type { SyntheticTextProvider } from "../../plugin-api/src/types/synthetic-text.ts"
import type { ToolTextProvider } from "../../plugin-api/src/types/tool-text.ts"
import { createSyntheticTextResolver, type SyntheticTextResolver } from "../agent/synthetic-text.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { setSystemPromptBase } from "../llm/system-prompt-base-registry.ts"
import {
  createSystemPromptBaseHolder,
  registerSystemPromptBase,
  resolveBaseIdentity,
  type SystemPromptBaseHolder,
} from "../plugins/system-prompt-base.ts"
import type { SystemPromptBaseProvider } from "../plugins/types.ts"

import { SIBLING_REPO_ROOT, siblingPluginPresent } from "./sibling-repo.ts"

/** The 3 plugins whose text the fixtures use. */
const TEXT_PLUGINS = [
  "ma-turn-recovery-plugin",
  "ma-core-tools-plugin",
  "ma-base-prompt-plugin",
] as const

interface Factories {
  turnRecovery: () => SyntheticTextProvider
  coreToolsSynthetic: () => SyntheticTextProvider
  coreToolText: () => ToolTextProvider
  basePrompt: () => SystemPromptBaseProvider
}

async function loadFactories(): Promise<Factories | null> {
  if (!TEXT_PLUGINS.every((dir) => siblingPluginPresent(dir))) return null
  const at = (dir: string) => join(SIBLING_REPO_ROOT, dir, "provider.ts")
  const recovery = (await import(at("ma-turn-recovery-plugin"))) as {
    createTurnRecoveryProvider: () => SyntheticTextProvider
  }
  const tools = (await import(at("ma-core-tools-plugin"))) as {
    createCoreToolsSyntheticProvider: () => SyntheticTextProvider
    createCoreToolTextProvider: () => ToolTextProvider
  }
  const base = (await import(at("ma-base-prompt-plugin"))) as {
    default: () => SystemPromptBaseProvider
  }
  return {
    turnRecovery: recovery.createTurnRecoveryProvider,
    coreToolsSynthetic: tools.createCoreToolsSyntheticProvider,
    coreToolText: tools.createCoreToolTextProvider,
    basePrompt: base.default,
  }
}

const FACTORIES: Factories | null = await loadFactories()

/** True when the 3 text plugins are checked out. Guard with `describe.skipIf(!textFixturesPresent())`. */
export function textFixturesPresent(): boolean {
  return FACTORIES !== null
}

function factories(): Factories {
  if (FACTORIES === null) {
    throw new Error(
      `[text-fixture-providers] the text plugins (${TEXT_PLUGINS.join(", ")}) are missing in ${SIBLING_REPO_ROOT}. Guard the test with describe.skipIf(!textFixturesPresent()).`,
    )
  }
  return FACTORIES
}

/**
 * The synthetic text providers of the 2 real plugins (turn recovery and core
 * tools), new instances. Together they own every synthetic kind with a core
 * call site.
 */
export function fixtureSyntheticTextProviders(): SyntheticTextProvider[] {
  const f = factories()
  return [f.turnRecovery(), f.coreToolsSynthetic()]
}

/**
 * A synthetic text resolver over {@link fixtureSyntheticTextProviders}, with a
 * silent diagnostics sink. For tests that drive a tool executor directly
 * (pass it as the `text` of the tool exec context).
 */
export function fixtureSyntheticTextResolver(): SyntheticTextResolver {
  return createSyntheticTextResolver(
    fixtureSyntheticTextProviders(),
    createDiagnostics({ emit: () => {} }),
  )
}

/** The core-tools tool text provider (descriptions and params of the built-in tools). */
export function fixtureToolTextProviders(): ToolTextProvider[] {
  return [factories().coreToolText()]
}

/** A new base prompt holder with the real base prompt provider registered. */
export function fixtureSystemPromptBase(): SystemPromptBaseHolder {
  const holder = createSystemPromptBaseHolder()
  registerSystemPromptBase(holder, "ma-base-prompt-plugin", factories().basePrompt())
  return holder
}

/**
 * Store a new fixture base holder in the process-wide slot (the slot the
 * plugin loader fills in production) and return its release. For tests that
 * build the system prompt with no `systemPromptBase` option. Call it in
 * `beforeAll` and the release in `afterAll`. A no-op when the text plugins are
 * absent.
 */
export function installFixtureSystemPromptBase(): () => void {
  if (FACTORIES === null) return () => {}
  return setSystemPromptBase(fixtureSystemPromptBase())
}

/** The base identity text of the fixture provider (today's neutral identity). */
export function fixtureIdentity(authKind = "api-key", modelId = "test"): string {
  return resolveBaseIdentity(fixtureSystemPromptBase(), { authKind, modelId }) ?? ""
}

/** The 3 text deps, spread into `buildTestCore`, `buildAgentCore` or `resolveSystemPromptForModel` options. */
export interface TextFixtureDeps {
  syntheticTextProviders: SyntheticTextProvider[]
  toolTextProviders: ToolTextProvider[]
  systemPromptBase: SystemPromptBaseHolder
}

/** The 2 text deps of a core: `BuildAgentCoreDeps`, `TestCoreDeps` and `AgentCoreConfig` all take them. */
export type TextCoreDeps = Pick<TextFixtureDeps, "syntheticTextProviders" | "toolTextProviders">

/**
 * The synthetic and tool text providers, spread into `buildTestCore`,
 * `buildAgentCore` or `new AgentCore` options. Returns `{}` when the text
 * plugins are absent, so a describe that does not check text still runs on a
 * bare core. A describe that checks text must also be guarded with
 * `describe.skipIf(!textFixturesPresent())`.
 */
export function textCoreDeps(): Partial<TextCoreDeps> {
  if (FACTORIES === null) return {}
  return {
    syntheticTextProviders: fixtureSyntheticTextProviders(),
    toolTextProviders: fixtureToolTextProviders(),
  }
}

/**
 * All text deps at once. `syntheticTextProviders` and `toolTextProviders` are
 * `BuildAgentCoreDeps` options. `systemPromptBase` is a
 * `resolveSystemPromptForModel` option; `buildAgentCore` takes the base
 * holder through the loader's `systemPromptBase()` instead, so spread
 * {@link textCoreDeps} there. Throws when the text plugins are absent.
 */
export function textFixtureDeps(): TextFixtureDeps {
  return {
    syntheticTextProviders: fixtureSyntheticTextProviders(),
    toolTextProviders: fixtureToolTextProviders(),
    systemPromptBase: fixtureSystemPromptBase(),
  }
}
