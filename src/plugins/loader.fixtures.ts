/**
 * Shared test fixtures for the `PluginLoader` test files
 * (`loader.test.ts`, `loader.context.test.ts`, `loader.prompt.test.ts`).
 * Not a test file itself.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import type { ManifestFile } from "./types.ts"

/** Root scratch dir shared by the loader test files. */
export const ROOT = resolve(__dirname, "../../tmp/loader-tests")
/** Fake home dir under {@link ROOT}. */
export const HOME = join(ROOT, "home")
/** Fake project dir under {@link ROOT}. */
export const PROJECT = join(ROOT, "project")

/** Write a plugin package (manifest + files) under `<root>/<sub>/<id>`. */
export function writePackage(
  root: string,
  id: string,
  manifest: unknown,
  files: Record<string, string> = {},
  sub: string = "plugins",
) {
  const dir = join(root, sub, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

/** Manifest with a single tool-trigger TUI pointing at `handlerPath`. */
export function toolManifest(id: string, toolName: string, handlerPath: string): ManifestFile {
  return {
    id,
    name: id,
    version: "0.1.0",
    description: "test",
    tuis: [
      {
        id: "only",
        trigger: {
          type: "tool",
          tool: {
            name: toolName,
            description: `Tool ${toolName}`,
            input_schema: { type: "object", properties: {} },
            explicitName: true,
          },
        },
        handler: { type: "module", path: handlerPath, export: "default" },
        interactive: false,
      },
    ],
  }
}

/** Manifest with a single inline-tag-trigger TUI pointing at `handlerPath`. */
export function inlineManifest(id: string, tag: string, handlerPath: string): ManifestFile {
  return {
    id,
    name: id,
    version: "0.1.0",
    description: "test",
    tuis: [
      {
        id: "only",
        trigger: { type: "inline_tag", tag },
        handler: { type: "module", path: handlerPath, export: "default" },
        interactive: false,
      },
    ],
  }
}

/** Tool handler module body echoing the dispatch input. */
export const TOOL_HANDLER_BODY = `
export default async function handler(ctx) {
  return {
    kind: "tool_result",
    content: "ok: " + JSON.stringify(ctx.trigger.input ?? {}),
  };
}
`

/** Inline-tag handler module body echoing the trigger name + body. */
export const INLINE_HANDLER_BODY = `
export default async function handler(ctx) {
  return {
    kind: "rendered",
    ansi: "[rendered:" + ctx.trigger.name + ":" + ctx.trigger.body + "]",
  };
}
`

/** Canned PROMPT.md body for plugin A. */
export const PROMPT_BODY_A = "Use tool_a when the user asks for thing A."

/** Core tool names passed as `coreToolNames` in loads. */
export const CORE_TOOLS = new Set(["Bash", "Read", "Write"])
