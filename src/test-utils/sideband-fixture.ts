/**
 * Sideband fixture for core tests (design section 2a).
 *
 * Core holds no wire form. A core test that must see the bytes of a sideband
 * tag gets them from the real codec of the sibling plugins checkout
 * (`ma-sideband-plugin`), with the kinds that the sibling manifests declare.
 * The pattern is the one of `text-fixture-providers.ts`: the codec module is
 * imported by a computed path at module load, so tsc does not walk into the
 * plugins tree, and a missing checkout does not break the import. Guard a
 * test with `describe.skipIf(!sidebandFixturePresent())`.
 *
 * @module test-utils/sideband-fixture
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { PluginLoaderOptions } from "../plugins/loader.ts"
import { createSidebandApi, NO_SIDEBAND } from "../sideband/api.ts"
import { createSidebandRegistry } from "../sideband/registry.ts"
import type {
  SidebandApi,
  SidebandCodecFactory,
  SidebandKind,
  SidebandRegistry,
} from "../sideband/types.ts"

import { SIBLING_REPO_ROOT, siblingPluginPresent } from "./sibling-repo.ts"

const CODEC_PLUGIN = "ma-sideband-plugin"
/** The contract that lets a required plugin declare core kinds (design D1 a). */
const CORE_KINDS_CONTRACT = "sideband.kinds.core"

async function loadCodecFactory(): Promise<SidebandCodecFactory | null> {
  if (!siblingPluginPresent(CODEC_PLUGIN)) return null
  const at = join(SIBLING_REPO_ROOT, CODEC_PLUGIN, "lib", "codec.ts")
  if (!existsSync(at)) return null
  const mod = (await import(at)) as { default: SidebandCodecFactory }
  return mod.default
}

const FACTORY: SidebandCodecFactory | null = await loadCodecFactory()

if (FACTORY === null) {
  console.warn(
    `[sideband-fixture] SKIP the sideband byte tests: ${CODEC_PLUGIN} is missing in ${SIBLING_REPO_ROOT}.`,
  )
}

/** True when the real codec is checked out. */
export function sidebandFixturePresent(): boolean {
  return FACTORY !== null
}

/** A manifest with the fields that the fixture reads. */
interface FixtureManifest {
  id?: string
  required?: boolean
  provides?: string[]
  sideband?: Omit<SidebandKind, "owner">[]
}

/** Each sibling plugin manifest with a `sideband` array, by plugin id. */
function siblingManifests(): FixtureManifest[] {
  const out: FixtureManifest[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(SIBLING_REPO_ROOT).sort()
  } catch {
    return out
  }
  for (const dir of dirs) {
    const path = join(SIBLING_REPO_ROOT, dir, "manifest.json")
    if (!existsSync(path)) continue
    try {
      const m = JSON.parse(readFileSync(path, "utf8")) as FixtureManifest
      if (typeof m.id === "string" && Array.isArray(m.sideband)) out.push(m)
    } catch {
      // A bad manifest is not a sideband fixture.
    }
  }
  return out
}

/** Options of {@link fixtureSidebandRegistry}. */
export interface SidebandFixtureOptions {
  /** More kinds to register, as `[kind, ownerPluginId]`. */
  extraKinds?: readonly (readonly [SidebandKind, string])[]
  /** False: do not register the kinds of the sibling manifests. Default true. */
  siblingKinds?: boolean
}

/**
 * A frozen registry with the real codec and the kinds of the sibling
 * manifests. A kind that the registry rejects is skipped. Throws when the
 * codec is missing: guard with {@link sidebandFixturePresent}.
 */
