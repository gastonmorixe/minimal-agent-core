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
 * `describe.skipIf(!textFixturesPresent())`. When the text plugins are missing,
 * this module prints one warning at load and the guarded tests skip. With
 * `MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES=1`, or `CI` set, it throws at load
 * instead, so every test file that imports it fails with a clear message
 * that names the trigger (see `text-fixtures-required.ts`).
 * (`MA_REQUIRE_PLUGINS=1` in `sibling-repo.ts` also fails, for any plugin.)
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
  createPromptExpander,
  DEFAULT_PROMPT_EXPANDER,
  type PromptExpander,
} from "../plugins/prompt-expand.ts"
import {
  createSystemPromptBaseHolder,
  registerSystemPromptBase,
  resolveBaseIdentity,
  type SystemPromptBaseHolder,
} from "../plugins/system-prompt-base.ts"
import type { PromptTemplateProvider, SystemPromptBaseProvider } from "../plugins/types.ts"
import type { SidebandApi } from "../sideband/types.ts"

import { SIBLING_REPO_ROOT, siblingPluginPresent } from "./sibling-repo.ts"
import { fixtureSidebandOrNone } from "./sideband-fixture.ts"
import { textFixturesTrigger } from "./text-fixtures-required.ts"

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
  /** The real `prompts.template` provider, or undefined when its package is absent. */
  promptTemplate: (() => PromptTemplateProvider) | undefined
}

/** The template engine plugin. Optional: without it, the fixtures use the core default expander. */
const TEMPLATE_PLUGIN = "ma-prompt-template-plugin"

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
  const template = siblingPluginPresent(TEMPLATE_PLUGIN)
    ? ((await import(at(TEMPLATE_PLUGIN))) as { default: () => PromptTemplateProvider })
    : undefined
  return {
    turnRecovery: recovery.createTurnRecoveryProvider,
    coreToolsSynthetic: tools.createCoreToolsSyntheticProvider,
    coreToolText: tools.createCoreToolTextProvider,
    basePrompt: base.default,
    promptTemplate: template?.default,
  }
}

export { textFixturesRequired, textFixturesTrigger } from "./text-fixtures-required.ts"

const FACTORIES: Factories | null = await loadFactories()

if (FACTORIES === null) {
  const missing = TEXT_PLUGINS.filter((dir) => !siblingPluginPresent(dir))
  const reason =
    `the text plugins (${missing.join(", ")}) are missing in ${SIBLING_REPO_ROOT}.` +
    " Set MA_PLUGINS_DIR, or clone minimal-agent-plugins next to this repo."
  const trigger = textFixturesTrigger()
  if (trigger !== null) {
    // Thrown at module load: every test file that imports this helper fails.
    throw new Error(`[text-fixture-providers] FAIL: ${trigger} is set, and ${reason}`)
  }
  console.warn(
    `[text-fixture-providers] WARNING: SKIP the text tests: ${reason} Set MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES=1 to make this a failure.`,
  )
}

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
 *
 * Each provider gets the real codec (`fixtureSidebandOrNone`) as the third
 * argument of `text`, as the loader gives its API in production: the
 * providers render their tags with it (plugins step 10).
 */
export function fixtureSyntheticTextResolver(): SyntheticTextResolver {
  const sb = fixtureSidebandOrNone()
  return createSyntheticTextResolver(
    fixtureSyntheticTextProviders(),
    createDiagnostics({ emit: () => {} }),
    () => sb,
  )
}

/** The core-tools tool text provider (descriptions and params of the built-in tools). */
export function fixtureToolTextProviders(): ToolTextProvider[] {
  return [factories().coreToolText()]
}

/**
 * The prompt expander of the fixtures (design 50 §6): the real template
 * engine (when its package is checked out) with the fixture codec
 * (`fixtureSidebandOrNone`), as the loader builds it in production. Without
 * the engine package: the core default (no provider).
 */
export function fixturePromptExpander(): PromptExpander {
  const make = FACTORIES?.promptTemplate
  if (make === undefined) return DEFAULT_PROMPT_EXPANDER
  const provider = make()
  const sb = fixtureSidebandOrNone()
  return createPromptExpander({ templateProvider: () => provider, sideband: () => sb })
}

/**
 * A new base prompt holder with the real base prompt provider registered,
 * and the fixture prompt expander ({@link fixturePromptExpander}), so S1 and
 * S2 render as in production.
 */
export function fixtureSystemPromptBase(): SystemPromptBaseHolder {
  const holder = createSystemPromptBaseHolder()
  registerSystemPromptBase(holder, "ma-base-prompt-plugin", factories().basePrompt())
  holder.expand = fixturePromptExpander()
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

/**
 * The text deps of a core: `BuildAgentCoreDeps`, `TestCoreDeps` and
 * `AgentCoreConfig` all take them. `sideband` is the session API that the
 * core gives to each synthetic text provider (the codec of the tags).
 */
export type TextCoreDeps = Pick<TextFixtureDeps, "syntheticTextProviders" | "toolTextProviders"> & {
  sideband: SidebandApi
}

/**
 * The synthetic and tool text providers and the sideband API, spread into
 * `buildTestCore`, `buildAgentCore` or `new AgentCore` options. The API is
 * the real codec (`fixtureSidebandOrNone`), as the loader gives it in
 * production, so the providers render their tags. Returns `{}` when the text
 * plugins are absent, so a describe that does not check text still runs on a
 * bare core. A describe that checks text must also be guarded with
 * `describe.skipIf(!textFixturesPresent())`. A test that gives its own
 * `sideband` puts it after the spread.
 */
export function textCoreDeps(): Partial<TextCoreDeps> {
  if (FACTORIES === null) return {}
  return {
    syntheticTextProviders: fixtureSyntheticTextProviders(),
    toolTextProviders: fixtureToolTextProviders(),
    sideband: fixtureSidebandOrNone(),
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
