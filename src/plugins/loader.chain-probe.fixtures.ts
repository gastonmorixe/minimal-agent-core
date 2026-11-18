/**
 * Test fixture: the `chain-probe` plugin (spec v6.1 M0, T5). It has one
 * tool-result stage per phase. Each stage writes its phase to
 * `globalThis.__chainProbeLog`. The stamp stage sets the kind `probe-mark`,
 * which the manifest registers as a sideband kind. The tool `ProbeTool`
 * returns `"probe ok"`.
 *
 * The static package is at `chain-probe-fixture/chain-probe/` (next to this
 * file), so a host test (the CLI) can load it directly with
 * `PluginLoader.load({ roots: { embedded: [CHAIN_PROBE_PLUGINS_DIR] } })`.
 * {@link writeChainProbe} writes the same package (or a variant) to a temp
 * dir. Not a test file itself.
 *
 * @module plugins/loader.chain-probe.fixtures
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

/** The plugins dir that holds the static `chain-probe` package. */
export const CHAIN_PROBE_PLUGINS_DIR = resolve(__dirname, "chain-probe-fixture")
/** The package dir of the static `chain-probe` package. */
export const CHAIN_PROBE_PACKAGE_DIR = join(CHAIN_PROBE_PLUGINS_DIR, "chain-probe")
/** All phases, in run order. */
export const CHAIN_PROBE_PHASES = ["clamp", "pre-outcome", "post-blob", "final", "stamp"] as const
/** The sideband kind that the stamp stage sets. */
export const CHAIN_PROBE_KIND = "probe-mark"
/** The tool name of the fixture. */
export const CHAIN_PROBE_TOOL = "ProbeTool"
/** The tool result text of the fixture. */
export const CHAIN_PROBE_CONTENT = "probe ok"

/** The phase log that the stages write to. */
export function chainProbeLog(): string[] {
  const g = globalThis as unknown as { __chainProbeLog?: string[] }
  g.__chainProbeLog ??= []
  return g.__chainProbeLog
}

/** Clear the phase log. */
export function resetChainProbeLog(): void {
  ;(globalThis as unknown as { __chainProbeLog?: string[] }).__chainProbeLog = []
}

/** Options for {@link writeChainProbe}. */
export interface ChainProbeOptions {
  /** Plugin id. Default `chain-probe`. Also the log prefix when not the default. */
  id?: string
  /** Tool name. Default {@link CHAIN_PROBE_TOOL}. */
  toolName?: string
  /** Phases with one stage each. Default all five. */
  phases?: readonly string[]
  /** Kind that the stamp stage sets. Default {@link CHAIN_PROBE_KIND}. */
  stampKind?: string
  /** Manifest `sideband` kinds. Default one kind {@link CHAIN_PROBE_KIND}. */
  sidebandKinds?: readonly unknown[]
  /** Manifest `toolResultTransforms.timeoutMs`. Absent by default. */
  timeoutMs?: unknown
  /** Replace the transforms module text (for a broken entry). */
  transformsSource?: string
  /** Manifest `toolResultTransforms.entry`. Default `./transforms.ts`. */
  entry?: string
  /** Set `false` to not write the entry module. Default `true`. */
  writeEntry?: boolean
  /** Set to add a `sidebandCodec` entry with this module text. */
  codecSource?: string
}

/** The sideband kind declaration of the fixture. */
export function chainProbeKind(kind: string = CHAIN_PROBE_KIND): Record<string, unknown> {
  return {
    kind,
    direction: "to-model",
    placement: "tool-result",
    attrs: {},
    body: "text",
    trust: "harness",
    summary: "probe mark",
  }
}

/** The text of the transforms module: one identity stage per phase, the stamp sets `stampKind`. */
export function chainProbeTransformsSource(
  phases: readonly string[] = CHAIN_PROBE_PHASES,
  stampKind: string = CHAIN_PROBE_KIND,
  tag = "",
): string {
  return `const log = (): string[] => {
  const g = globalThis as unknown as { __chainProbeLog?: string[] }
  g.__chainProbeLog ??= []
  return g.__chainProbeLog
}
const stage = (phase: string) => ({
  phase,
  order: 0,
  transform: <S extends { kind?: string }>(s: S): S => {
    log().push(${tag === "" ? "phase" : `${JSON.stringify(tag)} + phase`})
    return phase === "stamp" ? { ...s, kind: ${JSON.stringify(stampKind)} } : s
  },
})
export default ${JSON.stringify(phases)}.map(stage)
`
}

/** The text of the tool handler module. */
export const CHAIN_PROBE_HANDLER = `export default async () => ({ kind: "tool_result", content: "${CHAIN_PROBE_CONTENT}" })\n`

/** The split (S31) manifest of the fixture. */
export function chainProbeManifest(opts: ChainProbeOptions = {}): Record<string, unknown> {
  const id = opts.id ?? "chain-probe"
  const trt: Record<string, unknown> = { id: "probe", entry: opts.entry ?? "./transforms.ts" }
  if ("timeoutMs" in opts) trt.timeoutMs = opts.timeoutMs
  return {
    id,
    name: id,
    version: "0.1.0",
    description: "test",
    toolResultTransforms: trt,
    sideband: opts.sidebandKinds ?? [chainProbeKind()],
    ...(opts.codecSource !== undefined
      ? { sidebandCodec: { id: "probe-codec", entry: "./codec.ts" } }
      : {}),
    headless: {
      tools: [
        {
          id: "only",
          trigger: {
            type: "tool",
            tool: {
              name: opts.toolName ?? CHAIN_PROBE_TOOL,
              description: "d",
              input_schema: { type: "object", properties: {} },
              explicitName: true,
            },
          },
          handler: { type: "module", path: "./h.ts", export: "default" },
          interactive: false,
        },
      ],
    },
  }
}

/**
 * Write the `chain-probe` package (or a variant) to `<pluginsDir>/<id>`.
 * Load it with `roots: { embedded: [pluginsDir] }`.
 *
 * @returns The package dir.
 */
export function writeChainProbe(pluginsDir: string, opts: ChainProbeOptions = {}): string {
  const id = opts.id ?? "chain-probe"
  const dir = join(pluginsDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(chainProbeManifest(opts), null, 2))
  writeFileSync(join(dir, "h.ts"), CHAIN_PROBE_HANDLER)
  const tag = id === "chain-probe" ? "" : `${id}:`
  // Bun caches a module by path: a test that changes the module text must
  // use a new `entry`. A missing-module test sets `writeEntry: false`.
  if (opts.writeEntry === false) return dir
  writeFileSync(
    join(dir, opts.entry ?? "transforms.ts"),
    opts.transformsSource ?? chainProbeTransformsSource(opts.phases, opts.stampKind, tag),
  )
  if (opts.codecSource !== undefined) writeFileSync(join(dir, "codec.ts"), opts.codecSource)
  return dir
}