export function fixtureSidebandRegistry(opts: SidebandFixtureOptions = {}): SidebandRegistry {
  if (FACTORY === null) {
    throw new Error(
      `[sideband-fixture] ${CODEC_PLUGIN} is missing in ${SIBLING_REPO_ROOT}. Guard the test with describe.skipIf(!sidebandFixturePresent()).`,
    )
  }
  const manifests = opts.siblingKinds === false ? [] : siblingManifests()
  const owners = new Set(
    manifests
      .filter((m) => m.required === true && (m.provides ?? []).includes(CORE_KINDS_CONTRACT))
      .map((m) => m.id ?? ""),
  )
  const registry = createSidebandRegistry({ coreKindOwners: owners })
  for (const m of manifests) {
    for (const k of m.sideband ?? []) {
      try {
        registry.register({ ...k, owner: "" }, m.id ?? "")
      } catch {
        // The registry rule decides. A rejected kind is not in the fixture.
      }
    }
  }
  for (const [k, owner] of opts.extraKinds ?? []) registry.register(k, owner)
  registry.setCodec(FACTORY, CODEC_PLUGIN)
  registry.freeze()
  return registry
}

/** The `SidebandApi` over {@link fixtureSidebandRegistry}. */
export function fixtureSideband(opts: SidebandFixtureOptions = {}): SidebandApi {
  return createSidebandApi(fixtureSidebandRegistry(opts))
}

/**
 * The fixture API when the real codec is checked out, else `NO_SIDEBAND`.
 * For a test file that builds its API at module load: guard each test that
 * pins bytes with `describe.skipIf(!sidebandFixturePresent())`.
 */
export function fixtureSidebandOrNone(opts: SidebandFixtureOptions = {}): SidebandApi {
  return FACTORY === null ? NO_SIDEBAND : fixtureSideband(opts)
}

/** The system role kinds (design step 7): one for each `PromptRole`. */
const SYSTEM_ROLE_KINDS = ["behavior", "context", "emit", "mode", "tool"] as const

/** Id of the package that {@link sidebandCodecPluginRoot} writes. */
export const SIDEBAND_FIXTURE_PLUGIN_ID = "zz-sideband-fixture"

/** The embedded root of the fixture package (one for each process). */
const FIXTURE_ROOT = join(import.meta.dirname, "..", "..", "tmp", `sideband-fixture-${process.pid}`)

let fixtureRootWritten = false

/**
 * The embedded plugin root of a test package that gives a loader the real
 * codec and the system role kinds (`behavior`, `context`, `emit`, `mode`,
 * `tool`, from the sibling manifests), so `getPromptBlock` renders the
 * `<ma::sys::ROLE>` sections (design step 7). The package has no prompt and
 * no tool. Written one time. `null` when the codec checkout is missing.
 */
export function sidebandCodecPluginRoot(): string | null {
  if (FACTORY === null) return null
  if (fixtureRootWritten && existsSync(join(FIXTURE_ROOT, SIDEBAND_FIXTURE_PLUGIN_ID))) {
    return FIXTURE_ROOT
  }
  const roles = new Set<string>(SYSTEM_ROLE_KINDS)
  const kinds = siblingManifests()
    .flatMap((m) => m.sideband ?? [])
    .filter((k) => roles.has(k.kind))
  const dir = join(FIXTURE_ROOT, SIDEBAND_FIXTURE_PLUGIN_ID)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    id: SIDEBAND_FIXTURE_PLUGIN_ID,
    name: "Sideband fixture",
    version: "0.1.0",
    description: "test",
    sidebandCodec: { id: "xml-ma-v1", entry: "./codec.ts" },
    sideband: kinds,
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
  const codec = join(SIBLING_REPO_ROOT, CODEC_PLUGIN, "lib", "codec.ts")
  writeFileSync(join(dir, "codec.ts"), `export { default } from ${JSON.stringify(codec)}\n`)
  fixtureRootWritten = true
  return FIXTURE_ROOT
}

/**
 * `opts` with the fixture codec root ({@link sidebandCodecPluginRoot}) added
 * to `roots.embedded`, for a `PluginLoader.load` whose prompt block a test
 * reads. No change when the codec checkout is missing.
 */
export function withSidebandCodec(opts: PluginLoaderOptions): PluginLoaderOptions {
  const root = sidebandCodecPluginRoot()
  if (root === null) return opts
  const roots = opts.roots ?? {}
  return { ...opts, roots: { ...roots, embedded: [...(roots.embedded ?? []), root] } }
}
