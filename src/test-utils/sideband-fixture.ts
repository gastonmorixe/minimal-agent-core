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

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { createSidebandApi } from "../sideband/api.ts"
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
